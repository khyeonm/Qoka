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
 * whirick MCP (the slide app the Slides tab embeds). It is a standard OAuth-protected
 * remote MCP (RFC 9728 / 8414 + Dynamic Client Registration), already deployed at the
 * fixed URL below, so Qoka just registers the bare URL with both AI CLIs at startup.
 * The CLIs drive the OAuth themselves - they self-register a client via DCR and open a
 * browser for the user to approve the first time whirick is used - so there is no key
 * to store or inject and no whirick-server change is needed.
 */

const NAME = 'whirick';
const SERVER_URL = 'https://slides.pnucolab.com/mcp';

let wLog: vscode.OutputChannel | undefined;
function wlog(msg: string): void {
	try { (wLog ??= vscode.window.createOutputChannel('Qoka Slides MCP')).appendLine(`[${new Date().toISOString()}] ${msg}`); } catch { /* noop */ }
	try { console.log('[whirick]', msg); } catch { /* noop */ }
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

async function claudeHasWhirick(claude: string, cwd: string): Promise<boolean> {
	try {
		const out = await execAsync(`${quoteArg(claude)} mcp get ${NAME}`, { timeout: 15000, cwd });
		return out.stdout.includes(SERVER_URL);
	} catch { return false; }
}

async function claudeAdd(claude: string, cwd: string): Promise<void> {
	// Idempotent: skip if already pointing at the same URL (avoids dropping an
	// already-authorized OAuth registration and re-triggering the browser prompt).
	if (await claudeHasWhirick(claude, cwd)) { return; }
	for (const scope of ['local', 'user', 'project']) {
		try { await execAsync(`${quoteArg(claude)} mcp remove --scope ${scope} ${NAME}`, { timeout: 15000, cwd }); } catch { /* not present */ }
	}
	await execAsync(`${quoteArg(claude)} mcp add --scope local ${NAME} ${quoteArg(SERVER_URL)} --transport http`, { timeout: 15000, cwd });
}

async function codexHasWhirick(codex: string): Promise<boolean> {
	try {
		const out = await execAsync(`${quoteArg(codex)} mcp get ${NAME}`, { timeout: 10000 });
		return out.stdout.includes(SERVER_URL);
	} catch { return false; }
}

async function codexAdd(codex: string): Promise<void> {
	if (await codexHasWhirick(codex)) { return; }
	try { await execAsync(`${quoteArg(codex)} mcp remove ${NAME}`, { timeout: 10000 }); } catch { /* not present */ }
	await execAsync(`${quoteArg(codex)} mcp add ${NAME} --url ${quoteArg(SERVER_URL)}`, { timeout: 10000 });
}

/**
 * Register the whirick MCP (bare OAuth URL) with both CLIs, idempotently. The CLIs
 * handle the OAuth handshake on first use. Best-effort per provider.
 */
export async function ensureWhirickRegistered(): Promise<void> {
	const cwd = claudeCwd();
	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (claude && cwd) {
		try { await claudeAdd(claude, cwd); wlog('registered whirick with Claude (local scope)'); }
		catch (err) { wlog(`claude add failed: ${((err as { stderr?: string }).stderr ?? String(err)).slice(0, 200)}`); }
	}
	const codex = await resolveBinary('codex', candidateCodexPaths());
	if (codex) {
		try { await codexAdd(codex); wlog('registered whirick with Codex'); }
		catch (err) { wlog(`codex add failed: ${((err as { stderr?: string }).stderr ?? String(err)).slice(0, 200)}`); }
	}
}
