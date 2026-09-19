/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { candidateClaudePaths, candidateCodexPaths } from '../detection/claudeCodeDetector';

const execAsync = promisify(exec);

/**
 * Put Qoka's isolated bins - crucially its portable Node - on THIS process's PATH,
 * and point the CLIs at Qoka's config homes. Codex is a `#!/usr/bin/env node`
 * script, so `codex --version`/`codex mcp add` just fail ("node: not found") on a
 * machine with no system Node unless Qoka's node is on PATH. aria-skills does this
 * for the shared extension host at startup, but registration can run before that
 * (or in a host that never called it), so we self-heal here. Idempotent.
 */
function existingDir(d: string): boolean {
	try { return fs.existsSync(d); } catch { return false; }
}

/** A directory containing a runnable `node`, for Codex's `#!/usr/bin/env node`
 *  shebang. Qoka's provisioned node on an end-user machine; nvm or the system
 *  node on a dev machine. Returns undefined if none is found. */
function nodeBinDir(): string | undefined {
	const isWin = process.platform === 'win32';
	const nodeName = isWin ? 'node.exe' : 'node';
	const candidates: string[] = [];
	const qoka = path.join(os.homedir(), '.qoka');
	candidates.push(isWin ? path.join(qoka, 'node') : path.join(qoka, 'node', 'bin'));
	// nvm: newest installed version.
	try {
		const nvm = path.join(os.homedir(), '.nvm', 'versions', 'node');
		if (existingDir(nvm)) {
			for (const v of fs.readdirSync(nvm).sort().reverse()) { candidates.push(path.join(nvm, v, 'bin')); }
		}
	} catch { /* no nvm */ }
	candidates.push('/usr/local/bin', '/usr/bin', path.dirname(process.execPath));
	return candidates.find(d => existingDir(path.join(d, nodeName)));
}

function ensureQokaCliOnPath(): void {
	const qoka = path.join(os.homedir(), '.qoka');
	const isWin = process.platform === 'win32';
	const dirs = isWin
		? [path.join(qoka, 'bin'), path.join(qoka, 'node'), path.join(qoka, 'npm')]
		: [path.join(qoka, 'bin'), path.join(qoka, 'npm', 'bin'), path.join(qoka, 'node', 'bin')];
	const nodeDir = nodeBinDir();
	if (nodeDir) { dirs.push(nodeDir); }
	const current = (process.env.PATH ?? '').split(path.delimiter);
	const missing = dirs.filter(d => d && existingDir(d) && !current.includes(d));
	if (missing.length) { process.env.PATH = [...missing, ...current].filter(Boolean).join(path.delimiter); }
	if (!process.env.CODEX_HOME) { process.env.CODEX_HOME = path.join(qoka, 'codex'); }
	if (!process.env.CLAUDE_CONFIG_DIR) { process.env.CLAUDE_CONFIG_DIR = path.join(qoka, 'claude'); }
}

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

/** Returns true when it actually wrote a new registration (config changed). */
async function codexAdd(codex: string): Promise<boolean> {
	if (await codexHasWhirick(codex)) { return false; }
	try { await execAsync(`${quoteArg(codex)} mcp remove ${NAME}`, { timeout: 10000 }); } catch { /* not present */ }
	await execAsync(`${quoteArg(codex)} mcp add ${NAME} --url ${quoteArg(SERVER_URL)}`, { timeout: 10000 });
	return true;
}

/**
 * Register the whirick MCP (bare OAuth URL) with CLAUDE only, idempotently. Claude
 * connects lazily and the user authorises on demand via `/mcp`, so registering it
 * at startup is safe (no unsolicited browser prompt). Awaited by the workbench
 * startup coordinator so whirick lands in the first session with the other MCPs.
 */
export async function registerWhirickWithClaude(): Promise<void> {
	ensureQokaCliOnPath();
	const cwd = claudeCwd();
	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (claude && cwd) {
		try { await claudeAdd(claude, cwd); wlog('registered whirick with Claude (local scope)'); }
		catch (err) { wlog(`claude add failed: ${((err as { stderr?: string }).stderr ?? String(err)).slice(0, 200)}`); }
	}
}

/**
 * Register the whirick MCP with CODEX, idempotently. Codex eagerly OAuths every
 * registered server the moment it activates, so we do NOT do this at startup (the
 * popup would fire before the user is ready and never stick). It runs on demand
 * when the user asks Codex to make slides; the caller then offers a window reload,
 * the only way Codex re-reads its config and runs the OAuth while the user waits.
 * Returns whether the config changed (a reload is only worth offering if so or if
 * whirick is present but not yet authorised).
 */
export async function registerWhirickWithCodex(): Promise<{ ok: boolean; changed: boolean }> {
	ensureQokaCliOnPath();
	const codex = await resolveBinary('codex', candidateCodexPaths());
	if (!codex) { return { ok: false, changed: false }; }
	try {
		const changed = await codexAdd(codex);
		wlog(`registered whirick with Codex (changed=${changed})`);
		return { ok: true, changed };
	} catch (err) {
		wlog(`codex add failed: ${((err as { stderr?: string }).stderr ?? String(err)).slice(0, 200)}`);
		return { ok: false, changed: false };
	}
}
