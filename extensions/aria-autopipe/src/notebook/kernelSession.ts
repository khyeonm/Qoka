/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { resolveRunTarget } from '../runtime/builtinServer';
import { services } from '../common/services';
import { SshProfile } from '../common/types';
import { PersistentChannel } from '../ssh/sshService';
import { RELAY_PY } from './relay';

/** One decoded JSON line from the relay (see relay.ts for the shapes). */
export interface RelayEvent { type: string; id?: string | null;[k: string]: unknown; }

/**
 * A live IPython kernel running in the active run environment (WSL/vfkit/SSH),
 * reached through a single persistent SSH exec channel that runs the Python
 * relay (relay.ts). One session per notebook document.
 */
export class KernelSession {
	private channel: PersistentChannel | undefined;
	private buf = '';
	private ready = false;
	private disposed = false;
	private starting: Promise<void> | undefined;

	private readonly _onEvent = new vscode.EventEmitter<RelayEvent>();
	readonly onEvent = this._onEvent.event;
	private readonly _onExit = new vscode.EventEmitter<string | undefined>();
	readonly onExit = this._onExit.event;
	private readonly _onSetupLog = new vscode.EventEmitter<string>();
	/** Live setup/stderr output emitted while the kernel is still starting. */
	readonly onSetupLog = this._onSetupLog.event;

	/** Human label of the target the kernel booted on (for the UI). */
	targetLabel = '';

	constructor(private readonly workspaceRoot: string) { }

	get isReady(): boolean { return this.ready; }
	get isDisposed(): boolean { return this.disposed; }

	/** Boot the kernel once; concurrent callers share the same start. */
	ensureStarted(): Promise<void> {
		if (this.ready) { return Promise.resolve(); }
		if (!this.starting) { this.starting = this.start().catch(e => { this.starting = undefined; throw e; }); }
		return this.starting;
	}

	private async start(): Promise<void> {
		const { profile, isBuiltIn } = await resolveRunTarget();
		this.targetLabel = isBuiltIn ? (process.platform === 'win32' ? 'Local (WSL)' : process.platform === 'darwin' ? 'Local (vfkit)' : 'Local (VM)') : `SSH: ${profile.host}`;
		const cmd = buildLaunch(profile, projectKey(this.workspaceRoot));

		let setupErr = '';
		const tail = () => setupErr.trim() ? ' Setup log: ' + setupErr.trim().slice(-800) : '';

		// Resolve on the relay's 'ready'; fail fast on a 'fatal' or an early channel
		// close (don't wait out the whole timeout when the kernel already died).
		const ready = new Promise<void>((resolve, reject) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const disp: vscode.Disposable[] = [];
			const done = (fn: () => void) => { if (!settled) { settled = true; for (const d of disp) { d.dispose(); } if (timer) { clearTimeout(timer); } fn(); } };
			disp.push(this.onEvent(e => {
				if (e.type === 'ready') { this.ready = true; done(resolve); }
				else if (e.type === 'fatal') { done(() => reject(new Error(String(e.error ?? 'the kernel failed to start') + tail()))); }
			}));
			disp.push(this.onExit(() => done(() => reject(new Error('The kernel process exited during startup.' + tail())))));
			timer = setTimeout(() => done(() => reject(new Error('The kernel did not become ready in time.' + tail()))), 300000);
		});

		this.channel = await services().ssh.execPersistent(profile, cmd, {
			onStdout: (chunk) => this.ingest(chunk),
			onStderr: (chunk) => { setupErr += chunk; if (setupErr.length > 8000) { setupErr = setupErr.slice(-8000); } if (!this.disposed) { this._onSetupLog.fire(chunk); } },
			onClose: () => { if (this.disposed) { return; } this.ready = false; this.channel = undefined; this._onExit.fire(setupErr.trim() || undefined); },
		});
		await ready;
	}

	/** Split the relay's line-delimited JSON stdout into events. */
	private ingest(chunk: string): void {
		this.buf += chunk;
		let nl: number;
		while ((nl = this.buf.indexOf('\n')) >= 0) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (!line) { continue; }
			try { this._onEvent.fire(JSON.parse(line) as RelayEvent); } catch { /* ignore non-JSON noise */ }
		}
	}

	execute(id: string, code: string): void { this.send({ type: 'execute', id, code }); }
	interrupt(): void { this.send({ type: 'interrupt' }); }
	restart(): void { this.ready = true; this.send({ type: 'restart' }); }

	private send(obj: unknown): void { this.channel?.write(JSON.stringify(obj) + '\n'); }

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		try { this.send({ type: 'shutdown' }); } catch { /* ignore */ }
		try { this.channel?.close(); } catch { /* ignore */ }
		this.channel = undefined;
		this.ready = false;
		this.starting = undefined;
		// Wake anything waiting on this session (an in-flight cell's onExit handler,
		// or an ensureStarted() still booting) so it stops NOW instead of hanging -
		// this is what makes Restart actually halt the running cell and its spinner.
		// Fire BEFORE tearing down the emitters, or listeners never receive it.
		try { this._onExit.fire(undefined); } catch { /* ignore */ }
		setTimeout(() => {
			try { this._onEvent.dispose(); } catch { /* ignore */ }
			try { this._onExit.dispose(); } catch { /* ignore */ }
			try { this._onSetupLog.dispose(); } catch { /* ignore */ }
		}, 0);
	}
}

