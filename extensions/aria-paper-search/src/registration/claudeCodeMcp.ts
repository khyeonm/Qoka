/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

const MCP_NAME = 'paper-library';
// Older Aria builds may have registered under "aria-paper-library" or
// similar; sweep both on startup so the user doesn't end up with stale
// duplicates.
const LEGACY_NAMES = ['aria-paper-library', 'paper-search'];

const CLAUDE_CANDIDATES = [
	'claude',
	'/usr/local/bin/claude',
	'/opt/homebrew/bin/claude',
	path.join(os.homedir(), '.local/bin/claude'),
	path.join(os.homedir(), '.claude/local/claude'),
];

async function resolveClaude(): Promise<string | null> {
	// Probe the NVM installs FIRST — that's where Claude Code's npm
	// install lands on this user's machine, and PATH-based lookup is
	// flaky from inside a shell-restricted child process. Try the well-
	// known fixed paths next, then `claude` as a last resort.
	const nvmDir = path.join(os.homedir(), '.nvm/versions/node');
	if (fs.existsSync(nvmDir)) {
		try {
			for (const ver of fs.readdirSync(nvmDir)) {
				const candidate = path.join(nvmDir, ver, 'bin/claude');
				if (fs.existsSync(candidate)) {
					console.log(`[aria-paper-search] resolveClaude -> ${candidate} (NVM)`);
					return candidate;
				}
			}
		} catch { /* ignore */ }
	}
	for (const candidate of CLAUDE_CANDIDATES) {
		try {
			await execAsync(`"${candidate}" --version`, { timeout: 3000 });
			console.log(`[aria-paper-search] resolveClaude -> ${candidate} (candidate)`);
			return candidate;
		} catch { /* try next */ }
	}
	console.warn('[aria-paper-search] resolveClaude -> null (claude CLI not found)');
	return null;
}

export interface RegistrationResult {
	ok: boolean;
	message: string;
	changed: boolean;
}

/**
 * Read paper-library's port from ~/.claude.json's USER-scope mcpServers
 * (i.e. the top-level `mcpServers` object, not any per-project block).
 * Returns null when the entry is missing, malformed, or doesn't point
 * at a 127.0.0.1 URL.
 *
 * Reading the JSON directly is more precise than parsing `claude mcp
 * list` output: the CLI mixes scopes in its output, which lets
 * project-scope leftovers pass our "is it already registered?" check
 * even though Claude Code sessions in other cwds can't see them.
 */
function readUserScopeRegisteredPort(): number | null {
	const configPath = path.join(os.homedir(), '.claude.json');
	if (!fs.existsSync(configPath)) {
		console.log(`[aria-paper-search] readUserScopeRegisteredPort: ${configPath} does not exist`);
		return null;
	}
	try {
		const raw = fs.readFileSync(configPath, 'utf8');
		const data = JSON.parse(raw) as {
			mcpServers?: Record<string, { url?: string }>;
		};
		const mcpKeys = Object.keys(data?.mcpServers ?? {});
		console.log(`[aria-paper-search] readUserScopeRegisteredPort: mcpServers keys = [${mcpKeys.join(', ')}]`);
		const entry = data?.mcpServers?.[MCP_NAME];
		if (entry === undefined) {
			console.log(`[aria-paper-search] readUserScopeRegisteredPort: "${MCP_NAME}" not in mcpServers`);
			return null;
		}
		console.log(`[aria-paper-search] readUserScopeRegisteredPort: entry = ${JSON.stringify(entry)}`);
		const url = entry?.url;
		if (typeof url !== 'string') {
			return null;
		}
		const m = url.match(/127\.0\.0\.1:(\d+)/);
		return m ? parseInt(m[1], 10) : null;
	} catch (err) {
		console.error(`[aria-paper-search] readUserScopeRegisteredPort error:`, (err as Error).message);
		return null;
	}
}

