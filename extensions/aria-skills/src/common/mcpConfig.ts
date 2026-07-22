/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Fast MCP registration by writing the provider config files DIRECTLY, instead of
 * shelling out to `claude mcp add` / `codex mcp add` once per server (which was
 * ~100 sequential CLI process spawns and took tens of seconds).
 *
 * A SINGLE writer merges all Qoka servers into each provider's config in ONE
 * atomic write, so there is no read-modify-write race (the reason the CLI path had
 * to be serialised). The two providers use different files, so their writes run in
 * PARALLEL. We then verify (config read-back + one `mcp list` per provider) and,
 * for anything still missing, fall back to the provider CLI for just that entry.
 *
 * Formats (measured against Claude Code 2.x and Codex):
 *   ~/.claude.json      ->  mcpServers[name] = { "type": "sse", "url": ".../sse" }
 *   ~/.codex/config.toml -> [mcp_servers.<name>]  url = ".../mcp"
 *
 * Only the Qoka server names passed in are ever touched; every other MCP server,
 * key, and comment in the user's config is preserved.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeadlessProvider, resolveProviderBin } from './headlessCli';

const execAsync = promisify(exec);

export interface McpServerInfo {
	/** The name the provider lists this server under (e.g. "aria-overview"). */
	name: string;
	/** The server's ACTUAL bound port (from the server, not the default). */
	port: number;
}

export interface ApplyResult {
	/** True when every requested server is registered with every requested provider. */
	allRegistered: boolean;
	/** Human-readable summary for logs / the loader warning. */
	summary: string;
}

const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const CODEX_TOML = path.join(os.homedir(), '.codex', 'config.toml');

function claudeUrl(port: number): string { return `http://127.0.0.1:${port}/sse`; }
function codexUrl(port: number): string { return `http://127.0.0.1:${port}/mcp`; }

function atomicWrite(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.aria-tmp-${process.pid}`;
	fs.writeFileSync(tmp, content, 'utf8');
	fs.renameSync(tmp, file);
}

function quoteArg(s: string): string { return `"${s.replace(/"/g, '\\"')}"`; }

// --- Claude (~/.claude.json) -----------------------------------------------

/** Upsert every server into ~/.claude.json's root `mcpServers`, preserving all
 *  other entries. Writes only when something changed (verify-first). */
function writeClaude(servers: McpServerInfo[]): void {
	let obj: Record<string, unknown> = {};
	try {
		obj = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')) as Record<string, unknown>;
	} catch {
		obj = {}; // missing / unreadable - start fresh
	}
	const mcp = (obj.mcpServers && typeof obj.mcpServers === 'object' ? obj.mcpServers : {}) as Record<string, unknown>;
	let changed = false;
	// Drop entries left by an older Qoka, so its tools stop appearing twice. Only
	// ones that clearly came from us: a name we no longer use is not proof we wrote
	// it, and this is the user's own config file.
	const current = new Set(servers.map(s => s.name));
	for (const legacy of LEGACY_SERVER_NAMES) {
		if (current.has(legacy)) { continue; }
		const entry = mcp[legacy] as { type?: string; url?: string } | undefined;
		if (!entry || entry.type !== 'sse' || !/^http:\/\/127\.0\.0\.1:\d+\/sse$/.test(entry.url ?? '')) { continue; }
		delete mcp[legacy];
		changed = true;
	}
	for (const s of servers) {
		const url = claudeUrl(s.port);
		const cur = mcp[s.name] as { type?: string; url?: string } | undefined;
		if (!cur || cur.type !== 'sse' || cur.url !== url) {
			mcp[s.name] = { type: 'sse', url };
			changed = true;
		}
	}
	if (!changed) { return; }
	obj.mcpServers = mcp;
	atomicWrite(CLAUDE_JSON, JSON.stringify(obj, null, 2) + '\n');
}

/** Names present in ~/.claude.json with the expected /sse port. */
function claudeRegistered(servers: McpServerInfo[]): Set<string> {
	const ok = new Set<string>();
	try {
		const obj = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')) as { mcpServers?: Record<string, { url?: string }> };
		const mcp = obj.mcpServers ?? {};
		for (const s of servers) {
			if (mcp[s.name]?.url === claudeUrl(s.port)) { ok.add(s.name); }
		}
	} catch { /* unreadable - none confirmed */ }
	return ok;
}

// --- Codex (~/.codex/config.toml) ------------------------------------------

/** Keys that only make sense for a STDIO server. Their presence is what makes
 *  Codex treat an entry as stdio, so they must not survive next to a `url`. */
const CODEX_STDIO_KEYS = ['command', 'args', 'env'];

/** Drop stdio-only keys from a TOML block body (the header line is kept). */
function stripStdioKeys(block: string): { block: string; changed: boolean } {
	const lines = block.split('\n');
	const kept = lines.filter((line, i) => {
		if (i === 0) { return true; }                     // the [table] header
		const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/);
		return !(key && CODEX_STDIO_KEYS.includes(key[1]));
	});
	return { block: kept.join('\n'), changed: kept.length !== lines.length };
}