/** Stable per-project key (slug + short hash), mirroring run_code's sandbox key. */
function projectKey(root: string): string {
	const base = (root.split(/[\\/]/).pop() || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
	// A tiny non-crypto hash is enough to disambiguate two same-named projects.
	let h = 0;
	for (let i = 0; i < root.length; i++) { h = (Math.imul(h, 31) + root.charCodeAt(i)) | 0; }
	return `${base}-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/** Shell single-quote a path safely. */
function shq(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }

/**
 * The one-line-per-statement shell script that boots the relay. It creates a
 * per-project notebook environment as a micromamba (conda) env so cells can install
 * with conda, uv, AND pip (all three target the SAME env): `!conda install ...` /
 * `!mamba install ...` for conda-forge/bioconda packages, `!uv pip install ...` for
 * fast PyPI installs, and `%pip install ...` for plain pip. It ensures micromamba +
 * uv, creates the env with python + pip + ipykernel + jupyter_client, activates it
 * so cell subprocesses install into it, then execs the relay from that env's python.
 * ALL setup output goes to stderr so stdout carries only the relay's JSON protocol.
 */
function buildLaunch(profile: SshProfile, key: string): string {
	const b64 = Buffer.from(RELAY_PY, 'utf8').toString('base64');
	const workdir = profile.repo_path && profile.repo_path.trim() ? shq(profile.repo_path) : '"$HOME"';
	return [
		'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"',
		'export MAMBA_ROOT_PREFIX="$HOME/.qoka/mamba"',
		`NBENV="$HOME/.qoka/nbenv/${key}"`,
		// micromamba (conda) - fetch the single static binary once if it is missing.
		// Download the raw binary directly (no tar/bzip2): the micro.mamba.pm archive is
		// .tar.bz2 and `tar -xj` needs a `bzip2` executable, which some run environments
		// (e.g. a minimal WSL) do not have - that made the whole kernel fail to start.
		'if ! command -v micromamba >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/micromamba" ]; then A="linux-64"; case "$(uname -m)" in aarch64|arm64) A="linux-aarch64";; esac; mkdir -p "$HOME/.local/bin"; curl -Ls "https://github.com/mamba-org/micromamba-releases/releases/latest/download/micromamba-$A" -o "$HOME/.local/bin/micromamba" 1>&2 && chmod +x "$HOME/.local/bin/micromamba" || true; fi',
		'MM="$(command -v micromamba 2>/dev/null || echo "$HOME/.local/bin/micromamba")"',
		'if [ ! -x "$MM" ]; then echo "[qoka] ERROR: micromamba is not available (download blocked?); conda/mamba will not work." 1>&2; fi',
		'echo "[qoka] micromamba: $MM" 1>&2',
		// Per-project conda env: python + pip + the kernel bits. Rebuild it when it is
		// missing OR when it is not a real conda env (e.g. a stale uv venv left by an
		// older build) - otherwise conda/mamba installs have nowhere to go.
		'if [ ! -x "$NBENV/bin/python" ] || [ ! -d "$NBENV/conda-meta" ]; then echo "[qoka] creating conda env at $NBENV (first run, a few minutes)…" 1>&2; rm -rf "$NBENV"; "$MM" create -y -p "$NBENV" -c conda-forge python pip ipykernel jupyter_client 1>&2; fi',
		// Expose conda/mamba command NAMES (micromamba is CLI-compatible for install).
		'ln -sf "$MM" "$NBENV/bin/mamba" 2>/dev/null || true; ln -sf "$MM" "$NBENV/bin/conda" 2>/dev/null || true',
		'echo "[qoka] env kind: $([ -d "$NBENV/conda-meta" ] && echo conda || echo NON-CONDA); conda -> $(readlink "$NBENV/bin/conda" 2>/dev/null || echo MISSING)" 1>&2',
		// uv for fast `!uv pip install` (targets the env via CONDA_PREFIX below).
		'command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$HOME/.local/bin" UV_NO_MODIFY_PATH=1 sh 1>&2',
		// Register the jupyter kernelspec inside the env.
		'if [ ! -f "$NBENV/share/jupyter/kernels/python3/kernel.json" ]; then "$NBENV/bin/python" -m ipykernel install --sys-prefix --name python3 1>&2; fi',
		// Activate the env so cell installs (conda/mamba/uv/pip) all target it.
		'eval "$("$MM" shell hook -s posix 2>/dev/null)" 2>/dev/null || true',
		'micromamba activate "$NBENV" 2>/dev/null || true',
		'export CONDA_PREFIX="$NBENV"; export CONDA_DEFAULT_ENV="$NBENV"; unset VIRTUAL_ENV',
		'export PATH="$NBENV/bin:$HOME/.local/bin:/usr/local/bin:$PATH"',
		`mkdir -p ${workdir} 2>/dev/null || true`,
		`cd ${workdir} 2>/dev/null || cd "$HOME"`,
		`printf '%s' '${b64}' | base64 -d > "$NBENV/relay.py"`,
		'exec "$NBENV/bin/python" -u "$NBENV/relay.py"',
	].join('\n');
}
