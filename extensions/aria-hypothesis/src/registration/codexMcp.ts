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

const MCP_NAME = 'hypothesis';
const LEGACY_NAMES = ['aria-hypothesis'];

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

export interface RegistrationResult {
	ok: boolean;
	message: string;
	changed: boolean;
}

async function readRegisteredPort(codex: string): Promise<number | null> {
	try {
		const out = await execAsync(`${q(codex)} mcp list`, { timeout: 10000 });
		const lines = out.stdout.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const t = lines[i].trim();
			if (/(^|[^a-z-])hypothesis([^a-z-]|$)/i.test(t) && !LEGACY_NAMES.some(n => new RegExp(n, 'i').test(t))) {
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
 * Register hypothesis with the Codex CLI. Codex uses Streamable HTTP
 * (MCP protocol 2025-03-26+) at /mcp — different transport from Claude
 * Code's /sse.
 */
export async function registerWithCodex(port: number): Promise<RegistrationResult> {
	const codex = await resolveCodex();
	if (!codex) {
		return {
			ok: false, changed: false,
			message: 'Codex CLI not found.',
		};
	}
	const url = `http://127.0.0.1:${port}/mcp`;

	// Skip work when Codex is already pointed at our live port.
	const existingPort = await readRegisteredPort(codex);
	if (existingPort === port) {
		return { ok: true, changed: false, message: `Already registered -> ${url}` };
	}

	// Codex's mcp commands don't support per-scope flags (single user
	// config.toml), so a single remove per name is enough.
	for (const name of [MCP_NAME, ...LEGACY_NAMES]) {
		try {
			await execAsync(`${q(codex)} mcp remove ${name}`, { timeout: 10000 });
		} catch { /* not registered */ }
	}

	const addCmd = `${q(codex)} mcp add ${MCP_NAME} --url ${q(url)}`;
	// Aria's many extensions run `codex mcp add` concurrently, all writing the one
	// ~/.codex/config.toml. On Windows they collide on the file lock and fail with
	// "failed to persist config ... (os error 5 / access denied)". Retry a few
	// times with jittered backoff so contending writers each succeed in turn.
	let addErr = '';
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await execAsync(addCmd, { timeout: 10000 });
			addErr = '';
			break;
		} catch (err) {
			addErr = (err as { stderr?: string }).stderr ?? String(err);
			await new Promise(r => setTimeout(r, 120 + Math.floor(Math.random() * 400) * (attempt + 1)));
		}
	}
	if (addErr) {
		return { ok: false, changed: false, message: `codex mcp add failed: ${addErr.trim()}` };
	}

	try {
		const listOut = await execAsync(`${q(codex)} mcp list`, { timeout: 10000 });
		if (!listOut.stdout.includes(MCP_NAME)) {
			return {
				ok: false, changed: true,
				message: `Registered without error but "${MCP_NAME}" missing from \`codex mcp list\`.`,
			};
		}
	} catch { /* best-effort */ }

	return { ok: true, changed: true, message: `Registered ${MCP_NAME} -> ${url}` };
}

export async function unregisterFromCodex(): Promise<void> {
	const codex = await resolveCodex();
	if (!codex) {
		return;
	}
	for (const name of [MCP_NAME, ...LEGACY_NAMES]) {
		try {
			await execAsync(`${q(codex)} mcp remove ${name}`, { timeout: 10000 });
		} catch { /* best-effort */ }
	}
}

function q(s: string): string {
	if (/^[A-Za-z0-9_./:@-]+$/.test(s)) {
		return s;
	}
	return `"${s.replace(/"/g, '\\"')}"`;
}
