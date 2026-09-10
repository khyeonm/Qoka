/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { candidateClaudePaths, candidateCodexPaths } from '../detection/claudeCodeDetector';

const execAsync = promisify(exec);

/**
 * Built-in Penpot MCP (an editable-vector design tool, an open-source Figma). Unlike
 * BioRender this is NOT an OAuth server: Penpot authenticates the MCP with a personal
 * MCP KEY (token) the user generates in their Penpot account. Qoka stores that key in
 * SecretStorage and puts it in the MCP URL (`.../mcp/stream?userToken=<key>`), so
 * there is no browser OAuth, no startup browser storm, and Codex works too (no OAuth
 * metadata to trip over). The user connects once (guided from Settings); every later
 * startup re-registers from the stored key automatically.
 *
 * NOTE: The Penpot remote MCP draws into the design file the user currently has OPEN
 * and connected (File -> MCP Server -> Connect) - so registration alone is not enough
 * to draw; a file must be open. The Settings wizard spells that out.
 */

const NAME = 'penpot';
const DEFAULT_SERVER = 'https://design.penpot.app';
const SECRET_KEY = 'aria.penpot.key';
const STATE_SERVER = 'aria.penpot.serverUrl';

let penLog: vscode.OutputChannel | undefined;
function plog(msg: string): void {
	try { (penLog ??= vscode.window.createOutputChannel('Qoka Penpot')).appendLine(`[${new Date().toISOString()}] ${msg}`); } catch { /* noop */ }
	try { console.log('[penpot]', msg); } catch { /* noop */ }
}

export interface PenpotStatus { connected: boolean; serverUrl?: string; keyMask?: string }

/** Holds the Penpot MCP key (SecretStorage) and server URL (globalState). */
export class PenpotStore {
	constructor(private readonly secrets: vscode.SecretStorage, private readonly state: vscode.Memento) { }
	getKey(): Thenable<string | undefined> { return this.secrets.get(SECRET_KEY); }
	setKey(k: string): Thenable<void> { return this.secrets.store(SECRET_KEY, k); }
	clearKey(): Thenable<void> { return this.secrets.delete(SECRET_KEY); }
	getServer(): string { return this.state.get<string>(STATE_SERVER) || DEFAULT_SERVER; }
	setServer(u: string): Thenable<void> { return this.state.update(STATE_SERVER, u); }
}

function quoteArg(s: string): string {
	if (/^[A-Za-z0-9_./:-]+$/.test(s)) { return s; }
	return `"${s.replace(/"/g, '\\"')}"`;
}

async function resolveBinary(primary: string, candidates: string[]): Promise<string | null> {
	try { await execAsync(`${primary} --version`, { timeout: 5000 }); return primary; } catch { /* fall through */ }
	for (const c of candidates) {
		try { await execAsync(`"${c}" --version`, { timeout: 5000 }); return c; } catch { /* next */ }
	}
	return null;
}

