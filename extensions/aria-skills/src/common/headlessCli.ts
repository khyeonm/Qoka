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
 * provider. Gemini is intentionally not supported (Aria targets Claude Code +
 * Codex).
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type HeadlessProvider = 'claude' | 'codex';

const isWin = process.platform === 'win32';
const HOME = os.homedir();

/** Aria's private home for tools it provisions itself when the machine lacks
 *  them (portable Node, npm-installed CLIs). Both the installer and this
 *  resolver agree on these paths so a self-provisioned CLI is always found. */
export const ARIA_HOME = path.join(HOME, '.aria');
/** Portable Node root (nodeBootstrap downloads here). `bin/` on Unix; the
 *  executables sit at the root on Windows. */
export const ARIA_NODE_DIR = path.join(ARIA_HOME, 'node');
/** npm --prefix used for Aria-installed global CLIs. On Unix bins land in
 *  `<prefix>/bin`; on Windows the `.cmd` shims sit at the prefix root. */
export const ARIA_NPM_PREFIX = path.join(ARIA_HOME, 'npm');

/** Put Aria's provisioned bins on THIS process's PATH so every extension in the
 *  shared extension host - not just aria-skills - can spawn the provider CLIs and
 *  the Node they need. Codex is an npm script whose `#!/usr/bin/env node` shebang
 *  needs `node`; a non-developer machine often has none, so we prepend Aria's
 *  portable Node (~/.aria/node/bin) plus ~/.local/bin (where claude/codex land).
 *  Idempotent - safe to call from multiple extensions' activate(). */
export function ensureAriaBinsOnPath(): void {
	const wanted: string[] = [];
	const nodeBin = ariaNodeBinDir();
	if (nodeBin) {
		wanted.push(nodeBin);
	}
	// Where `npm install -g` (Aria-managed prefix + the OS default) drops the
	// codex CLI. Without these the per-extension MCP resolvers' `codex --version`
	// PATH probe fails on Windows (codex.cmd lives under ~/.aria/npm, not on PATH),
	// so Codex MCP registration silently no-ops for every extension but autopipe.
	wanted.push(isWin ? ARIA_NPM_PREFIX : path.join(ARIA_NPM_PREFIX, 'bin'));
	if (isWin) {
		wanted.push(path.join(process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming'), 'npm'));
	}
	wanted.push(path.join(HOME, '.local', 'bin'));
	const current = (process.env.PATH ?? '').split(path.delimiter);
	const missing = wanted.filter(dir => dir && !current.includes(dir));
	if (missing.length) {
		process.env.PATH = [...missing, ...current].filter(Boolean).join(path.delimiter);
	}
}

/** Directory holding the portable `node`/`npm` binaries, or undefined when Aria
 *  hasn't provisioned Node. Callers prepend this to PATH so npm-based CLIs (and
 *  their node shebang) resolve at run time. */
export function ariaNodeBinDir(): string | undefined {
	const dir = isWin ? ARIA_NODE_DIR : path.join(ARIA_NODE_DIR, 'bin');
	try {
		return fs.existsSync(dir) ? dir : undefined;
	} catch {
		return undefined;
	}
}

/** Directories where a provider CLI may live, most-specific first. Covers the
 *  npm global prefixes (default + Aria's) and, on Unix, the usual bin dirs and
 *  nvm - a GUI-launched Electron process often can't see these via PATH. */
function providerDirs(): string[] {
	if (isWin) {
		const appdata = process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming');
		const localappdata = process.env.LOCALAPPDATA ?? path.join(HOME, 'AppData', 'Local');
		return [
			ARIA_NODE_DIR,                 // portable node's own dir (npm.cmd etc.)
			ARIA_NPM_PREFIX,               // Aria-managed npm global (.cmd shims at root)
			path.join(appdata, 'npm'),     // default npm global on Windows
			path.join(HOME, '.local', 'bin'),          // Claude's Windows installer mirrors ~/.local/bin
			path.join(localappdata, 'Programs', 'claude'), // alt Claude install location
		];
	}
	return [
		'/usr/local/bin',
		'/opt/homebrew/bin',
		path.join(HOME, '.local/bin'),
		path.join(HOME, '.claude/local'),
		path.join(ARIA_NPM_PREFIX, 'bin'),
		path.join(ARIA_NODE_DIR, 'bin'),
		...nvmBinDirs(),
	];
}

/** `<nvm>/<version>/bin` dirs so an nvm-installed CLI is found even when the
 *  Electron process didn't source the user's shell. (Unix nvm layout.) */
function nvmBinDirs(): string[] {
	const nvmRoot = path.join(HOME, '.nvm/versions/node');
	try {
		return fs.readdirSync(nvmRoot).map(v => path.join(nvmRoot, v, 'bin'));
	} catch {
		return [];
	}
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
	// 2) Whatever PATH we do have (covers Homebrew/system installs on PATH).
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!dir) {
			continue;
		}
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
	return undefined;
}

/** True when the provider's CLI is present on this machine. Note: "installed"
 *  is NOT "logged in" - a headless call can still fail with an auth error, which
 *  the caller must handle (fall back to another provider or a template). */
export function isProviderInstalled(provider: HeadlessProvider): boolean {
	return resolveProviderBin(provider) !== undefined;
}

/** The provider order implied by the app-wide `aria.aiProvider` setting.
 *  `auto` → Claude first (Aria's documented default), then Codex; an explicit
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
		// If Aria provisioned a portable Node, put it on PATH so an npm-installed
		// CLI (e.g. codex) can find `node` for its shebang even when the machine
		// has no system Node.
		const nodeBin = ariaNodeBinDir();
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