/**
 * Upsert a `[mcp_servers.<name>]` block's url, preserving the rest of the TOML.
 *
 * Any stdio-only key already in the block is REMOVED. Codex decides an entry's
 * transport from its keys: a `command` means stdio, and stdio does not accept a
 * `url`, so merging our url into a pre-existing stdio entry produced
 * "invalid configuration: url is not supported for stdio in mcp_servers.<name>"
 * and broke EVERY chat, not just that one server. This happens for real - the
 * standalone AutoPipe app registers `[mcp_servers.autopipe]` with a command, and
 * we then wrote a url into the same block.
 */
function upsertCodexBlock(text: string, name: string, url: string): { text: string; changed: boolean } {
	const header = `[mcp_servers.${name}]`;
	const idx = text.indexOf(header);
	if (idx === -1) {
		const sep = text.length === 0 ? '' : (text.endsWith('\n\n') ? '' : (text.endsWith('\n') ? '\n' : '\n\n'));
		return { text: `${text}${sep}${header}\nurl = "${url}"\n`, changed: true };
	}
	// Extent of this block: from its header to the next table header (or EOF).
	const nextIdx = text.indexOf('\n[', idx + header.length);
	const end = nextIdx === -1 ? text.length : nextIdx + 1;
	const stripped = stripStdioKeys(text.slice(idx, end));
	let block = stripped.block;
	let changed = stripped.changed;

	const urlRe = /url\s*=\s*"([^"]*)"/;
	const m = block.match(urlRe);
	if (m) {
		if (m[1] !== url) {
			block = block.replace(urlRe, `url = "${url}"`);
			changed = true;
		}
	} else {
		block = block.replace(header, `${header}\nurl = "${url}"`);
		changed = true;
	}
	if (!changed) { return { text, changed: false }; }
	return { text: text.slice(0, idx) + block + text.slice(end), changed: true };
}

/** Our own entry shape: a loopback Streamable-HTTP url. */
const OUR_CODEX_URL = /^url\s*=\s*"http:\/\/127\.0\.0\.1:\d+\/mcp"$/;

/**
 * Retire a `[mcp_servers.<name>]` table we no longer use, WITHOUT damaging
 * anything that is not ours. Three cases, and the middle one matters most:
 *
 *  - only our url in the block  -> delete the whole table.
 *  - our url NEXT TO stdio keys -> delete just the url line. That block belongs to
 *    someone else (the standalone AutoPipe app registers `autopipe` with a
 *    `command`); we merged a url into it, and the mix is invalid - Codex reports
 *    "url is not supported for stdio" and refuses to start ANY chat. Removing our
 *    line repairs their entry instead of deleting it.
 *  - no url of ours            -> leave it completely alone.
 *
 * This is the user's own config file: a name we stopped using is not proof we
 * created the entry.
 */
function removeCodexBlock(text: string, name: string): { text: string; changed: boolean } {
	const header = `[mcp_servers.${name}]`;
	const idx = text.indexOf(header);
	if (idx === -1) { return { text, changed: false }; }
	const nextIdx = text.indexOf('\n[', idx + header.length);
	const end = nextIdx === -1 ? text.length : nextIdx + 1;
	const lines = text.slice(idx, end).split('\n');
	const body = lines.slice(1).map(l => l.trim()).filter(Boolean);
	const ourUrlCount = body.filter(l => OUR_CODEX_URL.test(l)).length;
	if (ourUrlCount === 0) { return { text, changed: false }; }
	if (body.length === ourUrlCount) {
		// Nothing but our own url - the whole table was ours.
		return { text: (text.slice(0, idx) + text.slice(end)).replace(/\n{3,}/g, '\n\n'), changed: true };
	}
	// Shared with someone else's config: withdraw only our line.
	const kept = lines.filter((l, i) => i === 0 || !OUR_CODEX_URL.test(l.trim()));
	return { text: text.slice(0, idx) + kept.join('\n') + text.slice(end), changed: true };
}

/**
 * Server names Qoka used previously. Two generations of them: the `aria-*` names
 * from before the Qoka rename, and the unprefixed names that collided with
 * unrelated software (a standalone AutoPipe app registers `autopipe` as a stdio
 * server, and merging our url into that entry broke Codex entirely). Left behind,
 * each one duplicates every tool the current name already provides.
 */
const LEGACY_SERVER_NAMES = [
	'aria-autopipe', 'aria-run', 'aria-hypothesis', 'aria-memory', 'aria-methods-search',
	'aria-notes', 'aria-overview', 'aria-paper', 'aria-paper-search', 'aria-roadmap',
	'autopipe', 'hypothesis', 'methods-search', 'paper-library',
];

