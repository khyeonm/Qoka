/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { RegistrationResult } from './claudeCodeMcp';

const execAsync = promisify(exec);

const MCP_NAME = 'aria-memory';

const CODEX_CANDIDATES = [
	'codex',
	'/usr/local/bin/codex',
	'/opt/homebrew/bin/codex',
	path.join(os.homedir(), '.local/bin/codex'),
	// Windows: `npm install -g` drops codex as a .cmd shim at the npm prefix root
	// (Aria-managed ~/.aria/npm, or the OS default %APPDATA%/npm) — neither is on
	// the GUI process PATH, so probe them directly or Codex MCP never registers.
	path.join(os.homedir(), '.aria', 'npm', 'codex.cmd'),
	path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'codex.cmd'),
];

async function resolveCodex(): Promise<string | null> {
	for (const candidate of CODEX_CANDIDATES) {
		try {
			// Bare command names (no path separator) must run UNQUOTED so Windows
			// cmd.exe resolves them via PATH + PATHEXT (codex.cmd, an npm shim).
			// Quoting is only needed for full paths with spaces. This mirrors
			// autopipe, whose unquoted probe is the one that registers Codex on
			// Windows where the quoted `.cmd` form fails.
			const probe = /[\\/]/.test(candidate) ? `"${candidate}" --version` : `${candidate} --version`;
			await execAsync(probe, { timeout: 3000 });
			return candidate;
		} catch { /* try next */ }
	}
	const nvmDir = path.join(os.homedir(), '.nvm/versions/node');
	if (fs.existsSync(nvmDir)) {
		try {
			for (const ver of fs.readdirSync(nvmDir)) {
				const candidate = path.join(nvmDir, ver, 'bin/codex');
				if (fs.existsSync(candidate)) {
					return candidate;
				}
			}
		} catch { /* ignore */ }
	}
	return null;
}

async function readRegisteredPort(codex: string): Promise<number | null> {
	try {
		const out = await execAsync(`${q(codex)} mcp list`, { timeout: 10000 });
		const lines = out.stdout.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const t = lines[i].trim();
			if (t.startsWith(`${MCP_NAME}:`) || t === MCP_NAME || new RegExp(`(^|[^a-z-])${MCP_NAME}([^a-z-]|$)`, 'i').test(t)) {
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
 * Register aria-memory with the Codex CLI over Streamable HTTP at /mcp.
 * The aria-memory MCP server serves both /sse (Claude) and /mcp.
 */
export async function registerWithCodex(port: number): Promise<RegistrationResult> {
	const codex = await resolveCodex();
	if (!codex) {
		return { ok: false, changed: false, message: 'Codex CLI not found.' };
	}
	const url = `http://127.0.0.1:${port}/mcp`;

	const existingPort = await readRegisteredPort(codex);
	if (existingPort === port) {
		return { ok: true, changed: false, message: `Already registered -> ${url}` };
	}

	try {
		await execAsync(`${q(codex)} mcp remove ${MCP_NAME}`, { timeout: 10000 });
	} catch { /* not registered */ }

	const addCmd = `${q(codex)} mcp add ${MCP_NAME} --url ${q(url)}`;
	try {
		await execAsync(addCmd, { timeout: 10000 });
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr ?? String(err);
		return { ok: false, changed: false, message: `codex mcp add failed: ${stderr.trim()}` };
	}

	return { ok: true, changed: true, message: `Registered ${MCP_NAME} -> ${url}` };
}

export async function unregisterFromCodex(): Promise<void> {
	const codex = await resolveCodex();
	if (!codex) {
		return;
	}
	try {
		await execAsync(`${q(codex)} mcp remove ${MCP_NAME}`, { timeout: 10000 });
	} catch { /* best-effort */ }
}

function q(s: string): string {
	if (/^[A-Za-z0-9_./:@-]+$/.test(s)) {
		return s;
	}
	return `"${s.replace(/"/g, '\\"')}"`;
}
