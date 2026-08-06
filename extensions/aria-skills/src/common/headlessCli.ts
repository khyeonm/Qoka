/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared helper for running an AI provider CLI in HEADLESS mode - i.e. piping a
 * prompt to the CLI's stdin and collecting stdout, WITHOUT going through the
 * visible chat window. This is the "background CLI" path (as opposed to the
 * chat-reveal path in the workbench's aiProviderChat.ts).
 *
 * Extracted so multiple features can share one implementation:
 *   - aria-skills' SKILL.md analyzer (claudeAnalyzer.ts) - Claude or Codex.
 *   - aria-vcs' snapshot summariser keeps its own copy (separate bundle).
 *
 * Provider selection follows the app-wide `aria.aiProvider` setting via
 * providerOrder()/resolveActiveProvider(); callers can also force a specific
 * provider. Gemini is intentionally not supported (Qoka targets Claude Code +
 * Codex).
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type HeadlessProvider = 'claude' | 'codex';

const isWin = process.platform === 'win32';
const HOME = os.homedir();

/** Qoka's private home for tools it provisions itself when the machine lacks
 *  them (portable Node, npm-installed CLIs). Both the installer and this
 *  resolver agree on these paths so a self-provisioned CLI is always found. */
export const QOKA_HOME = path.join(HOME, '.qoka');
/** Portable Node root (nodeBootstrap downloads here). `bin/` on Unix; the
 *  executables sit at the root on Windows. */
export const QOKA_NODE_DIR = path.join(QOKA_HOME, 'node');
/** npm --prefix used for Qoka-installed global CLIs. On Unix bins land in
 *  `<prefix>/bin`; on Windows the `.cmd` shims sit at the prefix root. */
export const QOKA_NPM_PREFIX = path.join(QOKA_HOME, 'npm');
/** The ONE directory a provider CLI is installed into. Everything Qoka runs (its
 *  own headless calls AND, via PATH, the chat extensions) resolves the CLI from
 *  here and nowhere else - full isolation from a system-installed claude/codex. */
export const QOKA_BIN_DIR = path.join(QOKA_HOME, 'bin');
/** Isolated config/login homes. The provider CLIs honour these env vars, so
 *  Qoka's login lives entirely under ~/.qoka and never touches (or reads) the
 *  user's terminal login at ~/.codex or ~/.claude.json. */
export const QOKA_CODEX_HOME = path.join(QOKA_HOME, 'codex');
export const QOKA_CLAUDE_CONFIG_DIR = path.join(QOKA_HOME, 'claude');

/** Per-window Codex home for `workspacePath` = `~/.qoka/codex/ws/<hash>`. Codex has
 *  NO per-project config scope and keeps its MCP registration + chat sessions in
 *  CODEX_HOME, so two windows sharing one CODEX_HOME clobber each other's MCP port
 *  and leak chat history. Each window's extension host has its OWN process.env, and
 *  the bundled codex the openai.chatgpt extension spawns inherits it, so a per-window
 *  CODEX_HOME here reaches that window's codex. Shared home when no workspace. */
export function codexHomeFor(workspacePath: string | undefined): string {
	if (!workspacePath) { return QOKA_CODEX_HOME; }
	const key = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 12);
	return path.join(QOKA_CODEX_HOME, 'ws', key);
}

/** Point a per-window Codex home's login (auth.json) at the ONE shared login so a
 *  single sign-in serves every project. Best-effort, cross-platform: symlink where
 *  allowed, copy on Windows without Developer Mode; promote a window's real login to
 *  the shared home so other windows pick it up. */
function linkSharedCodexLogin(codexHome: string): void {
	const shared = path.join(QOKA_CODEX_HOME, 'auth.json');
	const link = path.join(codexHome, 'auth.json');
	try {
		const st = fs.lstatSync(link);
		if (!st.isSymbolicLink()) {
			try { fs.mkdirSync(QOKA_CODEX_HOME, { recursive: true }); fs.copyFileSync(link, shared); } catch { /* best-effort */ }
			return;
		}
		if (fs.readlinkSync(link) === shared) { return; }
		fs.rmSync(link, { force: true });
	} catch { /* no login here yet */ }
	if (!fs.existsSync(shared)) { return; }
	try { fs.symlinkSync(shared, link); }
	catch { try { fs.copyFileSync(shared, link); } catch { /* best-effort */ } }
}

/** Diagnostic: append what CODEX_HOME we set, for which workspace, and when, to
 *  ~/.qoka/codex-home-set.log. Cross-referenced with where codex actually writes its
 *  sessions, this tells us conclusively whether the per-window value reaches codex. */
function logCodexHome(workspacePath: string | undefined, codexHome: string): void {
	try {
		fs.appendFileSync(path.join(QOKA_HOME, 'codex-home-set.log'),
			JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, workspacePath: workspacePath ?? null, codexHome }) + '\n');
	} catch { /* best-effort */ }
}

