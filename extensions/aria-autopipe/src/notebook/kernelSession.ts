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
	private starting: Promise<void> | undefined;

	private readonly _onEvent = new vscode.EventEmitter<RelayEvent>();
	readonly onEvent = this._onEvent.event;
	private readonly _onExit = new vscode.EventEmitter<string | undefined>();
	readonly onExit = this._onExit.event;

	/** Human label of the target the kernel booted on (for the UI). */
	targetLabel = '';

	constructor(private readonly workspaceRoot: string) { }

	get isReady(): boolean { return this.ready; }

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

		const readyPromise = new Promise<void>((resolve) => {
			const d = this.onEvent(e => { if (e.type === 'ready' && !this.ready) { this.ready = true; d.dispose(); resolve(); } });
		});
		let setupErr = '';
		this.channel = await services().ssh.execPersistent(profile, cmd, {
			onStdout: (chunk) => this.ingest(chunk),
			onStderr: (chunk) => { setupErr += chunk; if (setupErr.length > 8000) { setupErr = setupErr.slice(-8000); } },
			onClose: () => { this.ready = false; this.channel = undefined; this._onExit.fire(setupErr.trim() || undefined); },
		});
		await Promise.race([
			readyPromise,
			new Promise<void>((_r, reject) => setTimeout(() => reject(new Error('The kernel did not become ready in time.' + (setupErr ? ' Setup log: ' + setupErr.slice(-500) : ''))), 300000)),
		]);
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
		try { this.send({ type: 'shutdown' }); } catch { /* ignore */ }
		try { this.channel?.close(); } catch { /* ignore */ }
		this.channel = undefined;
		this.ready = false;
		this._onEvent.dispose();
		this._onExit.dispose();
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
 * The one-line-per-statement shell script that boots the relay: ensure uv, create
 * a per-project notebook venv with ipykernel + jupyter_client, then exec the relay
 * from that venv. ALL setup output goes to stderr so stdout carries only the relay's
 * JSON protocol.
 */
function buildLaunch(profile: SshProfile, key: string): string {
	const b64 = Buffer.from(RELAY_PY, 'utf8').toString('base64');
	const workdir = profile.repo_path && profile.repo_path.trim() ? shq(profile.repo_path) : '"$HOME"';
	return [
		'export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"',
		`NBENV="$HOME/.qoka/nbenv/${key}"`,
		'command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$HOME/.local/bin" UV_NO_MODIFY_PATH=1 sh 1>&2',
		'if [ ! -x "$NBENV/bin/python" ]; then uv venv "$NBENV" 1>&2; fi',
		'"$NBENV/bin/python" -c "import jupyter_client, ipykernel" 2>/dev/null || uv pip install --python "$NBENV/bin/python" ipykernel jupyter_client 1>&2',
		'if [ ! -f "$NBENV/share/jupyter/kernels/python3/kernel.json" ]; then "$NBENV/bin/python" -m ipykernel install --sys-prefix --name python3 1>&2; fi',
		'export VIRTUAL_ENV="$NBENV"',
		'export PATH="$NBENV/bin:$PATH"',
		`mkdir -p ${workdir} 2>/dev/null || true`,
		`cd ${workdir} 2>/dev/null || cd "$HOME"`,
		`printf '%s' '${b64}' | base64 -d > "$NBENV/relay.py"`,
		'exec "$NBENV/bin/python" -u "$NBENV/relay.py"',
	].join('\n');
}
