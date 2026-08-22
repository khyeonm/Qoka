/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolDefinition, textResult, errorResult } from './types';
import { services } from '../../common/services';
import { resolveRunTarget } from '../../runtime/builtinServer';
import { windowsToWsl, builtInLabel } from '../../common/dockerEnv';
import { workspaceFolderPath, copyRemoteDirToLocal, listLocalFiles, uniqueRunName, isMountedRepo } from '../../common/workspaceSync';
import { humanSize } from '../../common/workspaceSync';
import { workspacePathsFor } from '../../common/types';
import { openResultsInEditor, describeOpenedResults } from '../../common/openResults';

/**
 * qoka-run MCP: run a short, self-contained script on the Qoka local run environment
 * (the SAME WSL distro / VM autopipe uses - shared via VMManager) for quick,
 * one-off tasks. Distinct from autopipe, which builds reproducible multi-step
 * pipelines.
 *
 * Results land in the project's `results/<run-name>/` folder (the script in `analysis/<run-name>/`), whichever
 * target ran them. On Windows the local run environment is WSL, so the run dir IS the
 * project's analysis dir seen through the /mnt mount - the code writes straight
 * to local disk, no copy. Everywhere else (Mac/Linux local VM, and ANY remote
 * SSH server) the run dir lives on the server and is SFTP-copied back into
 * results/<run-name>/ before this tool returns, so the AI never has to read the
 * files over SSH and re-write them locally by hand.
 */

type Lang = 'bash' | 'python' | 'node';

// How each language is executed on the local run environment. Python ALWAYS runs via
// `uv run` so third-party packages (scanpy, numpy, …) resolve automatically from
// the script's inline dependency metadata. `--no-project` keeps uv from adopting
// a pyproject.toml that happens to sit above the analysis dir - the run stays a
// self-contained script. (uv keeps its venv/cache in the user's ext4 home, so
// running from the /mnt-mounted analysis dir doesn't pay the drvfs I/O penalty.)
const LANGS: Record<Lang, { file: string; run: (f: string) => string }> = {
	bash: { file: 'main.sh', run: f => `bash '${f}'` },
	python: { file: 'main.py', run: f => `uv run --no-project '${f}'` },
	node: { file: 'main.js', run: f => `node '${f}'` },
};

// Ensure uv exists (self-healing fallback to the WSL provisioner's install):
// if missing, install it to the user's ~/.local/bin - no root needed. Runs only
// for python and short-circuits instantly when uv is already present.
const ENSURE_UV = 'command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$HOME/.local/bin" UV_NO_MODIFY_PATH=1 sh';

/**
 * Prepend PEP 723 inline script metadata declaring `deps` so `uv run` installs
 * them. No-op when the code already carries its own `# /// script` block (the AI
 * may write one directly) or when there are no deps.
 */
function injectPep723(code: string, deps: string[]): string {
	if (!deps.length || /^\s*#\s*\/\/\/\s*script/m.test(code)) { return code; }
	const arr = deps.map(d => `"${d.replace(/["\\]/g, '')}"`).join(', ');
	return ['# /// script', `# dependencies = [${arr}]`, '# ///', '', code].join('\n');
}

// Markers delimiting the metadata the run script appends after the user's stdout,
// so one connection can report both the output and where it actually ran.
const META_MARK = '<<<QOKA-RUN-META>>>';
const FILES_MARK = '<<<QOKA-RUN-FILES>>>';

/** Largest single result file copied back WITHOUT asking. Anything bigger is
 *  reported so the assistant can ASK the user whether to download it, rather
 *  than pulling a multi-GB output onto their laptop unasked. */
const MAX_COPY_BYTES = 20 * 1024 * 1024;

/** Split the run script's trailing metadata block off the user's stdout. */
function splitMeta(raw: string): { stdout: string; runDir?: string; files: string[] } {
	const at = raw.lastIndexOf(META_MARK);
	if (at < 0) {
		return { stdout: raw, files: [] };
	}
	const stdout = raw.slice(0, at).replace(/\n$/, '');
	const rest = raw.slice(at + META_MARK.length).split('\n').map(l => l.trim()).filter(Boolean);
	const filesAt = rest.indexOf(FILES_MARK);
	const runDir = filesAt === 0 ? undefined : rest[0];
	const files = filesAt >= 0 ? rest.slice(filesAt + 1) : [];
	return { stdout, runDir, files };
}

/** Show a path the user can actually locate: under their home it becomes `~/…`,
 *  which is shorter and unambiguous across machines. Native separators kept. */
function homeRelative(p: string): string {
	const home = os.homedir();
	if (home && (p === home || p.startsWith(home + path.sep))) {
		return `~${p.slice(home.length)}`;
	}
	return p;
}

/** Subfolders (relative to the run dir) that actually hold results, so the answer
 *  can name them instead of leaving the user to hunt through the tree. */
function resultSubdirs(files: string[]): string[] {
	const dirs = new Set<string>();
	for (const rel of files) {
		const idx = rel.lastIndexOf('/');
		if (idx > 0) { dirs.add(rel.slice(0, idx)); }
	}
	return [...dirs].sort();
}

const STDOUT_CAP = 12000;
const STDERR_CAP = 4000;

function cap(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n) + `\n…[truncated ${s.length - n} more chars - see the run folder]`;
}

// Fallback name, used only when the caller gave no usable label. A counter
// breaks ties when two calls land in the same second (new Date() only has
// second/ms granularity and can collide).
let seq = 0;
function timestampId(): string {
	seq = (seq + 1) % 100000;
	const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
	return `${ts}-${String(seq).padStart(5, '0')}`;
}