/** Put Qoka's provisioned bins on THIS process's PATH so every extension in the
 *  shared extension host - not just aria-skills - can spawn the provider CLIs and
 *  the Node they need. Codex is an npm script whose `#!/usr/bin/env node` shebang
 *  needs `node`; a non-developer machine often has none, so we prepend Qoka's
 *  portable Node (~/.aria/node/bin) plus ~/.local/bin (where claude/codex land).
 *  Idempotent - safe to call from multiple extensions' activate(). */
export function ensureQokaBinsOnPath(workspacePath?: string): void {
	// Self-heal: an earlier build mirrored codex's npm launcher into ~/.qoka/bin,
	// where its %~dp0 / node_modules resolution breaks so codex never runs (no
	// login). Remove it before anything resolves a CLI, so discovery falls through
	// to the working copy in QOKA_NPM_PREFIX. Claude is a self-contained binary and
	// is left alone.
	for (const n of ['codex', 'codex.cmd', 'codex.exe', 'codex.bat']) {
		try { fs.rmSync(path.join(QOKA_BIN_DIR, n), { force: true }); } catch { /* none */ }
	}
	// ISOLATION: put ONLY Qoka's own dirs on PATH, at the FRONT. The chat
	// extensions (Claude Code, Codex) run in this shared extension host and spawn
	// their CLI by PATH lookup, so prepending ~/.qoka/bin makes them use Qoka's
	// isolated binary in preference to any system install. We deliberately do NOT
	// add ~/.local/bin, the OS npm global, or the login-shell PATH any more - that
	// is what let a system-installed CLI (and its separate login) leak in.
	const wanted: string[] = [QOKA_BIN_DIR];
	const nodeBin = qokaNodeBinDir();
	if (nodeBin) { wanted.push(nodeBin); }               // codex's node shebang
	wanted.push(isWin ? QOKA_NPM_PREFIX : path.join(QOKA_NPM_PREFIX, 'bin'));
	const current = (process.env.PATH ?? '').split(path.delimiter);
	const missing = wanted.filter(dir => dir && !current.includes(dir));
	if (missing.length) {
		process.env.PATH = [...missing, ...current].filter(Boolean).join(path.delimiter);
	}
	// Point BOTH CLIs at Qoka's own config/login homes. Set for this extension
	// host process, so every extension that spawns the CLI (and the CLI's own
	// children) inherits them - the login the user does inside Qoka is stored here
	// and the system login is never read or written.
	// Codex home is PER-WINDOW (keyed by the open project) so multiple windows don't
	// share one MCP registration or leak chat history; login is symlinked to the
	// shared home. Each window's extension host has its own process.env, and codex
	// inherits it. When no workspace is given, keep an already-set per-window value or
	// fall back to the shared home. Claude stays on the ONE home (separates by project
	// itself). Logged so we can confirm the value actually reaches codex.
	const codexHome = workspacePath ? codexHomeFor(workspacePath) : (process.env.CODEX_HOME || QOKA_CODEX_HOME);
	if (codexHome !== QOKA_CODEX_HOME) {
		try { fs.mkdirSync(codexHome, { recursive: true }); linkSharedCodexLogin(codexHome); } catch { /* best-effort */ }
	}
	process.env.CODEX_HOME = codexHome;
	process.env.CLAUDE_CONFIG_DIR = QOKA_CLAUDE_CONFIG_DIR;
	logCodexHome(workspacePath, codexHome);
}

/** Directory holding the portable `node`/`npm` binaries, or undefined when Qoka
 *  hasn't provisioned Node. Callers prepend this to PATH so npm-based CLIs (and
 *  their node shebang) resolve at run time. */
export function qokaNodeBinDir(): string | undefined {
	const dir = isWin ? QOKA_NODE_DIR : path.join(QOKA_NODE_DIR, 'bin');
	try {
		return fs.existsSync(dir) ? dir : undefined;
	} catch {
		return undefined;
	}
}

/** Directories where a provider CLI may live, most-specific first. Covers the
 *  npm global prefixes (default + Qoka's) and, on Unix, the usual bin dirs and
 *  nvm - a GUI-launched Electron process often can't see these via PATH. */
function providerDirs(): string[] {
	// ISOLATION: only Qoka's own locations. A CLI installed on the system (PATH,
	// Homebrew, ~/.local/bin, nvm) is intentionally NOT discovered - Qoka runs the
	// binary it provisioned into ~/.qoka and nothing else.
	if (isWin) {
		return [
			QOKA_BIN_DIR,     // where installProviderCli places both CLIs
			QOKA_NODE_DIR,    // portable node's own dir (npm.cmd etc.)
			QOKA_NPM_PREFIX,  // Qoka-managed npm global (.cmd shims at root)
		];
	}
	return [
		QOKA_BIN_DIR,
		path.join(QOKA_NPM_PREFIX, 'bin'),
		path.join(QOKA_NODE_DIR, 'bin'),
	];
}


