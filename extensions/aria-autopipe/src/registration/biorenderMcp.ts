/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { candidateClaudePaths, candidateCodexPaths } from '../detection/claudeCodeDetector';

const execAsync = promisify(exec);

/** Diagnostic log shipped in the release: open View > Output > "Qoka BioRender" to
 *  see exactly what the connect/disconnect flow did (resolved CLI paths, the
 *  command run, the CLI's output, exit code, status) - so Windows/Mac issues can be
 *  diagnosed from the installed build without a rebuild. No secrets are logged (the
 *  OAuth token is stored by the CLI, never printed here). */
let bioLog: vscode.OutputChannel | undefined;
function blog(msg: string): void {
	try { (bioLog ??= vscode.window.createOutputChannel('Qoka BioRender')).appendLine(`[${new Date().toISOString()}] ${msg}`); } catch { /* noop */ }
	try { console.log('[biorender]', msg); } catch { /* noop */ }
}

/**
 * Built-in BioRender MCP (a REMOTE OAuth server at mcp.services.biorender.com).
 *
 * BioRender advertises OAuth, and the AI CLIs run their OWN OAuth for such a
 * server - a statically injected `Authorization` header is ignored, so the
 * earlier "Qoka owns the token" approach did NOT authenticate Claude. Instead we
 * register the server (built-in, headerless) and drive the CLI's own OAuth from
 * Settings via `claude mcp login` / `logout` (the CLI opens the browser and
 * stores the token itself - the same thing the chat's `/mcp` Authenticate does).
 */

export const BIORENDER_MCP_URL = 'https://mcp.services.biorender.com/mcp';
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

function claudeScopeOpts(): { scope: 'local' | 'user'; opts: { timeout: number; cwd?: string } } {
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return cwd ? { scope: 'local', opts: { timeout: 15000, cwd } } : { scope: 'user', opts: { timeout: 15000 } };
}

/** Ensure the built-in BioRender remote MCP is registered (headerless) with each
 *  present AI CLI, so it is there from the start and can be authenticated via the
 *  CLI's own OAuth. Idempotent: skips a CLI that already has it. */
export async function ensureBioRenderRegistered(): Promise<void> {
	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (claude) {
		const q = quoteArg(claude);
		const { scope, opts } = claudeScopeOpts();
		let exists = false;
		try { await execAsync(`${q} mcp get ${NAME}`, opts); exists = true; } catch { /* not registered */ }
		if (!exists) {
			try {
				await execAsync(`${q} mcp add --scope ${scope} ${NAME} ${quoteArg(BIORENDER_MCP_URL)} --transport http`, opts);
				console.log('[aria-autopipe] registered built-in BioRender MCP with Claude Code');
			} catch (err) {
				console.error('[aria-autopipe] claude mcp add biorender failed:', (err as { stderr?: string }).stderr ?? String(err));
			}
		}
	}
	const codex = await resolveBinary('codex', candidateCodexPaths());
	if (codex) {
		const q = quoteArg(codex);
		let exists = false;
		try { await execAsync(`${q} mcp get ${NAME}`, { timeout: 10000 }); exists = true; } catch { /* not registered */ }
		if (!exists) {
			try { await execAsync(`${q} mcp add ${NAME} --url ${quoteArg(BIORENDER_MCP_URL)}`, { timeout: 10000 }); } catch { /* best-effort */ }
		}
	}
}

/**
 * Run the CLI's own OAuth for BioRender. On Linux/macOS this happens WITHOUT
 * showing a terminal (Easy mode's goal is that users never touch one); on Windows,
 * where no headless PTY is available, it falls back to an integrated terminal (see
 * the win32 branch below). `claude mcp login` needs a TTY (a headless child fails
 * with "stdin isn't a terminal"), so we allocate a hidden pseudo-terminal with
 * `script` and drive the flow ourselves:
 *
 *  - Case A (loopback): the CLI opens the browser and catches the OAuth redirect
 *    on its own localhost listener. The PTY just satisfies its TTY check; the
 *    user only signs in.
 *  - Case B (paste redirect URL): the CLI prints an authorize URL and waits for
 *    the redirect URL to be pasted. We parse the redirect port from that URL,
 *    stand up a loopback listener there, capture the browser callback, and type
 *    the full URL back into the CLI's stdin - so the user still only signs in.
 *
 * We also open the authorize URL via `openExternal` (the sandboxed extension host
 * may not open it itself). Resolves once the CLI exits and status confirms the
 * connection, and shows a "start a new chat session" notice so the running
 * session (which connected its MCPs at spawn) picks up the now-authenticated MCP.
 */
