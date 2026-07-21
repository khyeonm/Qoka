/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { ToolDefinition, textResult, errorResult } from './types';
import { services } from '../../common/services';
import { resolveRunTarget } from '../../runtime/builtinServer';
import { windowsToWsl } from '../../common/dockerEnv';
import { workspaceFolderPath, copyRemoteDirToLocal } from '../../common/workspaceSync';
import { humanSize } from '../../common/workspaceSync';

/**
 * qoka-run MCP: run a short, self-contained script on the Qoka built-in server
 * (the SAME WSL distro / VM autopipe uses - shared via VMManager) for quick,
 * one-off tasks. Distinct from autopipe, which builds reproducible multi-step
 * pipelines.
 *
 * Results ALWAYS land in the project's `analysis/<run-id>/` folder, whichever
 * target ran them. On Windows the built-in server is WSL, so the run dir IS the
 * project's analysis dir seen through the /mnt mount - the code writes straight
 * to local disk, no copy. Everywhere else (Mac/Linux built-in VM, and ANY remote
 * SSH server) the run dir lives on the server and is SFTP-copied back into
 * analysis/<run-id>/ before this tool returns, so the AI never has to read the
 * files over SSH and re-write them locally by hand.
 */

type Lang = 'bash' | 'python' | 'node';

// How each language is executed on the built-in server. Python ALWAYS runs via
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

const STDOUT_CAP = 12000;
const STDERR_CAP = 4000;

function cap(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n) + `\n…[truncated ${s.length - n} more chars - see the run folder]`;
}

// Unique-per-call id. A counter breaks ties when two calls land in the same
// second (new Date() only has second/ms granularity and can collide).
let seq = 0;
function newRunId(): string {
	seq = (seq + 1) % 100000;
	const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
	return `${ts}-${String(seq).padStart(5, '0')}`;
}

