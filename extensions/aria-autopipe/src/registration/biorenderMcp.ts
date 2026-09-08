/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { candidateClaudePaths, candidateCodexPaths } from '../detection/claudeCodeDetector';
import { BioRenderAuthService, BioRenderStatus, BIORENDER_MCP_URL } from '../biorender/bioRenderAuth';

const execAsync = promisify(exec);

/** Diagnostic log shipped in the release: open View > Output > "Qoka BioRender" to
 *  see exactly what the connect/disconnect flow did (resolved CLI paths, the
 *  command run, the CLI's output). No secrets are logged - the bearer token is
 *  never printed here. */
let bioLog: vscode.OutputChannel | undefined;
function blog(msg: string): void {
	try { (bioLog ??= vscode.window.createOutputChannel('Qoka BioRender')).appendLine(`[${new Date().toISOString()}] ${msg}`); } catch { /* noop */ }
	try { console.log('[biorender]', msg); } catch { /* noop */ }
}

/**
 * Built-in BioRender MCP (a REMOTE OAuth server at mcp.services.biorender.com).
 *
 * Qoka owns the OAuth token itself (BioRenderAuthService: loopback + PKCE + dynamic
 * client registration, stored in SecretStorage) and injects it into each AI CLI's
 * MCP config as an `Authorization: Bearer` header. The CLI then sends that header
 * on connect and never runs its OWN OAuth - so there is exactly ONE browser sign-in
 * (the Settings "Connect" button), and none at startup. This replaces the earlier
 * `claude mcp login` approach, under which every MCP client re-authenticated on
 * connect and popped a browser window on each Qoka launch.
 *
 * A stored token survives restarts and is refreshed transparently, so reconnecting
 * after a restart is silent. Registration is refreshed (remove-then-add, because
 * `mcp add` refuses to overwrite) whenever we have a fresh token, so each new chat
 * session picks up a current bearer.
 *
 * Verified: Claude Code 2.1.x honors the injected header (sends it from the first
 * `initialize` and never probes OAuth). Codex header support is best-effort and
 * still to be confirmed on a machine that has Codex installed.
 */

const NAME = 'biorender';

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

/** BioRender is registered at LOCAL (project) scope so it lives ONLY in this
 *  project's config, never in Claude's global `user` config that every other
 *  VS Code / terminal Claude would also read. Local scope needs a project cwd, so
 *  this returns undefined when no workspace is open (nothing to register into). */
function claudeCwd(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// --- Claude (verified header support) ---

async function claudeRemove(claude: string, cwd: string): Promise<void> {
	try { await execAsync(`${quoteArg(claude)} mcp remove --scope local ${NAME}`, { timeout: 15000, cwd }); } catch { /* not present - fine */ }
}

async function claudeAddWithBearer(claude: string, cwd: string, token: string): Promise<void> {
	// `mcp add` refuses to overwrite an existing server ("already exists"), so remove
	// first to refresh the bearer header with a current token.
	await claudeRemove(claude, cwd);
	const header = `Authorization: Bearer ${token}`;
	await execAsync(`${quoteArg(claude)} mcp add --scope local ${NAME} ${quoteArg(BIORENDER_MCP_URL)} --transport http --header ${quoteArg(header)}`, { timeout: 15000, cwd });
}

// --- Codex (best-effort; header support unconfirmed) ---

async function codexRemove(codex: string): Promise<void> {
	try { await execAsync(`${quoteArg(codex)} mcp remove ${NAME}`, { timeout: 10000 }); } catch { /* not present - fine */ }
}

async function codexAddWithBearer(codex: string, token: string): Promise<void> {
	await codexRemove(codex);
	const header = `Authorization: Bearer ${token}`;
	// Try to register WITH the header. We deliberately do NOT fall back to a
	// headerless registration on failure: a headerless remote-OAuth server makes the
	// CLI run its own OAuth and pop a browser on connect, which is exactly what this
	// design eliminates. If Codex does not accept --header, biorender is simply not
	// registered for Codex (surfaced in the log) until that path is confirmed.
	await execAsync(`${quoteArg(codex)} mcp add ${NAME} --url ${quoteArg(BIORENDER_MCP_URL)} --header ${quoteArg(header)}`, { timeout: 10000 });
}

/**
 * Reconcile the BioRender MCP registration with the current login state:
 *  - logged in  -> register (or refresh) both CLIs with a current bearer header
 *  - logged out -> remove the registration so nothing tries to connect
 *  - connected but a transient token refresh failed -> leave the existing
 *    registration untouched (do NOT remove; the next refresh recovers it)
 * Safe to call on activation and before each chat session.
 */
export async function ensureBioRenderRegistered(auth: BioRenderAuthService): Promise<void> {
	const connected = await auth.isConnected();
	const token = connected ? await auth.getValidAccessToken() : null;
	const cwd = claudeCwd();

	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (claude && cwd) {
		if (token) {
			try { await claudeAddWithBearer(claude, cwd, token); blog('ensureRegistered(claude): registered with bearer header (local scope)'); }
			catch (err) { blog(`ensureRegistered(claude): add failed: ${((err as { stderr?: string }).stderr ?? String(err)).slice(0, 200)}`); }
		} else if (!connected) {
			await claudeRemove(claude, cwd); blog('ensureRegistered(claude): not logged in -> removed registration');
		}
	}

	const codex = await resolveBinary('codex', candidateCodexPaths());
	if (codex) {
		if (token) {
			try { await codexAddWithBearer(codex, token); blog('ensureRegistered(codex): registered with bearer header'); }
			catch (err) { blog(`ensureRegistered(codex): add --header failed (Codex header support unconfirmed): ${((err as { stderr?: string }).stderr ?? String(err)).slice(0, 200)}`); }
		} else if (!connected) {
			await codexRemove(codex); blog('ensureRegistered(codex): not logged in -> removed registration');
		}
	}
}

/**
 * Connect: run Qoka's own OAuth (opens the browser once), store the token, and
 * register both CLIs with the bearer header. Cross-platform identical - no PTY, no
 * terminal, no CLI `mcp login` - because Qoka owns the whole flow.
 */
export async function loginBioRender(auth: BioRenderAuthService): Promise<{ ok: boolean; message: string }> {
	blog(`login: start platform=${process.platform}`);
	const r = await auth.login();
	blog(`login: auth result ok=${r.ok} account=${r.account ?? '(none)'} ${r.ok ? '' : 'message=' + r.message}`);
	if (r.ok) {
		await ensureBioRenderRegistered(auth);
		void vscode.window.showInformationMessage('BioRender is connected.');
	}
	return { ok: r.ok, message: r.message };
}

/** Disconnect: drop Qoka's stored token and remove the registration from both CLIs
 *  so the chat no longer sees BioRender. */
export async function logoutBioRender(auth: BioRenderAuthService): Promise<void> {
	blog('logout: start');
	await auth.logout();
	const cwd = claudeCwd();
	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (claude && cwd) { await claudeRemove(claude, cwd); blog('logout(claude): removed registration'); }
	const codex = await resolveBinary('codex', candidateCodexPaths());
	if (codex) { await codexRemove(codex); blog('logout(codex): removed registration'); }
}

/** Connected when Qoka holds a BioRender token (in SecretStorage). Instant, offline
 *  friendly, and accurate right after connect/disconnect - no CLI round-trip. */
export async function bioRenderStatus(auth: BioRenderAuthService): Promise<BioRenderStatus> {
	const st = await auth.getStatus();
	blog(`status: connected=${st.connected} account=${st.account ?? '(none)'}`);
	return st;
}