/** Kebab-case slug of the caller's label. Deliberately restricted to [a-z0-9-]:
 *  the name becomes BOTH a Windows path segment and a directory inside a remote
 *  shell command, so anything else risks quoting or path trouble. */
function slugify(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48)
		.replace(/-+$/g, '');
}

/** Stable per-project key for the WSL bubblewrap sandbox home
 *  (`~/.qoka/sandboxes/<key>`). Derived from the OPEN workspace's absolute path so
 *  the SAME project always maps to the SAME sandbox (its installs/venvs persist and
 *  are reused), while two different folders - even same-named - get distinct keys
 *  via the path hash. Readable folder-name prefix + short hash for uniqueness. */
function projectSandboxKey(root: string): string {
	const base = slugify(path.basename(root)) || 'project';
	const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);
	return `${base}-${hash}`;
}

/** Heuristic: does a run's stderr look like a DEGRADED WSL instance (read-only fs,
 *  I/O / bus error) - the state a `wsl --shutdown` reset fixes - rather than an
 *  ordinary code error? Deliberately narrow so a normal failure never triggers a VM
 *  reset. */
function looksLikeDegradedWsl(stderr: string): boolean {
	const s = (stderr || '').toLowerCase();
	return s.includes('read-only file system')
		|| s.includes('input/output error')
		|| s.includes('bus error')
		|| s.includes('cannot allocate memory')
		|| s.includes('structure needs cleaning')
		// WSL SERVICE / lightweight-VM wedge (idle-timeout etc.): a `wsl --shutdown`
		// reset clears these, so treat them as degraded and recover rather than
		// relaying the raw error.
		|| s.includes('e_unexpected')
		|| s.includes('wsl/service')
		|| s.includes('the wsl service');
}

/** Heuristic: does a FAILED run's stderr say a tool / command / package is simply
 *  NOT INSTALLED (as opposed to a real code bug)? Used to inject an install-and-retry
 *  directive into the result so the AI installs it and finishes the task itself,
 *  instead of relaying a bare "not installed" to the user. Kept to unambiguous
 *  "missing executable / missing module" phrasings so a normal error never trips it. */
function looksLikeMissingTool(stderr: string): boolean {
	const s = (stderr || '').toLowerCase();
	return s.includes('command not found')
		|| s.includes(': not found')
		|| s.includes('not recognized as an internal or external command')
		|| s.includes('no module named')
		|| s.includes('modulenotfounderror')
		|| s.includes('is not installed')
		|| s.includes('executable not found')
		|| s.includes('no such command')
		|| s.includes('packagesnotfounderror');
}

