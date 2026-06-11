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
const LEGACY_NAMES = ['aria-paper-library', 'paper-search'];

const CODEX_CANDIDATES = [
	'codex',
	'/usr/local/bin/codex',
	'/opt/homebrew/bin/codex',
	path.join(os.homedir(), '.local/bin/codex'),
];

async function resolveCodex(): Promise<string | null> {
	for (const candidate of CODEX_CANDIDATES) {
		try {
			await execAsync(`"${candidate}" --version`, { timeout: 3000 });
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
			if (/(^|[^a-z-])paper-library([^a-z-]|$)/i.test(t) && !LEGACY_NAMES.some(n => new RegExp(n, 'i').test(t))) {
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
 * Register paper-library with the Codex CLI. Codex uses Streamable HTTP
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

	// Skip work when Codex is already pointed at our live port. Codex
	// uses a single user-scope config (config.toml), so `mcp list`
	// reading is sufficient — no per-project leakage to worry about
	// the way Claude Code has.
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
	try {
		await execAsync(addCmd, { timeout: 10000 });
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr ?? String(err);
		return { ok: false, changed: false, message: `codex mcp add failed: ${stderr.trim()}` };
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
