/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

/** Name Claude Code lists this MCP under. Must match the `name` returned by
 *  the server's `initialize` response so the user sees one consistent label. */
const MCP_NAME = 'qoka-paper';

export interface RegistrationResult {
	ok: boolean;
	message: string;
	/** True when this run actually (re)wrote the registration; false when it
	 *  was skipped because the client already pointed at our live port. */
	changed: boolean;
}

/**
 * Shell-installed locations the Claude CLI lands in. The Qoka launcher
 * inherits a minimal PATH that often misses these; mirrors the candidate
 * list used by Qoka's other MCP extensions so behaviour stays consistent.
 */
function candidateClaudePaths(): string[] {
	const home = os.homedir();
	const out: string[] = [];
	const direct = [
		'/usr/local/bin/claude',
		'/opt/homebrew/bin/claude',
		path.join(home, '.local/bin', 'claude'),
		path.join(home, 'bin', 'claude'),
		path.join(home, '.claude/local/claude'),
	];
	for (const p of direct) {
		try {
			if (fs.existsSync(p)) { out.push(p); }
		} catch { /* ignore */ }
	}
	const nvm = path.join(home, '.nvm/versions/node');
	try {
		if (fs.existsSync(nvm)) {
			for (const ver of fs.readdirSync(nvm)) {
				const p = path.join(nvm, ver, 'bin', 'claude');
				try {
					if (fs.existsSync(p)) { out.push(p); }
				} catch { /* ignore */ }
			}
		}
	} catch { /* ignore */ }
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
		const out = await execAsync(`${quoteArg(claude)} mcp get ${MCP_NAME}`, { timeout: 10000 });
		const m = out.stdout.match(/127\.0\.0\.1:(\d+)/);
		return m ? parseInt(m[1], 10) : null;
	} catch {
		return null;
	}
}

/**
 * (Re-)register the Qoka Paper MCP server with Claude Code. Mirrors the other
 * Qoka MCP extensions: best-effort removes any prior entry across all three
 * scopes, then adds the current live port at --scope user so the MCP is
 * reachable from every project Claude Code opens.
 */
export async function registerWithClaudeCode(port: number): Promise<RegistrationResult> {
	console.log(`[aria-paper] registerWithClaudeCode(port=${port}) starting`);
	const claude = await resolveClaudeBinary();
	if (!claude) {
		console.error('[aria-paper] Claude CLI not found in PATH or candidate locations');
		return { ok: false, changed: false, message: 'Claude CLI not found on PATH or known install locations.' };
	}
	console.log(`[aria-paper] Claude CLI resolved to: ${claude}`);

	const url = `http://127.0.0.1:${port}/sse`;
	const q = quoteArg(claude);

	const existingPort = await readClaudeRegisteredPort(claude);
	if (existingPort === port) {
		console.log(`[aria-paper] Claude Code already registered on port ${port}; skipping re-registration`);
		return { ok: true, changed: false, message: `Already registered -> ${url}` };
	}

	for (const scope of ['user', 'project', 'local']) {
		try {
			const out = await execAsync(`${q} mcp remove ${MCP_NAME} --scope ${scope}`, { timeout: 10000 });
			console.log(`[aria-paper] removed prior MCP entry --scope ${scope}:`, out.stdout.trim());
		} catch (e) {
			console.log(`[aria-paper] no prior MCP entry --scope ${scope}:`, (e as Error).message);
		}
	}

	const addCmd = `${q} mcp add --scope user ${MCP_NAME} ${quoteArg(url)} --transport sse`;
	console.log(`[aria-paper] running: ${addCmd}`);
	const runAdd = async (): Promise<{ ok: boolean; stderr: string }> => {
		try {
			const out = await execAsync(addCmd, { timeout: 10000 });
			console.log(`[aria-paper] mcp add stdout:`, out.stdout.trim());
			console.log(`[aria-paper] mcp add stderr:`, out.stderr.trim());
			return { ok: true, stderr: '' };
		} catch (e) {
			const stderr = (e as { stderr?: string }).stderr ?? String(e);
			return { ok: false, stderr };
		}
	};

	let addResult = await runAdd();
	if (!addResult.ok && /already exists/i.test(addResult.stderr)) {
		// Race: several Qoka MCP extensions touch the same `~/.claude.json`
		// from concurrent CLI invocations. Re-remove after a short jitter and
		// retry the add once.
		console.warn('[aria-paper] mcp add raced with another writer; retrying after re-remove');
		try {
			await execAsync(`${q} mcp remove ${MCP_NAME} --scope user`, { timeout: 10000 });
		} catch (e) {
			console.log(`[aria-paper] retry-remove failed (likely already gone):`, (e as Error).message);
		}
		await new Promise(r => setTimeout(r, 500));
		addResult = await runAdd();
	}
	if (!addResult.ok) {
		console.error(`[aria-paper] claude mcp add failed:`, addResult.stderr);
		return { ok: false, changed: false, message: `claude mcp add failed: ${addResult.stderr.trim()}` };
	}

	try {
		const listOut = await execAsync(`${q} mcp list`, { timeout: 10000 });
		if (!listOut.stdout.includes(MCP_NAME)) {
			return {
				ok: false,
				changed: true,
				message: `Registered with no error but "${MCP_NAME}" missing from \`claude mcp list\`.`,
			};
		}
	} catch (e) {
		console.warn(`[aria-paper] claude mcp list verification failed:`, e);
	}

	return { ok: true, changed: true, message: `Registered ${MCP_NAME} -> ${url}` };
}

export async function unregisterFromClaudeCode(): Promise<void> {
	const claude = await resolveClaudeBinary();
	if (!claude) { return; }
	const q = quoteArg(claude);
	for (const scope of ['user', 'project', 'local']) {
		try {
			await execAsync(`${q} mcp remove ${MCP_NAME} --scope ${scope}`, { timeout: 10000 });
		} catch { /* best-effort */ }
	}
}

function quoteArg(s: string): string {
	if (/^[A-Za-z0-9_./:-]+$/.test(s)) {
		return s;
	}
	return `"${s.replace(/"/g, '\\"')}"`;
}