/** Executable name variants to try for a provider. On Windows npm/native
 *  installers produce `.cmd`/`.exe` shims, never a bare extension-less file. */
function binNames(provider: HeadlessProvider): string[] {
	return isWin ? [`${provider}.cmd`, `${provider}.exe`, `${provider}.bat`, provider] : [provider];
}

/** Resolve an executable path for the provider, or undefined when not found.
 *  GUI-launched Electron apps often run with a truncated PATH, so we probe known
 *  install dirs first and only then scan PATH. Always returns a concrete,
 *  spawnable path (or undefined), keeping isProviderInstalled() honest. */
export function resolveProviderBin(provider: HeadlessProvider): string | undefined {
	const names = binNames(provider);
	// 1) Known install dirs.
	for (const dir of providerDirs()) {
		for (const name of names) {
			const full = path.join(dir, name);
			try {
				if (fs.existsSync(full)) {
					return full;
				}
			} catch {
				// keep looking
			}
		}
	}
	// No PATH fallback: isolation means Qoka only ever runs the CLI it installed
	// under ~/.qoka. A system-installed claude/codex on PATH must NOT be picked up
	// (it would carry the user's separate system login and defeat the isolation).
	return undefined;
}

/** True when the provider's CLI is present on this machine. Note: "installed"
 *  is NOT "logged in" - a headless call can still fail with an auth error, which
 *  the caller must handle (fall back to another provider or a template). */
export function isProviderInstalled(provider: HeadlessProvider): boolean {
	return resolveProviderBin(provider) !== undefined;
}

/** The provider order implied by the app-wide `aria.aiProvider` setting.
 *  `auto` → Claude first (Qoka's documented default), then Codex; an explicit
 *  choice puts that provider first. This is the single place the setting is
 *  read for the background/headless path. */
export function providerOrder(): HeadlessProvider[] {
	const pref = vscode.workspace.getConfiguration('aria').get<string>('aiProvider') ?? 'auto';
	const base: HeadlessProvider[] = ['claude', 'codex'];
	return pref === 'claude' || pref === 'codex'
		? [pref, ...base.filter(p => p !== pref)]
		: base;
}

/** The first provider (in the setting's preferred order) whose CLI is actually
 *  installed, or undefined when neither is available. */
export function resolveActiveProvider(): HeadlessProvider | undefined {
	return providerOrder().find(isProviderInstalled);
}

/** The non-interactive/headless argument vector per provider. The prompt is fed
 *  on stdin (not as an argv), so both entries end by reading from stdin. */
export function headlessArgs(provider: HeadlessProvider): string[] {
	switch (provider) {
		case 'claude':
			// Claude Code print mode: read prompt from stdin, emit plain text.
			return ['--print', '--output-format', 'text'];
		case 'codex':
			// Codex exec (non-interactive). `-` reads the prompt from stdin;
			// --skip-git-repo-check avoids refusing to run outside a git repo.
			return ['exec', '--skip-git-repo-check', '-'];
	}
}

/**
 * Drive a child process by writing `input` to its stdin and collecting stdout.
 * We can't use child_process.exec's `input` option - it silently drops the
 * prompt (the bug that used to make Claude exit with an empty buffer).
 *
 * Rejects on non-zero exit, spawn error, or timeout (the child is SIGTERM'd).
 */
export function runWithStdin(bin: string, args: string[], input: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		// If Qoka provisioned a portable Node, put it on PATH so an npm-installed
		// CLI (e.g. codex) can find `node` for its shebang even when the machine
		// has no system Node.
		const nodeBin = qokaNodeBinDir();
		const env = nodeBin
			? { ...process.env, PATH: nodeBin + path.delimiter + (process.env.PATH ?? '') }
			: process.env;
		const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill('SIGTERM');
			reject(new Error(`Timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.on('data', d => { stdout += d.toString(); });
		child.stderr.on('data', d => { stderr += d.toString(); });
		child.on('error', err => {
			clearTimeout(timer);
			reject(err);
		});
		child.on('close', code => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`${bin} exited with code ${code}: ${stderr.trim() || '(no stderr)'}`));
			}
		});
		// A CLI that exits before reading stdin (not logged in / fast failure)
		// closes the pipe; without this listener the EPIPE would surface as an
		// uncaught exception in the extension host. The 'close' handler already
		// reports the real exit code.
		child.stdin.on('error', () => { });
		child.stdin.write(input);
		child.stdin.end();
	});
}

/**
 * Run a single headless prompt against the given provider and return stdout.
 * Throws when the provider isn't installed, or on any run failure (auth error,
 * timeout, non-zero exit) - callers decide how to fall back.
 */
export async function runHeadless(provider: HeadlessProvider, prompt: string, timeoutMs = 30000): Promise<string> {
	const bin = resolveProviderBin(provider);
	if (!bin) {
		throw new Error(`${provider} CLI not found on this machine.`);
	}
	return runWithStdin(bin, headlessArgs(provider), prompt, timeoutMs);
}
