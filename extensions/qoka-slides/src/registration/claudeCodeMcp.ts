/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

/** Per-window isolation: register under the PROJECT (local) scope keyed by the
 *  open workspace so each Qoka window writes its OWN live port into
 *  projects[<workspace>] instead of one shared global entry. Falls back to user
 *  scope when no folder is open. */
function scopeOpts(): { scope: 'local' | 'user'; opts: { timeout: number; cwd?: string } } {
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return cwd
		? { scope: 'local', opts: { timeout: 10000, cwd } }
		: { scope: 'user', opts: { timeout: 10000 } };
}

/** Name Claude Code lists this MCP under. Must match the `name` returned by the
 *  server's `initialize` response so the user sees one consistent label. */
const MCP_NAME = 'qoka-slides';

export interface RegistrationResult {
	ok: boolean;
	message: string;
	/** True when this run actually (re)wrote the registration; false when it was
	 *  skipped because the client already pointed at our live port. */
	changed: boolean;
}

function candidateClaudePaths(): string[] {
	const home = os.homedir();
	const out: string[] = [];
	const direct = process.platform === 'win32'
		? [path.join(home, '.qoka', 'bin', 'claude.exe'), path.join(home, '.qoka', 'bin', 'claude.cmd')]
		: [path.join(home, '.qoka', 'bin', 'claude')];
	for (const p of direct) {
		try {
			if (fs.existsSync(p)) { out.push(p); }
		} catch { /* ignore */ }
	}
	return out;
}

async function resolveClaudeBinary(): Promise<string | null> {
	try {
		await execAsync('claude --version', { timeout: 5000 });
		return 'claude';
	} catch { /* fall through */ }
	for (const candidate of candidateClaudePaths()) {
		try {
			await execAsync(`"${candidate}" --version`, { timeout: 5000 });
			return candidate;
		} catch { /* try next */ }
	}
	return null;
}

async function readClaudeRegisteredPort(claude: string): Promise<number | null> {
	try {
		const { opts } = scopeOpts();
		const out = await execAsync(`${quoteArg(claude)} mcp get ${MCP_NAME}`, opts);
		const m = out.stdout.match(/127\.0\.0\.1:(\d+)/);
		return m ? parseInt(m[1], 10) : null;
	} catch {
		return null;
	}
}

/**
 * (Re-)register the Qoka Slides MCP server with Claude Code. Best-effort removes
 * any prior entry across scopes, then adds the current live port so the MCP is
 * reachable from the project Claude Code opens.
 */
export async function registerWithClaudeCode(port: number): Promise<RegistrationResult> {
	const claude = await resolveClaudeBinary();
	if (!claude) {
		return { ok: false, changed: false, message: 'Claude CLI not found on PATH or known install locations.' };
	}

	const url = `http://127.0.0.1:${port}/sse`;
	const q = quoteArg(claude);
	const { scope, opts } = scopeOpts();

	const existingPort = await readClaudeRegisteredPort(claude);
	if (existingPort === port) {
		return { ok: true, changed: false, message: `Already registered -> ${url}` };
	}

	for (const s of ['user', 'project', 'local']) {
		try {
			await execAsync(`${q} mcp remove ${MCP_NAME} --scope ${s}`, opts);
		} catch { /* no prior entry in this scope */ }
	}

	const addCmd = `${q} mcp add --scope ${scope} ${MCP_NAME} ${quoteArg(url)} --transport sse`;
	const runAdd = async (): Promise<{ ok: boolean; stderr: string }> => {
		try {
			await execAsync(addCmd, opts);
			return { ok: true, stderr: '' };
		} catch (e) {
			return { ok: false, stderr: (e as { stderr?: string }).stderr ?? String(e) };
		}
	};

	let addResult = await runAdd();
	if (!addResult.ok && /already exists/i.test(addResult.stderr)) {
		// Race: several Qoka extensions touch the same ~/.claude.json from
		// concurrent CLI invocations. Re-remove after a short jitter and retry.
		try {
			await execAsync(`${q} mcp remove ${MCP_NAME} --scope ${scope}`, opts);
		} catch { /* likely already gone */ }
		await new Promise(r => setTimeout(r, 500));
		addResult = await runAdd();
	}
	if (!addResult.ok) {
		return { ok: false, changed: false, message: `claude mcp add failed: ${addResult.stderr.trim()}` };
	}

	return { ok: true, changed: true, message: `Registered ${MCP_NAME} -> ${url}` };
}

export async function unregisterFromClaudeCode(): Promise<void> {
	const claude = await resolveClaudeBinary();
	if (!claude) { return; }
	const q = quoteArg(claude);
	const { opts } = scopeOpts();
	for (const scope of ['user', 'project', 'local']) {
		try {
			await execAsync(`${q} mcp remove ${MCP_NAME} --scope ${scope}`, opts);
		} catch { /* best-effort */ }
	}
}

function quoteArg(s: string): string {
	if (/^[A-Za-z0-9_./:-]+$/.test(s)) {
		return s;
	}
	return `"${s.replace(/"/g, '\\"')}"`;
}