async function readRegisteredPort(claude: string): Promise<number | null> {
	try {
		const out = await execAsync(`${q(claude)} mcp list`, { timeout: 10000 });
		const lines = out.stdout.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const t = lines[i].trim();
			if (t.startsWith(`${MCP_NAME}:`) || t === MCP_NAME) {
				for (let j = i; j < Math.min(i + 3, lines.length); j++) {
					const m = lines[j].match(/127\.0\.0\.1:(\d+)/);
					if (m) {
						return parseInt(m[1], 10);
					}
				}
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Register the paper-library MCP server with the Claude Code CLI. Uses
 * the HTTP+SSE transport endpoint (/sse), distinct from Codex's
 * Streamable HTTP endpoint at /mcp.
 */
export async function registerWithClaudeCode(port: number): Promise<RegistrationResult> {
	console.log(`[aria-paper-search] registerWithClaudeCode(port=${port}) starting`);
	const claude = await resolveClaude();
	if (!claude) {
		return {
			ok: false, changed: false,
			message: 'Claude CLI not found. Install the Claude Code extension to register paper-library.',
		};
	}
	const url = `http://127.0.0.1:${port}/sse`;

	// Skip work when the USER-scope entry already points at our live
	// port. We deliberately ignore project/local scope here — those
	// can satisfy the old `claude mcp list` check while still leaving
	// Claude Code sessions in other working directories unable to see
	// the MCP. Only the user-scope record is universally visible.
	const userScopePort = readUserScopeRegisteredPort();
	console.log(`[aria-paper-search] existing paper-library port (user scope) = ${userScopePort}`);
	if (userScopePort === port) {
		return { ok: true, changed: false, message: `Already registered -> ${url}` };
	}

	// Best-effort removal across all three scopes. `claude mcp add`
	// defaults to "local" (per-project) — without the scope cleanup
	// below, registrations land in whatever project the Aria process
	// was launched from, and Claude Code sessions opened in other
	// directories can't see the MCP. We clear user/project/local so
	// the next add lands without duplicates.
	for (const name of [MCP_NAME, ...LEGACY_NAMES]) {
		for (const scope of ['user', 'project', 'local']) {
			try {
				await execAsync(`${q(claude)} mcp remove ${name} --scope ${scope}`, { timeout: 10000 });
				console.log(`[aria-paper-search] removed prior entry "${name}" --scope ${scope}`);
			} catch { /* "No MCP server found" expected — silent */ }
		}
	}

	// `--scope user` writes to the per-user config so paper-library is
	// visible to Claude Code sessions regardless of the working
	// directory. autopipe uses the same scope for the same reason.
	const addCmd = `${q(claude)} mcp add ${MCP_NAME} --scope user --transport sse ${q(url)}`;
	console.log(`[aria-paper-search] running: ${addCmd}`);
	try {
		const out = await execAsync(addCmd, { timeout: 10000 });
		console.log(`[aria-paper-search] claude mcp add stdout: ${out.stdout.trim()}`);
		if (out.stderr) {
			console.log(`[aria-paper-search] claude mcp add stderr: ${out.stderr.trim()}`);
		}
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr ?? String(err);
		console.error(`[aria-paper-search] claude mcp add failed: ${stderr.trim()}`);
		return { ok: false, changed: false, message: `claude mcp add failed: ${stderr.trim()}` };
	}

	try {
		const listOut = await execAsync(`${q(claude)} mcp list`, { timeout: 10000 });
		if (!listOut.stdout.includes(MCP_NAME)) {
			return {
				ok: false, changed: true,
				message: `Registered without error but "${MCP_NAME}" missing from \`claude mcp list\`.`,
			};
		}
	} catch { /* verification best-effort */ }

	return { ok: true, changed: true, message: `Registered ${MCP_NAME} -> ${url}` };
}

export async function unregisterFromClaudeCode(): Promise<void> {
	const claude = await resolveClaude();
	if (!claude) {
		return;
	}
	for (const name of [MCP_NAME, ...LEGACY_NAMES]) {
		try {
			await execAsync(`${q(claude)} mcp remove ${name}`, { timeout: 10000 });
		} catch { /* best-effort */ }
	}
}

function q(s: string): string {
	if (/^[A-Za-z0-9_./:@-]+$/.test(s)) {
		return s;
	}
	return `"${s.replace(/"/g, '\\"')}"`;
}
