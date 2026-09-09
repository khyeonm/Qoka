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
 * The two CLIs differ in ONE way that dictates everything here: whether their MCP
 * config can carry an injected auth header.
 *
 *  - CLAUDE accepts `--header`, so Qoka owns the OAuth token (BioRenderAuthService:
 *    loopback + PKCE + dynamic client registration, in SecretStorage) and injects it
 *    as `Authorization: Bearer`. Claude sends that header on connect and never runs
 *    its OWN OAuth - so Claude needs NO browser at startup, only the one Qoka OAuth
 *    behind the Settings Connect button. The token survives restarts and refreshes
 *    transparently; registration is remove-then-add (mcp add won't overwrite) at
 *    LOCAL scope, and we clear ALL scopes first so a stale USER-scope entry from an
 *    older build can't make Claude re-OAuth (that was the Windows browser storm).
 *
 *  - CODEX has no way to attach a header, so Qoka cannot hand it the token. Codex is
 *    registered HEADERLESS and signs in with its OWN OAuth (its own browser, its own
 *    stored token). Its single ~/.codex/config.toml has no scopes, so there is only
 *    one entry and no repeated-browser storm. A Codex user therefore gets a second,
 *    Codex-driven browser the first time Codex connects.
 *
 * Verified: Claude Code 2.1.x honors the injected header (sends it from the first
 * `initialize` and never probes OAuth).
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
	// Remove biorender from EVERY scope, not just local. Earlier Qoka builds
	// registered it headerless at USER scope; that stale entry lingers in the global
	// ~/.claude.json and makes Claude run its OWN OAuth (a browser storm) on every
	// startup - the exact symptom seen on Windows (macOS was clean because its older
	// builds happened to use local scope). Clearing all scopes guarantees the only
	// biorender Claude ever sees is our local, bearer-carrying entry.
	for (const scope of ['local', 'user', 'project']) {
		try { await execAsync(`${quoteArg(claude)} mcp remove --scope ${scope} ${NAME}`, { timeout: 15000, cwd }); } catch { /* not present in this scope - fine */ }
	}
}

async function claudeAddWithBearer(claude: string, cwd: string, token: string): Promise<void> {
	// `mcp add` refuses to overwrite an existing server ("already exists"), so remove
	// first to refresh the bearer header with a current token.
	await claudeRemove(claude, cwd);
	const header = `Authorization: Bearer ${token}`;
	await execAsync(`${quoteArg(claude)} mcp add --scope local ${NAME} ${quoteArg(BIORENDER_MCP_URL)} --transport http --header ${quoteArg(header)}`, { timeout: 15000, cwd });
}

// --- Codex ---
// `codex mcp add` has NO way to attach an Authorization header (its usage is
// `codex mcp add <NAME> (--url <URL> | -- <COMMAND>...)`), so we cannot inject the
// Qoka-owned token the way we do for Claude. Instead we register Codex HEADERLESS
// and let Codex run its OWN OAuth: it opens its own browser to sign in and stores
// its own token. Unlike Claude, Codex keeps a single ~/.codex/config.toml with no
// scopes, so there is only ever one biorender entry - no stale-scope duplicate that
// would cause the repeated-browser storm Claude had on Windows.

async function codexRemove(codex: string): Promise<void> {
	try { await execAsync(`${quoteArg(codex)} mcp remove ${NAME}`, { timeout: 10000 }); } catch { /* not present - fine */ }
}

async function codexRegisterHeaderless(codex: string): Promise<void> {
	// remove-first so a stale entry doesn't make `mcp add` fail with "already exists".
	await codexRemove(codex);
	await execAsync(`${quoteArg(codex)} mcp add ${NAME} --url ${quoteArg(BIORENDER_MCP_URL)}`, { timeout: 10000 });
}

async function codexLogout(codex: string): Promise<void> {
	try { await execAsync(`${quoteArg(codex)} mcp logout ${NAME}`, { timeout: 10000 }); } catch { /* may be unsupported - best-effort */ }
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

	// Codex can't take an injected header, so register it headerless when the user
	// has connected BioRender (Qoka's connected flag is the master switch). Codex
	// then signs in with its own OAuth (its own browser) and stores its own token.
	// When disconnected, remove the entry so Codex stops trying to connect.
	const codex = await resolveBinary('codex', candidateCodexPaths());
	if (codex) {
		if (connected) {
			try { await codexRegisterHeaderless(codex); blog('ensureRegistered(codex): registered headerless (Codex signs in with its own OAuth)'); }
			catch (err) { blog(`ensureRegistered(codex): add failed: ${((err as { stderr?: string }).stderr ?? String(err)).slice(0, 200)}`); }
		} else {
			await codexRemove(codex); blog('ensureRegistered(codex): not connected -> removed registration');
		}
	}
}

/**
 * Connect: run Qoka's own OAuth (one browser) and reconcile both CLIs. Claude gets
 * the Qoka token injected as a header (no further browser). Codex is registered
 * headerless and signs in with its OWN OAuth - so a Codex user gets a second,
 * Codex-driven browser when Codex first connects (Codex can't accept our token).
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
	if (codex) { await codexLogout(codex); await codexRemove(codex); blog('logout(codex): signed out + removed registration'); }
}

/** Connected when Qoka holds a BioRender token (in SecretStorage). Instant, offline
 *  friendly, and accurate right after connect/disconnect - no CLI round-trip. */
export async function bioRenderStatus(auth: BioRenderAuthService): Promise<BioRenderStatus> {
	const st = await auth.getStatus();
	blog(`status: connected=${st.connected} account=${st.account ?? '(none)'}`);
	return st;
}