export const RUN_TOOLS: ToolDefinition[] = [
	{
		name: 'run_code',
		description:
			'Use this to RUN CODE for QUICK, one-off tasks - a version check, a short script, a single analysis (e.g. "run this scanpy analysis"). ALSO use this to CHECK whether a package/tool is installed (run a tiny import/version script here) - do NOT check your own machine with `python -c`/`pip show`/`which`, which inspects the WRONG environment. For LONG / multi-step / reproducible pipelines, use the autopipe MCP\'s execute_pipeline instead: run_code and execute_pipeline are the TWO correct ways to run code, chosen by quick-vs-pipeline - the terminal is never one of them. NEVER run code in your own terminal / bash / shell tool - that bypasses the Qoka run environment and is WRONG; if you already ran it in your terminal and it failed, STOP and use this instead. Before running ANY code, ALWAYS call get_workspace_info (autopipe MCP) first to confirm the ACTIVE connection - the built-in server OR the SSH server selected in the Connections tab (the SAME target autopipe uses) - and tell the user where it will run. Runs on that connection and returns stdout/stderr; the result states which target it actually ran on. '
			+ 'Python runs via uv, so you can request any packages (scanpy, numpy, pandas, …) in `dependencies` and they are installed automatically before the code runs - no setup needed. '
			+ 'For NON-Python tools (conda/bioconda CLIs like samtools/bwa/R), use a bash script with micromamba (install it in-script if missing). ALWAYS uv for Python, micromamba for everything else - never pip. When an installed Qoka skill matches the task (scanpy, scvi-tools, biopython, gget, anndata, …), use that skill for the analysis. '
			+ 'This call runs silently until it fully finishes (installs are not streamed), so BEFORE a call that will install uv/micromamba/packages, tell the user setup is in progress and the first time can take a minute or two. '
			+ 'And pass timeout_s: 900 on that call - the first Python run pulls the interpreter and all dependencies, which overruns the 300s default for anything like scanpy/anndata and aborts the install halfway, looking to the user like the code failed. '
			+ 'Do NOT use for multi-step, reproducible, or input/output-tracked work - build an autopipe pipeline (autopipe MCP) for that instead. '
			+ 'Files the code writes are saved AUTOMATICALLY under the project `analysis/<run-id>/` folder on the user\'s own disk - written directly on Windows/WSL, SFTP-copied back for a VM or a remote SSH server. The result says where. Never read those files back off the server and re-write them locally yourself; they are already there. '
			+ 'stdout is returned here (truncated if very large). Large results or images/plots are NOT shown in chat - tell the user to open them from `analysis/<run-id>/` in the Explorer.',
		inputSchema: {
			type: 'object',
			properties: {
				language: { type: 'string', description: 'Interpreter to run the code with. Python runs via uv.', enum: ['bash', 'python', 'node'] },
				code: { type: 'string', description: 'The full script source to run. It executes with its working directory set to the run folder, so relative output paths land in analysis/<run-id>/.' },
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

				// Run on the ACTIVE connection (built-in server or an SSH server),
				// chosen in the Connections tab - shared with autopipe.
				const { profile: ep, isBuiltIn } = await resolveRunTarget();
				target = isBuiltIn ? 'the built-in server' : `the SSH server ${ep.username}@${ep.host}:${ep.port}`;
				const { ssh } = services();
				const spec = LANGS[language];
				const file = spec.file;
				const id = newRunId();

				// Decide where the run dir lives. On Windows the built-in server is WSL,
				// so write straight into analysis/<id>/ through the /mnt mount (outputs
				// are then already local). Elsewhere - Mac/Linux built-in VM, or ANY
				// remote SSH host, neither of which can see the local /mnt path - the
				// run dir lives on the server and is SFTP-copied back below.
				const wsRoot = workspaceFolderPath();
				const mounted = isBuiltIn && process.platform === 'win32' && !!wsRoot;
				// Shell EXPRESSION for the run dir, evaluated by the remote shell. The
				// non-mounted form must stay unquoted-$HOME so the shell expands it:
				// quoting it (or handing the literal to SFTP) creates a directory
				// actually named `$HOME` and the copy-back then finds nothing.
				let runDirExpr: string;
				let localDir: string | undefined;
				if (mounted && wsRoot) {
					localDir = path.join(wsRoot, 'analysis', id);
					fs.mkdirSync(localDir, { recursive: true });
					runDirExpr = `'${windowsToWsl(localDir)}'`;
				} else {
					runDirExpr = `"$HOME/qoka-analysis/${id}"`;
				}

				// Python: inject the requested deps as PEP 723 metadata so `uv run`
				// installs them. Other languages run the source as-is.
				const source = language === 'python' ? injectPep723(code, deps) : code;
				const encoded = Buffer.from(source, 'utf8').toString('base64');
				const ensure = language === 'python' ? `${ENSURE_UV}; ` : '';
				// ONE login for the whole run: mkdir + write the script + execute +
				// report the resolved dir and the files produced. This used to be four
				// separate connections, and servers that rate-limit rapid logins started
				// refusing them partway through ("All configured authentication methods
				// failed"). It also gets us the ABSOLUTE run dir ($HOME expanded by the
				// remote shell), which the SFTP copy-back needs.
				const script = [
					'export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"',
					`mkdir -p ${runDirExpr} && cd ${runDirExpr} || exit 97`,
					`echo '${encoded}' | base64 -d > '${file}'`,
					`${ensure}${spec.run(file)} > stdout.log 2> stderr.log`,
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
				const r = await ssh.run(ep, script, { timeoutMs });
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
					const dest = path.join(wsRoot, 'analysis', id);
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
				const targetLabel = isBuiltIn ? 'the built-in server' : `the SSH server ${ep.username}@${ep.host}:${ep.port}`;
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
				if (savedTo) {
					lines.push('', `Results were saved automatically into the project at analysis/${id}/ (${savedTo}).`
						+ (mounted ? '' : ' They were copied back over SFTP, so they are already on the user\'s disk.'));
					lines.push('Do NOT read these files off the server and write them again yourself - they are already local. To show a result, point the user at analysis/' + id + '/ in the Explorer, or read it from that LOCAL path.');
					if (skipped.length) {
						lines.push(`These are too large to copy back automatically (over ${humanSize(MAX_COPY_BYTES)}) and are still on the server: ${skipped.join(', ')}.`
							+ ` You MUST tell the user about them and ASK whether to download them - do not decide for them, and do not stay silent about them.`
							+ ` If they say yes, use download_results (autopipe MCP) with the run directory ${resolvedDir || 'reported above'}; it may take a while for a large file.`);
					}
				} else if (!wsRoot) {
					lines.push('', `No project folder is open, so results could NOT be saved locally; they are on the run target at ${resolvedDir || 'the run directory'}. Ask the user to open a folder so results are saved into analysis/ automatically.`);
				}
				if (copyNote) {
					lines.push('', copyNote);
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
						+ 'Check that the server is reachable and the credentials in the Connections tab are current, then try again. '
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
	'Sequence, every time: (1) call get_workspace_info (autopipe MCP) to confirm the ACTIVE run connection is reachable - if not, call start_server then re-check; (2) then run_code here (quick) or execute_pipeline on autopipe (pipeline).',
	'FALLBACK: if you ever run something in your own terminal and it errors or looks wrong, STOP - that was the wrong tool. Call get_workspace_info to find the run environment and redo it with run_code.',
	'',
	'WHERE it runs: run_code executes on the ACTIVE Qoka connection - the built-in server OR the SSH server the user selected in the Connections tab - the SAME target autopipe pipelines use. They are NOT separate servers: whichever connection is active runs BOTH quick code (run_code) AND autopipe pipelines. So run_code CAN run on an SSH server, and autopipe CAN run on the built-in server. The run_code result states which target it actually used - relay that to the user so they know where it ran.',
	'',
	'NEVER run the user\'s code in your own terminal/shell. To run/execute code (실행/돌려) you MUST call a Qoka MCP tool: run_code (this server) for a quick one-off script, or the autopipe MCP for a reproducible multi-step pipeline. Falling back to the local terminal is WRONG - it bypasses the Qoka run environment.',
	'',
	'Routing: if it is unclear which the user wants, ASK: "간단한 코드를 바로 돌릴까요, 아니면 autopipe 파이프라인으로 만들까요?" (Run a quick script now, or build an autopipe pipeline?). Or decide yourself which fits - but never fall back to the terminal.',
	'- Quick / one-off  -> use this server\'s run_code.',
	'- Multi-step / reproducible / needs inputs & outputs tracked -> use the autopipe MCP instead.',
	'If the user already made the intent clear (e.g. "just run this quickly"), do NOT ask - run it.',
	'',
	'Installing packages/tools - always pick the RIGHT manager, and install the manager itself first if it is missing:',
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
	'Results: run_code saves each run under the project\'s analysis/<run-id>/ folder on the user\'s LOCAL disk, automatically - including runs on a remote SSH server, whose outputs are SFTP-copied back before the tool returns. stdout is returned in chat. If a result is large or an image/plot, it is NOT in chat - tell the user to open it from analysis/<run-id>/ in the Explorer.',
	'Do NOT hand-copy results: never chain read_file on the server + write_file locally to "bring back" an output. The copy already happened. Read from the LOCAL analysis/<run-id>/ path if you need the contents. The only exception is a file the result explicitly says was left on the server for being over the auto-copy size limit.',
].join('\n');