export async function loginBioRender(): Promise<{ ok: boolean; message: string }> {
	blog(`login: start platform=${process.platform}`);
	await ensureBioRenderRegistered();
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

	// Windows has no `script` and no headless ConPTY for the ext host, so run the
	// login in a real integrated terminal (which owns a ConPTY). Two Windows-specific
	// gotchas we handle here: (1) use FULL binary paths - the terminal's PATH does
	// NOT include Qoka's isolated ~/.qoka/bin, so a bare `claude`/`codex` is "not
	// recognized"; (2) PowerShell (the usual default shell) needs the call operator
	// `&` to run a quoted path, so we force PowerShell and single-quote the paths.
	// Sign in every installed CLI (Claude and/or Codex) the user has.
	if (process.platform === 'win32') {
		const claudeFull = candidateClaudePaths()[0];
		const codexFull = candidateCodexPaths()[0];
		blog(`login(win32): claudeFull=${claudeFull ?? '(none)'} codexFull=${codexFull ?? '(none)'}`);
		const cmds: string[] = [];
		if (claudeFull) { cmds.push(`& '${claudeFull}' mcp login ${NAME}`); }
		if (codexFull) { cmds.push(`& '${codexFull}' mcp login ${NAME}`); }
		if (cmds.length === 0) { blog('login(win32): no CLI found'); return { ok: false, message: 'No AI CLI (Claude or Codex) found to sign in to BioRender.' }; }
		blog(`login(win32): terminal cmd = ${cmds.join('; ')}`);
		// The claude/codex .cmd wrappers invoke `node`, and Qoka's node lives in an
		// isolated dir that the plain terminal's PATH does not include ("'node' is not
		// recognized"). Hand the terminal the extension host's PATH, which DOES resolve
		// node and the CLIs (it is what runs `claude mcp add` successfully).
		const extPath = process.env.PATH ?? process.env.Path;
		const term = vscode.window.createTerminal({
			name: 'BioRender login', cwd, shellPath: 'powershell.exe',
			shellArgs: ['-NoExit', '-Command', cmds.join('; ')],
			env: extPath ? { PATH: extPath } : undefined,
		});
		term.show(true);
		return { ok: true, message: 'Complete the BioRender sign-in in the terminal that just opened (a browser opens for sign-in). This updates once connected.' };
	}

	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (!claude) { blog('login(pty): claude not found'); return { ok: false, message: 'Claude CLI not found on PATH or known install locations.' }; }
	const inner = `${quoteArg(claude)} mcp login ${NAME}`;

	// `script` allocates the PTY. Its flags differ by platform: util-linux uses
	// `-qfc "<cmd>" <file>`, BSD/macOS uses `-q <file> <cmd> <args...>`.
	const isMac = process.platform === 'darwin';
	const args = isMac
		? ['-q', '/dev/null', claude, 'mcp', 'login', NAME]
		: ['-qfc', inner, '/dev/null'];
	blog(`login(pty): claude=${claude} script ${args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);

	const result = await new Promise<{ ok: boolean; message: string }>((resolve) => {
		let settled = false;
		let out = '';

		const child = spawn('script', args, { cwd, env: process.env });

		const finish = (r: { ok: boolean; message: string }) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			try { child.kill(); } catch { /* noop */ }
			resolve(r);
		};

		// The CLI does the whole OAuth itself: opens the browser AND runs its own
		// loopback listener for the redirect. We must NOT touch that flow (an earlier
		// version's own loopback listener RACED the CLI for the port and stole its
		// callback on macOS). We just capture stdout/stderr for the log and wait.
		const onData = (d: Buffer) => { out += d.toString('utf8'); };
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		child.on('error', (e) => { blog(`login(pty): spawn error ${String(e)}`); finish({ ok: false, message: 'Could not start the login helper (script/claude not found).' }); });
		child.on('exit', async (code, signal) => {
			blog(`login(pty): exit code=${code} signal=${signal} output=<<<\n${out.slice(0, 4000)}\n>>>`);
			const st = await bioRenderStatus();
			blog(`login(pty): post-exit status connected=${st.connected}`);
			finish(st.connected
				? { ok: true, message: 'Connected to BioRender.' }
				: { ok: false, message: 'BioRender login did not complete. Click Connect to try again.' });
		});

		const timer = setTimeout(async () => {
			blog(`login(pty): timeout after 300s output=<<<\n${out.slice(0, 4000)}\n>>>`);
			const st = await bioRenderStatus();
			finish(st.connected
				? { ok: true, message: 'Connected to BioRender.' }
				: { ok: false, message: 'BioRender login timed out. Click Connect to try again.' });
		}, 300000);
	});
	blog(`login(pty): result ok=${result.ok} message=${result.message}`);

	if (result.ok) {
		void vscode.window.showInformationMessage(
			'BioRender is connected. Start a new chat session so the assistant can use BioRender.',
		);
	}
	return result;
}

/** Clear the CLI's stored BioRender OAuth credentials. */
export async function logoutBioRender(): Promise<void> {
	blog('logout: start');
	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (claude) {
		const { opts } = claudeScopeOpts();
		try { const r = await execAsync(`${quoteArg(claude)} mcp logout ${NAME}`, opts); blog(`logout(claude): ${(r.stdout || r.stderr || 'ok').trim().slice(0, 300)}`); } catch (e) { blog(`logout(claude) failed: ${((e as { stderr?: string }).stderr ?? String(e)).slice(0, 300)}`); }
	}
	const codex = await resolveBinary('codex', candidateCodexPaths());
	if (codex) { try { const r = await execAsync(`${quoteArg(codex)} mcp logout ${NAME}`, { timeout: 10000 }); blog(`logout(codex): ${(r.stdout || r.stderr || 'ok').trim().slice(0, 300)}`); } catch (e) { blog(`logout(codex) failed (may be unsupported): ${((e as { stderr?: string }).stderr ?? String(e)).slice(0, 300)}`); } }
}

/** Connected when Claude Code has BioRender registered and NOT flagged as needing
 *  authentication (`claude mcp get biorender`). */
export async function bioRenderStatus(): Promise<{ connected: boolean }> {
	const claude = await resolveBinary('claude', candidateClaudePaths());
	if (!claude) { blog('status: claude not found -> disconnected'); return { connected: false }; }
	const q = quoteArg(claude);
	const { opts } = claudeScopeOpts();
	try {
		const out = await execAsync(`${q} mcp get ${NAME}`, opts);
		const s = out.stdout;
		const connected = /biorender/i.test(s) && !/needs authentication/i.test(s) && !/not found/i.test(s);
		blog(`status: connected=${connected} get=<<<\n${s.trim().slice(0, 800)}\n>>>`);
		return { connected };
	} catch (e) {
		blog(`status: mcp get failed: ${((e as { stderr?: string }).stderr ?? String(e)).slice(0, 300)}`);
		return { connected: false };
	}
}