export const RUN_TOOLS: ToolDefinition[] = [
	{
		name: 'run_code',
		description:
			'Use this to RUN CODE for QUICK, one-off tasks - a version check, a short script, a single analysis (e.g. "run this scanpy analysis"). ALSO use this to CHECK whether a package/tool is installed (run a tiny import/version script here) - do NOT check your own machine with `python -c`/`pip show`/`which`, which inspects the WRONG environment. For LONG / multi-step / reproducible pipelines, use the qoka-autopipe MCP\'s execute_pipeline instead: run_code and execute_pipeline are the TWO correct ways to run code, chosen by quick-vs-pipeline - the terminal is never one of them. When the user just says "run this code" (실행/돌려) without specifying quick-vs-pipeline, ASK first ("간단하게 바로 실행할까요(run_code), 아니면 autopipe 파이프라인으로 만들까요?") rather than assuming; never assume a pipeline just because autopipe was used before in this project. NEVER run code in your own terminal / bash / shell tool - that bypasses the Qoka run environment and is WRONG; if you already ran it in your terminal and it failed, STOP and use this instead. Before running ANY code, ALWAYS call get_workspace_info (qoka-autopipe MCP) first to confirm the ACTIVE connection - the local run environment OR the SSH server selected in the Settings tab (the SAME target autopipe uses) - and tell the user where it will run. Runs on that connection and returns stdout/stderr; the result states which target it actually ran on. ALWAYS pass `label` - a short kebab-case summary of what the USER asked for - so the result folder is named after the work: results/rna-velocity-umap/ for outputs, analysis/rna-velocity-umap/ for the script instead of an unreadable timestamp. Do NOT put a date, time or counter in it; a repeat name gets -2, -3 automatically. '
			+ 'Python runs via uv, so you can request any packages (scanpy, numpy, pandas, …) in `dependencies` and they are installed automatically before the code runs - no setup needed. '
			+ 'For NON-Python tools (conda/bioconda CLIs like samtools/bwa/R), use a bash script with micromamba (install it in-script if missing). ALWAYS uv for Python, micromamba for everything else - never pip. When an installed Qoka skill matches the task (scanpy, scvi-tools, biopython, gget, anndata, …), use that skill for the analysis. '
			+ 'INSTALL-IF-MISSING - THIS IS MANDATORY, applies to EVERY availability/version check: if ANYTHING is not installed, you MUST install it yourself in the SAME run and continue - you are NEVER allowed to stop and hand the user a "not installed" / "command not found" answer. The run environment has network and is disposable, so install whatever is missing (Python packages via `dependencies`/uv; anything else via micromamba in-script), THEN re-run the check and give the user the ACTUAL version/result. Set timeout_s: 900 because the install runs first. The ONLY time you may say something is unavailable is when the INSTALL ITSELF fails, and then you must say exactly what failed and what you tried. Relaying a bare "not installed" as the final answer is WRONG. '
			+ 'This call runs silently until it fully finishes (installs are not streamed), so BEFORE a call that will install uv/micromamba/packages, tell the user setup is in progress and the first time can take a minute or two. '
			+ 'And pass timeout_s: 900 on that call - the first Python run pulls the interpreter and all dependencies, which overruns the 300s default for anything like scanpy/anndata and aborts the install halfway, looking to the user like the code failed. '
			+ 'Do NOT use for multi-step, reproducible, or input/output-tracked work - build an autopipe pipeline (qoka-autopipe MCP) for that instead. '
			+ 'Files the code writes are saved AUTOMATICALLY under the project `results/<run-name>/` folder on the user\'s own disk (the script itself is saved under `analysis/<run-name>/`) - written directly on Windows/WSL, SFTP-copied back for a VM or a remote SSH server. The result says where. Never read those files back off the server and re-write them locally yourself; they are already there. '
			+ 'Use ONLY the project\'s existing folders: `data/` (inputs), `analysis/` (code you keep), `results/` (outputs), and `.qoka/` (internal). Do NOT create new top-level directories in the project (no `papers/`, `src/`, `output/`, `downloads/`, etc.) and never write above the project root - the results/ and analysis/ run folders are created for you, so just write relative paths and they land in results/<run-name>/. '
			+ 'stdout is returned here (truncated if very large). Result files the editor can display (plots, tables, reports) are OPENED AUTOMATICALLY as editor tabs, and the result lists which ones - so tell the user to look at the editor rather than instructing them to open anything, and never paste a file\'s contents into chat to "show" it. Anything not opened (too large, or a format the editor cannot display) stays in `results/<run-name>/` for them to handle from the Analysis tab.',
		inputSchema: {
			type: 'object',
			properties: {
				language: { type: 'string', description: 'Interpreter to run the code with. Python runs via uv.', enum: ['bash', 'python', 'node'] },
					label: { type: 'string', description: 'REQUIRED in practice: a SHORT kebab-case summary of what this run does, used as the result folder name (e.g. "rna-velocity-umap", "scanpy-qc", "check-scanpy-version"). Summarise the USER\'s request in 2-5 English words; lowercase letters, digits and hyphens only. This keeps results/ and analysis/ readable instead of a wall of timestamps. If the name is already taken it gets -2, -3, … automatically, so never add a date, time or counter yourself. Omitting this falls back to an ugly timestamp folder.' },
				code: { type: 'string', description: 'The full script source to run. It executes with its working directory set to the run folder, so relative output paths land in results/<run-name>/.' },
					retain: { type: 'string', enum: ['discard', 'scratch', 'keep'], description: 'What to do with the run AFTERWARDS. Choose deliberately. "discard" (DEFAULT): a throwaway run - a version/install check, or code written just to reproduce or debug an error. The ENTIRE run (script, logs, outputs) is DELETED right after it finishes, no trace. Use for anything the user did not ask to keep. "keep": the user asked for something substantial ("write code that does X and show me the result"), an analysis whose OUTPUTS matter, or a notebook. Script saved in analysis/<run-name>/, outputs in results/<run-name>/. "scratch": ambiguous - the user asked but it probably will not be reused. Script saved in .qoka/analysis/<run-name>/, outputs in results/<run-name>/. If you write a Jupyter notebook (.ipynb), use "keep". When unsure between discard and keep, prefer keep so results are not lost. IMPORTANT: a script whose only job is to DRIVE, set up, invoke or wrap something else - e.g. a bash helper to kick off or check an autopipe pipeline - is NOT a deliverable: never "keep" it (that clutters analysis/, which should hold only real code and downloaded pipeline code). Use "discard", or "scratch" if it may be reused. Better still, run pipelines with execute_pipeline, not run_code.' },
				dependencies: { type: 'array', description: 'Python packages to install for this run (e.g. ["scanpy", "leidenalg"]). Installed automatically via uv before the code runs. Python only; ignored for bash/node. Alternatively put a PEP 723 `# /// script` block in the code itself.', items: { type: 'string' } },
				timeout_s: { type: 'integer', description: 'Max seconds to allow the script to run (default 300, max 900). SET THIS TO 900 whenever the run may install anything: the FIRST Python run downloads the interpreter plus every requested package, and a scientific stack (scanpy, anndata, scvi-tools, a conda/bioconda env) routinely needs more than the 300s default. Exceeding it kills the run mid-install and looks to the user like the code failed. Later runs reuse the cache and are fast, so this costs nothing when it is not needed.' },
			},
			required: ['language', 'code'],
		},
		handler: async (args) => {
			// Named outside the try so a connection failure can say WHERE it failed.
			let target = 'the active connection';
			try {
				const language = String(args.language ?? '') as Lang;
				if (!LANGS[language]) {
					return errorResult(`run_code: unsupported language '${args.language}'. Use one of: bash, python, node.`);
				}
				const code = typeof args.code === 'string' ? args.code : '';
				if (!code.trim()) {
					return errorResult('run_code: `code` is required.');
				}
				const deps = Array.isArray(args.dependencies) ? args.dependencies.map(d => String(d)).filter(Boolean) : [];
				const timeoutMs = Math.max(1000, Math.min(900_000, Math.round(Number(args.timeout_s ?? 300) * 1000)));

				// Run on the ACTIVE connection (local run environment or an SSH server),
				// chosen in the Settings tab - shared with autopipe.
				const { profile: ep, isBuiltIn } = await resolveRunTarget();
				target = isBuiltIn ? builtInLabel() : `the SSH server ${ep.username}@${ep.host}:${ep.port}`;
				const { ssh } = services();
				const spec = LANGS[language];
				const file = spec.file;
				// Name the run folder after what the user actually asked for. Needs
				// wsRoot first: the name is de-duplicated against the project's existing
				// analysis/ folders so a repeat run never lands in the previous one.
				const wsRoot = workspaceFolderPath();
				// One run name, kept free across analysis/, results/ and data/ so this
				// run's script, outputs and input links never land in a previous run's
				// folder. Falls back to a timestamp when there is no usable label.
				const baseSlug = slugify(typeof args.label === 'string' ? args.label : '') || timestampId();
				const id = uniqueRunName(baseSlug);

				// Decide where the run dir lives. On Windows the local run environment is WSL,
				// so write straight into analysis/<id>/ through the /mnt mount (outputs
				// are then already local). Elsewhere - Mac/Linux local VM, or ANY
				// remote SSH host, neither of which can see the local /mnt path - the
				// run dir lives on the server and is SFTP-copied back below.
				const isWslBuiltin = isBuiltIn && process.platform === 'win32';
				// The local run environment mounts the OPEN project into the guest - WSL at
				// /mnt/<drive>/…, Mac vfkit at /mnt/qoka - so the run dir can BE the local
				// results/<id> folder and every output streams straight to the user's disk
				// as it is written. That survives a mid-run VM crash (the files are already
				// local) and needs no copy-back. True for BOTH WSL and vfkit whenever a
				// project is open; a remote SSH host has no such mount and still copies back.
				const mounted = isBuiltIn && !!wsRoot && isMountedRepo(ep);
				// Per-project sandbox key (WSL bubblewrap home). Falls back to a shared
				// scratch sandbox when no project is open.
				const projectKey = wsRoot ? projectSandboxKey(wsRoot) : '_scratch';
				// Shell EXPRESSION for the run dir, evaluated by the remote shell. The
				// non-mounted form must stay unquoted-$HOME so the shell expands it:
				// quoting it (or handing the literal to SFTP) creates a directory
				// actually named `$HOME` and the copy-back then finds nothing.
				let runDirExpr: string;
				let localDir: string | undefined;
				if (mounted && wsRoot) {
					// Mounted (WSL or vfkit): the run dir IS the project's results/<id> on the
					// local disk, seen through the guest mount. Outputs go there directly; the
					// script source is written separately into analysis/<id>/ below (CODE and
					// OUTPUTS kept apart). The guest-visible path differs per backend: WSL sees
					// the drive at /mnt/<drive>/…; vfkit sees the open project at /mnt/qoka, so
					// its results dir is workspacePathsFor(...).output_dir (/mnt/qoka/results).
					localDir = path.join(wsRoot, 'results', id);
					fs.mkdirSync(localDir, { recursive: true });
					runDirExpr = isWslBuiltin
						? `'${windowsToWsl(localDir)}'`
						: `'${workspacePathsFor(ep).output_dir}/${id}'`;
				} else if (!isBuiltIn) {
					// A user-provided SSH server: stay INSIDE the workspace directory the
					// user configured for that connection (repo_path). Writing to $HOME
					// would scatter run files outside the path they chose, which is theirs
					// to control. Same `{repo_path}/<kind>` layout as pipelines/ and
					// pipelines_output/. A leading `~` becomes $HOME so the shell still
					// expands it inside the double quotes.
					const repo = (ep.repo_path ?? '').trim().replace(/\/+$/, '').replace(/^~(?=\/|$)/, '$HOME');
					runDirExpr = repo ? `"${repo}/analysis/${id}"` : `"$HOME/qoka-analysis/${id}"`;
				} else {
					// Local VM (Mac/Linux): a scratch guest whose results are copied
					// back into the project, so its own home is fine.
					runDirExpr = `"$HOME/qoka-analysis/${id}"`;
				}

				// Python: inject the requested deps as PEP 723 metadata so `uv run`
				// installs them. Other languages run the source as-is.
				const source = language === 'python' ? injectPep723(code, deps) : code;

				// Where the CODE is saved. Logs + outputs always land in results/<id>/;
				// the script is placed apart based on `retain`:
				//   keep    -> analysis/<id>/        (real code / a notebook)
				//   scratch -> .qoka/analysis/<id>/  (asked for, but low value)
				//   discard -> nowhere; the whole run is deleted when it finishes.
				const retain: 'discard' | 'scratch' | 'keep' =
					args.retain === 'keep' ? 'keep' : args.retain === 'scratch' ? 'scratch' : 'discard';
				let codeDir: string | undefined;
				if (wsRoot && retain === 'keep') { codeDir = path.join(wsRoot, 'analysis', id); }
				else if (wsRoot && retain === 'scratch') { codeDir = path.join(wsRoot, '.qoka', 'analysis', id); }
				// The script SOURCE is already in hand, so write it straight to disk - no
				// copy-back needed. Best-effort: needs an open folder and a kept run.
				if (codeDir) {
					try {
						fs.mkdirSync(codeDir, { recursive: true });
						fs.writeFileSync(path.join(codeDir, spec.file), source, 'utf8');
					} catch { /* best-effort - the run still proceeds */ }
				}
				const encoded = Buffer.from(source, 'utf8').toString('base64');
				const ensure = language === 'python' ? `${ENSURE_UV}\n` : '';
				// Unbuffer python stdout/stderr so stdout.log / stderr.log land on the (now
				// often mounted, local) run dir line-by-line as they print - a crash then
				// keeps the log up to the last line, not just to the last 4KB flush.
				const pyBuf = language === 'python' ? 'export PYTHONUNBUFFERED=1\n' : '';
				const runCmd = spec.run(file);
				// The block that runs the user's code and writes stdout.log / stderr.log into
				// the run dir. On the WSL local run environment it runs inside a PER-PROJECT
				// bubblewrap sandbox so the code - and anything it installs - can only touch
				// this project's sandbox home (mounted as HOME) + its run/data dirs; the rest
				// of WSL and all of Windows are simply absent inside. Every other target (an
				// SSH server, the Mac/Linux VM) already isolates the run and executes directly.
				let execBlock: string;
				if (isWslBuiltin) {
					// Per-project env on the ext4 side (fast; off /mnt so venvs skip the drvfs
					// penalty). Mounted as HOME=/home/qoka inside the sandbox (a FIXED inside
					// path, so venv shebangs stay valid across runs AND the real ~/.qoka tree is
					// never visible - a run can't see or reach sibling projects). uv/micromamba/
					// pip therefore install into THIS project's dir, never the WSL user's home.
					const sbx = `"$HOME/.qoka/sandboxes/${projectKey}"`;
					// Runner carries PATH + install + run, base64-fed to a file in the sandbox
					// home so its own quoting can't collide with the outer shell AND $HOME
					// resolves to the sandbox (bwrap --setenv), not the WSL user home.
					const runnerB64 = Buffer.from(
						`export PATH="/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin"\n${pyBuf}${ensure}${runCmd}\n`,
						'utf8').toString('base64');
					const dataDir = mounted && wsRoot ? path.join(wsRoot, 'data') : undefined;
					const dataBind = dataDir && fs.existsSync(dataDir)
						? `--ro-bind '${windowsToWsl(dataDir)}' '${windowsToWsl(dataDir)}' `
						: '';
					execBlock = [
						// bwrap missing (not yet provisioned) -> run directly with a VISIBLE
						// warning rather than hard-failing mid-rollout; provisioning installs
						// bubblewrap on the next Qoka launch.
						'if command -v bwrap >/dev/null 2>&1; then',
						`  mkdir -p ${sbx}`,
						`  printf '%s' '${runnerB64}' | base64 -d > ${sbx}/.qoka-run.sh`,
						// /etc/resolv.conf on WSL is a SYMLINK (usually -> /mnt/wsl/resolv.conf), so
						// binding /etc alone leaves a DANGLING link inside and DNS fails. Bind the
						// symlink's REAL target at its own path so the link resolves - this exposes
						// only that single resolv.conf file, never the rest of /mnt (/mnt/c stays
						// invisible). When resolv.conf is a regular file this binds it over itself.
						'  QOKA_RESOLV="$(readlink -f /etc/resolv.conf 2>/dev/null || echo /etc/resolv.conf)"',
						'  bwrap \\',
						'    --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind-try /sbin /sbin \\',
						'    --ro-bind /lib /lib --ro-bind-try /lib64 /lib64 \\',
						'    --ro-bind /etc /etc --ro-bind-try "$QOKA_RESOLV" "$QOKA_RESOLV" \\',
						'    --proc /proc --dev /dev --tmpfs /tmp \\',
						`    --bind ${sbx} /home/qoka \\`,
						`    --bind ${runDirExpr} ${runDirExpr} \\`,
						`    ${dataBind}--chdir ${runDirExpr} --setenv HOME /home/qoka \\`,
						'    --unshare-all --share-net --die-with-parent \\',
						'    bash /home/qoka/.qoka-run.sh > stdout.log 2> stderr.log',
						'else',
						'  echo "[qoka] bubblewrap not installed in the run environment - running WITHOUT sandbox isolation. Restart Qoka to finish setup." >&2',
						'  export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"',
						`  ${pyBuf}${ensure}${runCmd} > stdout.log 2> stderr.log`,
						'fi',
					].join('\n');
				} else {
					execBlock = 'export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"\n'
						+ `${pyBuf}${ensure}${runCmd} > stdout.log 2> stderr.log`;
				}
				// ONE login for the whole run: mkdir + write the script + execute + report
				// the resolved dir and the files produced. Kept to a single connection
				// because servers that rate-limit rapid logins refuse a burst partway
				// through; it also yields the ABSOLUTE run dir ($HOME expanded remotely),
				// which the SFTP copy-back needs.
				const script = [
					'export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"',
					`mkdir -p ${runDirExpr} && cd ${runDirExpr} || exit 97`,
					`echo '${encoded}' | base64 -d > '${file}'`,
					execBlock,
					'__rc=$?',
					'cat stdout.log',
					'cat stderr.log >&2',
					// Trailing metadata block, stripped from stdout before display.
					`printf '\\n%s\\n' '${META_MARK}'`,
					'pwd',
					`printf '%s\\n' '${FILES_MARK}'`,
					"ls -1p 2>/dev/null | grep -v '/$'",
					'exit $__rc',
				].join('\n');
				// Run once. If the built-in WSL run environment is DEGRADED (a dropped
				// connection, or a read-only / I/O / bus-error signature - what a manual
				// `wsl --shutdown` fixes), reset it ONCE via VMManager.recover (stop +
				// wsl --shutdown + start; keeps ALL data, never --unregister) and retry
				// with a fresh endpoint. The user never touches a terminal. A normal code
				// error is NOT degraded, so it never triggers a reset.
				const runScript = (endpoint: typeof ep) => ssh.run(endpoint, script, { timeoutMs });
				let r: Awaited<ReturnType<typeof ssh.run>>;
				let degraded = false;
				try {
					r = await runScript(ep);
					degraded = isBuiltIn && looksLikeDegradedWsl(r.stderr);
				} catch (execErr) {
					if (!isBuiltIn) { throw execErr; }
					r = undefined as unknown as Awaited<ReturnType<typeof ssh.run>>;
					degraded = true; // a thrown error on the built-in WSL = treat as degraded
				}
				if (degraded) {
					try {
						await services().vm.recover();
						const fresh = await resolveRunTarget();
						r = await runScript(fresh.profile);
					} catch (recoverErr) {
						if (!r) { throw recoverErr; } // no first result and retry failed - surface it
					}
				}
				if (r.exitCode === 97) {
					return errorResult(`run_code could not create its run directory on ${target}: ${r.stderr.trim() || 'mkdir failed'}. Check the account has a writable home directory there.`);
				}
				const { stdout, runDir: resolvedDir, files: produced } = splitMeta(r.stdout);

				// Copy results back so they are on the user's disk WITHOUT the AI having
				// to read each file over SSH and re-write it locally.
				let savedTo: string | undefined;
				let copyNote: string | undefined;
				let skipped: string[] = [];
				if (mounted && localDir) {
					savedTo = localDir;
				} else if (wsRoot && resolvedDir) {
					const dest = path.join(wsRoot, 'results', id);
					try {
						const summary = await copyRemoteDirToLocal(ep, resolvedDir, dest, { maxFileBytes: MAX_COPY_BYTES });
						savedTo = dest;
						skipped = summary.skipped;
						if (summary.failed > 0) {
							copyNote = `${summary.failed} file(s) could not be copied back: ${summary.errors.slice(0, 3).join('; ')}. They are still on the server at ${resolvedDir}.`;
						}
					} catch (e) {
						// Never silent: if the auto-save failed the AI must say so rather
						// than leaving the user believing the results are local.
						copyNote = `Automatic copy of the results into the project FAILED (${(e as Error).message}). The files are still on the server at ${resolvedDir}. Tell the user, and offer to retry - do NOT quietly read and re-write the files yourself.`;
					}
				}

				const lines: string[] = [];
				const targetLabel = isBuiltIn ? builtInLabel() : `the SSH server ${ep.username}@${ep.host}:${ep.port}`;
				lines.push(`Ran ${language} on ${targetLabel} (exit ${r.exitCode}).`);
				lines.push('');
				lines.push('stdout:');
				lines.push(stdout.trim() ? cap(stdout, STDOUT_CAP) : '(empty)');
				if (r.stderr.trim()) {
					lines.push('', 'stderr:', cap(r.stderr, STDERR_CAP));
				}
				if (produced.length) {
					lines.push('', `Files produced: ${produced.join(', ')}`);
				}
				// What is ACTUALLY on disk now, recursively. The remote `ls` above only
				// sees the run dir's top level, so a script that writes into figures/
				// or tables/ had those files copied but never reported or opened.
				// Code / log split + throwaway cleanup.
				if (retain === 'discard') {
					// Throwaway run (version/install check, or debug repro): delete the
					// WHOLE run - script, logs and outputs - so it leaves no trace. The
					// stdout captured above is still returned to the AI.
					for (const d of [savedTo, localDir]) {
						if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
					}
					savedTo = undefined;
				} else if (savedTo) {
					// keep/scratch: the CODE lives in analysis/ (or .qoka/analysis/), so
					// drop the script copy the run left in results/ - results then holds
					// only the logs (stdout.log / stderr.log) and the outputs.
					try { fs.rmSync(path.join(savedTo, spec.file), { force: true }); } catch { /* best-effort */ }
				}

				const savedFiles = savedTo ? listLocalFiles(savedTo) : [];
				// Show the results, don't just say where they are.
				const shown = savedTo ? await openResultsInEditor(savedTo, savedFiles) : { opened: [], remaining: [] };

				if (savedTo) {
					const subdirs = resultSubdirs(savedFiles);
					lines.push('', `Results are saved on the user's own computer at: ${homeRelative(savedTo)}`);
					// Spell out that the last path segment is THIS run's folder. Without a
					// label it is a bare timestamp, which reads like noise rather than a
					// name the user can look for in the Analysis tab.
					lines.push(`Inside the open project that is results/${id}/, where "${id}" is the folder for THIS run.`
						+ (mounted ? '' : ' The files were copied back from the run target, so they are already local.'));
					if (subdirs.length) {
						lines.push(`Result files are in these subfolders of that run folder: ${subdirs.map(d => `${d}/`).join(', ')}. Name the subfolder when you tell the user where something is - do not just say "the results folder".`);
					}
					lines.push(`The script for this run is saved as CODE in ${retain === 'keep' ? `analysis/${id}/` : `.qoka/analysis/${id}/`} (results are separate, in results/${id}/).`);
					lines.push('When you tell the user where results are, give them this full path, not a bare folder name.');
					lines.push('Do NOT read these files off the server and write them again yourself - they are already local.');
					lines.push(...describeOpenedResults(shown));
					if (skipped.length) {
						lines.push(`These are too large to copy back automatically (over ${humanSize(MAX_COPY_BYTES)}) and are still on the server: ${skipped.join(', ')}.`
							+ ` You MUST tell the user about them and ASK whether to download them - do not decide for them, and do not stay silent about them.`
							+ ` If they say yes, use download_results (qoka-autopipe MCP) with the run directory ${resolvedDir || 'reported above'}; it may take a while for a large file.`);
					}
				} else if (retain === "discard") {
					lines.push('', 'This was a throwaway run (retain=discard): the script, logs and outputs were deleted afterwards, leaving no trace. Only the stdout above remains. If the user actually wanted the code or results kept, re-run with retain=keep.');
				} else if (!wsRoot) {
					lines.push('', `No project folder is open, so results could NOT be saved locally; they are on the run target at ${resolvedDir || 'the run directory'}. Ask the user to open a folder so results are saved into results/ automatically.`);
				}
				if (copyNote) {
					lines.push('', copyNote);
				}
				// The run FAILED only because something is not installed: inject a strong
				// install-and-retry directive at the TOP of the result, right where the AI
				// makes its next decision. A static tool description alone does not stop a
				// model from relaying "command not found" to the user; this does, because
				// it arrives in the very result the model must process next.
				if (r.exitCode !== 0 && looksLikeMissingTool(r.stderr)) {
					lines.unshift(
						'ACTION REQUIRED - DO NOT relay this failure to the user. The run failed ONLY because a required tool/command/package is not installed in the run environment. '
						+ 'This environment is disposable and has network access, so you MUST install it yourself and finish the task in THIS SAME turn - do not ask the user, do not stop: '
						+ 'for a Python package add it to `dependencies` (uv); for anything else (a CLI such as julia, samtools, R, …) write a bash script that installs it (micromamba, e.g. `micromamba install -y -c conda-forge <tool>`, or the tool\'s own installer) and THEN runs the original command in the same script. '
						+ 'Call run_code again NOW with timeout_s: 900 and give the user the ACTUAL result. Only if the INSTALL ITSELF then fails may you tell the user, stating exactly what failed. Reporting "not installed" as your answer is WRONG.',
						'',
					);
				}
				return textResult(lines.join('\n'));
			} catch (err) {
				const message = (err as Error).message;
				// ssh2 reports every connect/auth problem as this one opaque string.
				// Translate it into the actionable message the pre-run probe used to
				// produce - without the probe's extra login, which is what pushed
				// rate-limiting servers into refusing the run in the first place.
				if (/authentication methods failed|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|Timed out while waiting for handshake/i.test(message)) {
					return errorResult(
						`run_code could not connect to ${target}: ${message}. `
						+ 'Check that the server is reachable and the credentials in the Settings tab are current, then try again. '
						+ 'If it just worked and now fails, the server may be refusing rapid repeat logins - wait a few seconds and retry.');
				}
				return errorResult(`run_code failed: ${message}`);
			}
		},
	},
];