function claudeCwd(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** The streamable-HTTP MCP endpoint with the user token embedded. */
function penpotUrl(server: string, key: string): string {
	return `${server.replace(/\/+$/, '')}/mcp/stream?userToken=${encodeURIComponent(key)}`;
}

// --- Claude ---

async function claudeCurrentUrl(claude: string, cwd: string): Promise<string | null> {
	try {
		const out = await execAsync(`${quoteArg(claude)} mcp get ${NAME}`, { timeout: 15000, cwd });
		const m = out.stdout.match(/https?:\/\/\S*userToken=\S+/i);
		return m ? m[0] : null;
	} catch { return null; }
}

async function claudeRemove(claude: string, cwd: string): Promise<void> {
	for (const scope of ['local', 'user', 'project']) {
		try { await execAsync(`${quoteArg(claude)} mcp remove --scope ${scope} ${NAME}`, { timeout: 15000, cwd }); } catch { /* not present */ }
	}
}

async function claudeAdd(claude: string, cwd: string, url: string): Promise<void> {
	await claudeRemove(claude, cwd);
	await execAsync(`${quoteArg(claude)} mcp add --scope local ${NAME} ${quoteArg(url)} --transport http`, { timeout: 15000, cwd });
}

// --- Codex (plain token URL, no OAuth - works unlike the BioRender case) ---

async function codexRemove(codex: string): Promise<void> {
	try { await execAsync(`${quoteArg(codex)} mcp remove ${NAME}`, { timeout: 10000 }); } catch { /* not present */ }
}

async function codexAdd(codex: string, url: string): Promise<void> {
	await codexRemove(codex);
	await execAsync(`${quoteArg(codex)} mcp add ${NAME} --url ${quoteArg(url)}`, { timeout: 10000 });
}

/**
 * Reconcile the Penpot MCP registration with the stored key:
 *  - key present -> register both CLIs with the token URL (local scope for Claude)
 *  - no key      -> remove any registration
 * Skips a needless remove-then-add when Claude already points at the same URL (avoids
 * the brief unregistered gap that would make the first chat session miss it).
 */
export async function ensurePenpotRegistered(store: PenpotStore): Promise<void> {
	const key = await store.getKey();
	const url = key ? penpotUrl(store.getServer(), key) : null;
	const cwd = claudeCwd();

	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (claude && cwd) {
		if (url) {
			const cur = await claudeCurrentUrl(claude, cwd);
			if (cur === url) {
				plog('ensureRegistered(claude): already registered with current key, leaving intact (no gap)');
			} else {
				try { await claudeAdd(claude, cwd, url); plog('ensureRegistered(claude): registered penpot (local scope)'); }
				catch (err) { plog(`ensureRegistered(claude): add failed: ${((err as { stderr?: string }).stderr ?? String(err)).slice(0, 200)}`); }
			}
		} else {
			await claudeRemove(claude, cwd); plog('ensureRegistered(claude): no key -> removed registration');
		}
	}

	const codex = await resolveBinary('codex', candidateCodexPaths());
	if (codex) {
		if (url) {
			try { await codexAdd(codex, url); plog('ensureRegistered(codex): registered penpot'); }
			catch (err) { plog(`ensureRegistered(codex): add failed: ${((err as { stderr?: string }).stderr ?? String(err)).slice(0, 200)}`); }
		} else {
			await codexRemove(codex); plog('ensureRegistered(codex): no key -> removed registration');
		}
	}
}

/** Store the key (and optional server URL) and register both CLIs. */
export async function connectPenpot(store: PenpotStore, key: string, serverUrl?: string): Promise<{ ok: boolean; message: string }> {
	const trimmed = key.trim();
	if (!trimmed) { return { ok: false, message: 'Enter your Penpot MCP key.' }; }
	if (serverUrl && serverUrl.trim()) { await store.setServer(serverUrl.trim()); }
	await store.setKey(trimmed);
	plog(`connect: stored key (server=${store.getServer()})`);
	await ensurePenpotRegistered(store);
	return { ok: true, message: 'Penpot connected. Open a NEW chat (or reload Qoka) to use it.' };
}

/** Drop the stored key and remove the registration from both CLIs. */
export async function disconnectPenpot(store: PenpotStore): Promise<void> {
	plog('disconnect: start');
	await store.clearKey();
	await ensurePenpotRegistered(store);
}

/** Remove any leftover `biorender` MCP registration from an older Qoka build. The
 *  BioRender integration was removed, but its registration can still sit in the user's
 *  Claude/Codex config and show up in /mcp. Best-effort and idempotent; run once at
 *  activation. */
export async function cleanupBioRenderRegistration(): Promise<void> {
	const cwd = claudeCwd();
	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (claude && cwd) {
		for (const scope of ['local', 'user', 'project']) {
			try { await execAsync(`${quoteArg(claude)} mcp remove --scope ${scope} biorender`, { timeout: 15000, cwd }); } catch { /* not present in this scope */ }
		}
	}
	const codex = await resolveBinary('codex', candidateCodexPaths());
	if (codex) { try { await execAsync(`${quoteArg(codex)} mcp remove biorender`, { timeout: 10000 }); } catch { /* not present */ } }
	plog('cleanupBioRender: removed any leftover biorender registration');
}

/** Connected when a key is stored. Returns a masked key for display + the server. */
export async function penpotStatus(store: PenpotStore): Promise<PenpotStatus> {
	const key = await store.getKey();
	if (!key) { return { connected: false, serverUrl: store.getServer() }; }
	const mask = key.length <= 4 ? '••••' : `••••••${key.slice(-4)}`;
	return { connected: true, serverUrl: store.getServer(), keyMask: mask };
}
