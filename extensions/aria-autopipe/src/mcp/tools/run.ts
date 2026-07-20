/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { ToolDefinition, textResult, errorResult } from './types';
import { services } from '../../common/services';
import { ensureBuiltinServer } from '../../runtime/builtinServer';
import { windowsToWsl } from '../../common/dockerEnv';
import { workspaceFolderPath, copyRemoteDirToLocal } from '../../common/workspaceSync';

/**
 * qoka-run MCP: run a short, self-contained script on the Qoka built-in server
 * (the SAME WSL distro / VM autopipe uses - shared via VMManager) for quick,
 * one-off tasks. Distinct from autopipe, which builds reproducible multi-step
 * pipelines.
 *
 * Results land in the project's `analysis/<run-id>/` folder. On Windows the
 * built-in server is WSL, so the run dir IS the project's analysis dir seen
 * through the /mnt mount - the code writes straight to local disk, no copy.
 * On Mac/Linux (QEMU/vfkit built-in) there is no host mount, so the run dir
 * lives in the guest and is SFTP-copied into analysis/<run-id>/ afterwards.
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
			'Run a short, self-contained script (bash | python | node) on the Qoka built-in server and return its stdout/stderr. For QUICK one-off tasks - e.g. "run this scanpy analysis". '
			+ 'Python runs via uv, so you can request any packages (scanpy, numpy, pandas, …) in `dependencies` and they are installed automatically before the code runs - no setup needed. '
			+ 'For NON-Python tools (conda/bioconda CLIs like samtools/bwa/R), use a bash script with micromamba (install it in-script if missing). ALWAYS uv for Python, micromamba for everything else - never pip. '
			+ 'Do NOT use for multi-step, reproducible, or input/output-tracked work - build an autopipe pipeline (autopipe MCP) for that instead. '
			+ 'Files the code writes are saved under the project `analysis/<run-id>/` folder (mounted locally on Windows/WSL, copied back elsewhere). '
			+ 'stdout is returned here (truncated if very large). Large results or images/plots are NOT shown in chat - tell the user to open them from `analysis/<run-id>/` in the Explorer.',
		inputSchema: {
			type: 'object',
			properties: {
				language: { type: 'string', description: 'Interpreter to run the code with. Python runs via uv.', enum: ['bash', 'python', 'node'] },
				code: { type: 'string', description: 'The full script source to run. It executes with its working directory set to the run folder, so relative output paths land in analysis/<run-id>/.' },
				dependencies: { type: 'array', description: 'Python packages to install for this run (e.g. ["scanpy", "leidenalg"]). Installed automatically via uv before the code runs. Python only; ignored for bash/node. Alternatively put a PEP 723 `# /// script` block in the code itself.', items: { type: 'string' } },
				timeout_s: { type: 'integer', description: 'Max seconds to allow the script to run (default 300, max 900). The first run that installs packages can take a while.' },
			},
			required: ['language', 'code'],
		},
		handler: async (args) => {
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

				const ep = await ensureBuiltinServer(); // boots the built-in server if needed
				const { ssh } = services();
				const spec = LANGS[language];
				const file = spec.file;
				const id = newRunId();

				// Decide where the run dir lives. On Windows the built-in server is WSL,
				// so write straight into analysis/<id>/ through the /mnt mount (outputs
				// are then already local). Elsewhere use a guest dir + SFTP copy after.
				const wsRoot = workspaceFolderPath();
				const mounted = process.platform === 'win32' && !!wsRoot;
				let runDirGuest: string;
				let localDir: string | undefined;
				if (mounted && wsRoot) {
					localDir = path.join(wsRoot, 'analysis', id);
					fs.mkdirSync(localDir, { recursive: true });
					runDirGuest = windowsToWsl(localDir);
				} else {
					runDirGuest = `$HOME/qoka-analysis/${id}`;
					await ssh.run(ep, `mkdir -p '${runDirGuest}'`);
				}

				// Python: inject the requested deps as PEP 723 metadata so `uv run`
				// installs them. Other languages run the source as-is.
				const source = language === 'python' ? injectPep723(code, deps) : code;
				await ssh.writeFile(ep, `${runDirGuest}/${file}`, source);
				// Build the exec: put uv/user-local bins on PATH (non-login SSH exec has
				// a bare PATH), self-heal uv for python, then run in the run dir.
				const ensure = language === 'python' ? `${ENSURE_UV}; ` : '';
				const r = await ssh.run(
					ep,
					`export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"; ${ensure}cd '${runDirGuest}' && ${spec.run(file)}`,
					{ timeoutMs },
				);

				// Persist stdout/stderr as files in the run dir too (useful for large output).
				if (mounted && localDir) {
					try { fs.writeFileSync(path.join(localDir, 'stdout.log'), r.stdout); } catch { /* best-effort */ }
					try { fs.writeFileSync(path.join(localDir, 'stderr.log'), r.stderr); } catch { /* best-effort */ }
				} else {
					try { await ssh.writeFile(ep, `${runDirGuest}/stdout.log`, r.stdout); } catch { /* best-effort */ }
					try { await ssh.writeFile(ep, `${runDirGuest}/stderr.log`, r.stderr); } catch { /* best-effort */ }
				}

				// List the files the run produced (regular files) for the summary.
				let produced: string[] = [];
				try {
					const ls = await ssh.run(ep, `cd '${runDirGuest}' && ls -1p 2>/dev/null | grep -v '/$' || true`);
					produced = ls.stdout.split('\n').map(s => s.trim()).filter(Boolean);
				} catch { /* best-effort */ }

				// Non-mounted built-in: copy the run dir into the project analysis/<id>/.
				let savedTo: string | undefined;
				if (mounted && localDir) {
					savedTo = localDir;
				} else if (wsRoot) {
					const dest = path.join(wsRoot, 'analysis', id);
					try {
						await copyRemoteDirToLocal(ep, runDirGuest, dest);
						savedTo = dest;
					} catch { /* best-effort - the files still exist in the guest run dir */ }
				}

				const lines: string[] = [];
				lines.push(`Ran ${language} on the built-in server (exit ${r.exitCode}).`);
				lines.push('');
				lines.push('stdout:');
				lines.push(r.stdout.trim() ? cap(r.stdout, STDOUT_CAP) : '(empty)');
				if (r.stderr.trim()) {
					lines.push('', 'stderr:', cap(r.stderr, STDERR_CAP));
				}
				if (produced.length) {
					lines.push('', `Files produced: ${produced.join(', ')}`);
				}
				if (savedTo) {
					lines.push('', `Results are in the project at analysis/${id}/ (${savedTo}).`);
					lines.push(`If a result is large or an image/plot (not shown above), tell the user to open it from the analysis/${id}/ folder in the Explorer.`);
				} else if (!wsRoot) {
					lines.push('', `No project folder is open, so results were left in the built-in server at ${runDirGuest}. Ask the user to open a folder to have results saved into analysis/.`);
				}
				return textResult(lines.join('\n'));
			} catch (err) {
				return errorResult(`run_code failed: ${(err as Error).message}`);
			}
		},
	},
];

/** Server-level guidance for the qoka-run MCP, surfaced to the model at `initialize`. */
export const RUN_MCP_INSTRUCTIONS = [
	'This server ("qoka-run") runs short, self-contained code on the Qoka built-in server for quick, one-off tasks.',
	'',
	'Routing: when the user asks to run code and it is unclear whether they want a quick one-off or a reproducible multi-step pipeline, ASK first: "즉시 실행할까요, 아니면 autopipe 파이프라인으로 만들까요?" (Run it now, or build an autopipe pipeline?).',
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
	'Do NOT mix the two (no pip for Python, no uv for non-Python tools). The FIRST run that installs a manager or packages can take a while - tell the user it is setting up, and raise timeout_s (up to 900) for large conda/bioconda environments.',
	'',
	'Results: run_code saves each run under the project\'s analysis/<run-id>/ folder. stdout is returned in chat. If a result is large or an image/plot, it is NOT in chat - tell the user to open it from analysis/<run-id>/ in the Explorer.',
].join('\n');
