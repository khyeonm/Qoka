/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Read-only peeks at the Claude / Codex MCP config FILES, so startup can tell
 * "already registered with this exact URL" (or "not registered anywhere") without
 * spawning the CLI - each `claude mcp get` costs 4-6s on Windows. Writes still go
 * through the CLI.
 *
 * Every function returns `undefined` when it cannot be sure (file unreadable, format
 * not recognized, this project's entry not found). Callers then fall back to the CLI,
 * so a format change in a future CLI version costs speed, never correctness.
 */

function claudeConfigFile(): string {
	return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.qoka', 'claude'), '.claude.json');
}

function codexConfigFile(): string {
	return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.qoka', 'codex'), 'config.toml');
}

/** Normalize a project path the way it may appear as a `.claude.json` projects key
 *  (Windows: either slash direction, any drive-letter case). */
function normProjectPath(p: string): string {
	let n = p.replace(/\\/g, '/').replace(/\/+$/, '');
	if (process.platform === 'win32') { n = n.toLowerCase(); }
	return n;
}

type ServerMap = Record<string, { url?: unknown } | undefined>;

/**
 * The URLs `name` is registered with for Claude in `cwd`, across the three scopes
 * `claude mcp get` would report: user (top-level mcpServers), local (this project's
 * block in .claude.json) and project (<cwd>/.mcp.json). An empty list means "not
 * registered in any scope". `undefined` means unknown - use the CLI.
 */
export function claudeRegisteredUrls(name: string, cwd: string): string[] | undefined {
	try {
		const file = claudeConfigFile();
		if (!fs.existsSync(file)) { return undefined; }
		const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: ServerMap; projects?: Record<string, { mcpServers?: ServerMap } | undefined> };
		if (!data || typeof data !== 'object') { return undefined; }
		const urls: string[] = [];
		const collect = (m: ServerMap | undefined): boolean => {
			if (m === undefined) { return true; }
			if (!m || typeof m !== 'object') { return false; }
			const e = m[name];
			if (e === undefined) { return true; }
			if (!e || typeof e.url !== 'string') { return false; } // present but not a URL entry: unknown
			urls.push(e.url);
			return true;
		};
		if (!collect(data.mcpServers)) { return undefined; }
		// Local scope: this project's block. Without it we cannot rule a local entry out.
		const want = normProjectPath(cwd);
		const key = Object.keys(data.projects ?? {}).find(k => normProjectPath(k) === want);
		if (key === undefined) { return undefined; }
		if (!collect(data.projects![key]?.mcpServers)) { return undefined; }
		// Project scope: <cwd>/.mcp.json.
		const projFile = path.join(cwd, '.mcp.json');
		if (fs.existsSync(projFile)) {
			const proj = JSON.parse(fs.readFileSync(projFile, 'utf8')) as { mcpServers?: ServerMap };
			if (!collect(proj?.mcpServers)) { return undefined; }
		}
		return urls;
	} catch {
		return undefined;
	}
}

/**
 * The URL `name` is registered with for Codex (`[mcp_servers.<name>]` in config.toml),
 * `null` when it is not registered, `undefined` when unknown - use the CLI.
 */
export function codexRegisteredUrl(name: string): string | null | undefined {
	try {
		const file = codexConfigFile();
		if (!fs.existsSync(file)) { return null; }
		const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
		const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*("?)${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\1\\s*\\]\\s*$`);
		const start = lines.findIndex(l => header.test(l));
		if (start === -1) {
			// Not as a table header. An inline form (`mcp_servers = { ... }`) would also be
			// valid TOML; if the name appears at all, say unknown rather than "absent".
			return lines.some(l => l.includes(name)) ? undefined : null;
		}
		for (let i = start + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) {
			const m = lines[i].match(/^\s*url\s*=\s*"([^"\\]*)"\s*(#.*)?$/);
			if (m) { return m[1]; }
		}
		return undefined;
	} catch {
		return undefined;
	}
}