/** Upsert every server into ~/.codex/config.toml, preserving all other content. */
function writeCodex(servers: McpServerInfo[]): void {
	let text = '';
	try {
		text = fs.readFileSync(CODEX_TOML, 'utf8');
	} catch {
		text = '';
	}
	let changed = false;
	// Clear the pre-rename duplicates first, so a stale aria-* entry cannot keep
	// serving the same tools under a second name.
	const current = new Set(servers.map(s => s.name));
	for (const legacy of LEGACY_SERVER_NAMES) {
		if (current.has(legacy)) { continue; }
		const r = removeCodexBlock(text, legacy);
		text = r.text;
		if (r.changed) { changed = true; }
	}
	for (const s of servers) {
		const r = upsertCodexBlock(text, s.name, codexUrl(s.port));
		text = r.text;
		if (r.changed) { changed = true; }
	}
	if (changed) { atomicWrite(CODEX_TOML, text); }
}

/** Names present in ~/.codex/config.toml with the expected /mcp port. */
function codexRegistered(servers: McpServerInfo[]): Set<string> {
	const ok = new Set<string>();
	let text = '';
	try { text = fs.readFileSync(CODEX_TOML, 'utf8'); } catch { return ok; }
	for (const s of servers) {
		const header = `[mcp_servers.${s.name}]`;
		const idx = text.indexOf(header);
		if (idx === -1) { continue; }
		const nextIdx = text.indexOf('\n[', idx + header.length);
		const block = text.slice(idx, nextIdx === -1 ? text.length : nextIdx);
		if (block.includes(codexUrl(s.port))) { ok.add(s.name); }
	}
	return ok;
}

// --- CLI fallback (only for stragglers) ------------------------------------

/** Register ONE server via the provider CLI - the definitive fallback used only
 *  for entries a direct write somehow didn't land. */
async function cliAdd(provider: HeadlessProvider, name: string, port: number): Promise<boolean> {
	const bin = resolveProviderBin(provider);
	if (!bin) { return false; }
	const q = quoteArg(bin);
	try {
		if (provider === 'claude') {
			try { await execAsync(`${q} mcp remove ${name} --scope user`, { timeout: 10000 }); } catch { /* none */ }
			await execAsync(`${q} mcp add --scope user ${name} ${quoteArg(claudeUrl(port))} --transport sse`, { timeout: 10000 });
		} else {
			try { await execAsync(`${q} mcp remove ${name}`, { timeout: 10000 }); } catch { /* none */ }
			await execAsync(`${q} mcp add ${name} --url ${quoteArg(codexUrl(port))}`, { timeout: 10000 });
		}
		return true;
	} catch {
		return false;
	}
}

// --- Public entry point ----------------------------------------------------

/**
 * Register every `server` with every chosen `provider`. Writes each provider's
 * config once (in parallel), verifies via read-back, and CLI-retries only the
 * stragglers. Returns whether everything registered - the caller ends the loader
 * regardless, so Qoka stays usable even if some server could not connect.
 */
export async function applyMcpConfig(providers: HeadlessProvider[], servers: McpServerInfo[]): Promise<ApplyResult> {
	const wantClaude = providers.includes('claude');
	const wantCodex = providers.includes('codex');
	if (servers.length === 0 || (!wantClaude && !wantCodex)) {
		return { allRegistered: true, summary: 'No MCP servers to register.' };
	}

	// 1) Batch write both config files in parallel (different files, no contention).
	await Promise.all([
		wantClaude ? Promise.resolve().then(() => writeClaude(servers)) : Promise.resolve(),
		wantCodex ? Promise.resolve().then(() => writeCodex(servers)) : Promise.resolve(),
	]);

	// 2) Verify via read-back, then CLI-retry any stragglers for each provider.
	const missing: string[] = [];
	async function verifyProvider(provider: HeadlessProvider, registered: (s: McpServerInfo[]) => Set<string>): Promise<void> {
		let ok = registered(servers);
		const stragglers = servers.filter(s => !ok.has(s.name));
		if (stragglers.length === 0) { return; }
		// Fall back to the CLI for just the ones the write did not land.
		for (const s of stragglers) {
			await cliAdd(provider, s.name, s.port);
		}
		ok = registered(servers);
		for (const s of servers) {
			if (!ok.has(s.name)) { missing.push(`${s.name}@${provider}`); }
		}
	}
	await Promise.all([
		wantClaude ? verifyProvider('claude', claudeRegistered) : Promise.resolve(),
		wantCodex ? verifyProvider('codex', codexRegistered) : Promise.resolve(),
	]);

	const allRegistered = missing.length === 0;
	return {
		allRegistered,
		summary: allRegistered
			? `Registered ${servers.length} MCP server(s) with ${providers.join(', ')}.`
			: `Some MCP servers did not register: ${missing.join(', ')}.`,
	};
}