/** Server-level guidance for the qoka-run MCP, surfaced to the model at `initialize`. */
export const RUN_MCP_INSTRUCTIONS = [
	'This server ("qoka-run") runs short, self-contained code for quick, one-off tasks.',
	'',
	'HARD RULE - HOW TO RUN OR CHECK CODE (this overrides your defaults):',
	'ANY request to run/execute code, OR to check the environment / whether a package or tool is installed (실행, 돌려, run, execute, "is X installed", "환경 확인") MUST go through a Qoka MCP tool. NEVER use your own terminal / shell / bash / python for it.',
	'Do NOT run `python -c ...`, `pip show`, `pip list`, `which`, `conda list`, `Rscript -e ...` in YOUR shell to "see what is installed" - that inspects YOUR machine, not the Qoka run environment where code actually runs, so the answer is wrong. To check whether a package is installed, run a tiny script via run_code (e.g. python that imports it) on the run connection.',
	'Sequence, every time: (1) call get_workspace_info (qoka-autopipe MCP) to confirm the ACTIVE run connection is reachable - if not, call start_server then re-check; (2) then run_code here (quick) or execute_pipeline on autopipe (pipeline).',
	'FALLBACK: if you ever run something in your own terminal and it errors or looks wrong, STOP - that was the wrong tool. Call get_workspace_info to find the run environment and redo it with run_code.',
	'',
	'WHERE it runs: run_code executes on the ACTIVE Qoka connection - the local run environment OR the SSH server the user selected in the Settings tab - the SAME target autopipe pipelines use. They are NOT separate servers: whichever connection is active runs BOTH quick code (run_code) AND autopipe pipelines. So run_code CAN run on an SSH server, and autopipe CAN run on the local run environment. The run_code result states which target it actually used - relay that to the user so they know where it ran.',
	'',
	'NEVER run the user\'s code in your own terminal/shell. To run/execute code (실행/돌려) you MUST call a Qoka MCP tool: run_code (this server) for a quick one-off script, or the qoka-autopipe MCP for a reproducible multi-step pipeline. Falling back to the local terminal is WRONG - it bypasses the Qoka run environment.',
	'',
	'Routing - ASK FIRST BY DEFAULT: when the user asks to run/execute code (실행/돌려/run) and has NOT clearly said HOW they want it run, you MUST ASK before running anything, offering the THREE ways: "바로 실행(run_code), 재현 파이프라인(autopipe), 아니면 노트북으로 셀 단위 실행(create_notebook) 중 어떻게 할까요?" (Run it now, build a reproducible pipeline, or author a notebook to run cell by cell?). Do NOT silently pick one.',
	'Do NOT default to building an autopipe pipeline: a pipeline needs a Snakefile/config/Dockerfile and is MUCH heavier to set up than run_code. Having used autopipe before in THIS project is NOT a reason to assume a pipeline this time - that is a common mistake; ASK instead of assuming.',
	'- Quick / one-off  -> use this server\'s run_code.',
	'- Multi-step / reproducible / needs inputs & outputs tracked -> use execute_pipeline (qoka-autopipe MCP).',
	'- Step-by-step, inspect-as-you-go, or the user says "노트북"/"notebook"/"cell by cell" -> use create_notebook (qoka-autopipe MCP) to AUTHOR a .ipynb; the user runs the cells with the "Qoka Run Environment" kernel. Do NOT run notebook cells yourself.',
	'Only SKIP the question when the user already made the intent clear (e.g. "그냥 빨리 돌려줘" / "just run this quickly" -> run_code; "파이프라인으로 만들어줘" -> execute_pipeline; "노트북으로 만들어줘" -> create_notebook). Never fall back to the terminal.',
	'',
	'NOTEBOOK DATA PATHS: notebook cells run in the ACTIVE run environment, which has its OWN filesystem. Prefer RELATIVE paths (data/…). create_notebook/edit_notebook auto-rewrite an absolute LOCAL path to the run-env mount (Windows C:\\… -> /mnt/c/…; on Mac vfkit the open project -> /mnt/qoka/…). But when an SSH server is the active connection there is NO local mount - the notebook runs on that server and can only read data that already lives THERE; a local path will fail, so tell the user to use data on the SSH server (or switch to the local run environment). If a cell still errors with FileNotFound on a local path, fix it to the mounted path and tell the user to re-run.',
	'',
	'Installing packages/tools - always pick the RIGHT manager, and install the manager itself first if it is missing:',
	'',
	'CRITICAL - a MISSING package is NEVER a reason to stop, to refuse, or to tell the user something "is not installed". run_code INSTALLS whatever the code needs, ON DEMAND, before it runs. So when the user asks to run something that needs a package: ADD the package (Python -> list it in `dependencies`; other tools -> install it in the bash script) and RUN IT immediately. Do NOT check first and then refuse, do NOT report "X is not installed" as a blocker, and do NOT ask the user to install anything - the run environment self-installs, that is the entire point of this tool. If a first run reported a package missing, that means you must ADD it and re-run, not give up.',
	'',
	'1) PYTHON packages -> ALWAYS uv. Never pip-install into the system Python. run_code already runs Python through uv, so just pass the packages in `dependencies` (e.g. ["scanpy"]) or put a PEP 723 `# /// script` block in the code - they install automatically. So "run this with scanpy" works directly.',
	'',
	'2) NON-Python tools (conda/bioconda CLIs and libraries - samtools, bwa, bcftools, R, etc.) -> ALWAYS micromamba. Use a bash run_code call. If micromamba is not installed, install it first in the script (user-local, no root):',
	'     mkdir -p "$HOME/.local/bin"',
	'     command -v micromamba >/dev/null 2>&1 || curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C "$HOME/.local" bin/micromamba',
	'     export MAMBA_ROOT_PREFIX="$HOME/.micromamba"',
	'     eval "$(micromamba shell hook -s bash)"',
	'   then create/use an env and run the tool, e.g.:',
	'     micromamba create -y -n run -c conda-forge -c bioconda samtools',
	'     micromamba run -n run samtools --version',
	'   ($HOME/.local/bin is already on PATH for run_code.)',
	'',
	'Do NOT mix the two (no pip for Python, no uv for non-Python tools).',
	'',
	'ALWAYS announce setup BEFORE calling run_code when an install will happen, so the user is not left waiting on a silent, long call (run_code returns only AFTER the whole thing finishes - installs are NOT streamed). Post a short message in the user\'s language, and be specific about WHAT is installing:',
	'- Installing uv / Python packages (first Python run, or new `dependencies`): e.g. "uv로 환경을 준비하고 필요한 패키지를 설치하는 중입니다… 처음 한 번은 1~2분 걸릴 수 있어요."',
	'- Installing micromamba and/or conda tools (bash run): e.g. "micromamba와 요청하신 도구를 설치하는 중입니다… 큰 환경은 몇 분 걸릴 수 있어요."',
	'Say it is a ONE-TIME setup and later runs are cached and fast, and pass timeout_s: 900 on ANY run that may install - not just large conda/bioconda environments. The FIRST Python run on a fresh machine downloads the interpreter plus every dependency, and a stack like scanpy or anndata regularly exceeds the 300s default; when it does, the run is killed part-way through the install and the user is told the code failed. Raising the timeout costs nothing on a cached run.',
	'If nothing new needs installing (already cached), no setup message is needed - just run it.',
	'',
	'Results: run_code saves each run\'s outputs under the project\'s results/<run-name>/ folder (and its script under analysis/<run-name>/) on the user\'s LOCAL disk, automatically - including runs on a remote SSH server, whose outputs are copied back before the tool returns. stdout is returned in chat.',
	'Files the editor can display (plots, tables, reports) are then OPENED FOR THE USER as editor tabs, and the tool result names them. So when a run produces a figure or a table, say it is now open in the editor and describe what it shows - do NOT tell the user to go find and open it, and do NOT dump the file contents into chat. Only files that were too large or in a format the editor cannot display are left for the Analysis tab.',
	'Do NOT hand-copy results: never chain read_file on the server + write_file locally to "bring back" an output. The copy already happened. Read from the LOCAL results/<run-name>/ path if you need the contents. The only exception is a file the result explicitly says was left on the server for being over the auto-copy size limit.',
].join('\n');
