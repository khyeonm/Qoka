/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared helper for running an AI provider CLI in HEADLESS mode — i.e. piping a
 * prompt to the CLI's stdin and collecting stdout, WITHOUT going through the
 * visible chat window. This is the "background CLI" path (as opposed to the
 * chat-reveal path in the workbench's aiProviderChat.ts).
 *
 * Extracted so multiple features can share one implementation:
 *   - aria-skills' SKILL.md analyzer (claudeAnalyzer.ts) — Claude or Codex.
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

/** Candidate absolute paths per provider, tried in order. `claude`/`codex`
 *  (bare) rely on PATH; the rest cover the common install locations that a
 *  GUI-launched Electron process often can't see because it doesn't inherit
 *  the user's login shell PATH. */
const BIN_CANDIDATES: Record<HeadlessProvider, string[]> = {
	claude: [
		'claude',
		'/usr/local/bin/claude',
		'/opt/homebrew/bin/claude',
		path.join(os.homedir(), '.local/bin/claude'),
		path.join(os.homedir(), '.claude/local/claude'),
	],
	codex: [
		'codex',
		'/usr/local/bin/codex',
		'/opt/homebrew/bin/codex',
		path.join(os.homedir(), '.local/bin/codex'),
	],
};

const NVM_DIR = path.join(os.homedir(), '.nvm/versions/node');

/** Add `<nvm>/<version>/bin/<name>` candidates so an nvm-installed CLI is found
 *  even when the Electron process didn't source the user's shell. */
function withNvmCandidates(name: HeadlessProvider, candidates: string[]): string[] {
	const extra: string[] = [];
	try {
		for (const version of fs.readdirSync(NVM_DIR)) {
			extra.push(path.join(NVM_DIR, version, 'bin', name));
		}
	} catch {
		// no nvm — fine
	}
	return [...candidates, ...extra];
}

/** Resolve an executable path for the provider, or undefined when not found.
 *  GUI-launched Electron apps often run with a truncated PATH that omits
 *  ~/.local/bin, nvm, and /opt/homebrew/bin — so we must NOT just trust the
 *  bare name. Prefer an absolute candidate that exists on disk; only then fall
 *  back to resolving the bare name against whatever PATH we do have. This always
 *  returns a concrete, spawnable path (or undefined), which keeps
 *  isProviderInstalled() honest. */
export function resolveProviderBin(provider: HeadlessProvider): string | undefined {
	const candidates = withNvmCandidates(provider, BIN_CANDIDATES[provider]);
	// 1) Absolute candidates that actually exist.
	for (const candidate of candidates) {
		if (candidate.includes('/')) {
			try {
				if (fs.existsSync(candidate)) {
					return candidate;
				}
			} catch {
				// keep looking
			}
		}
	}
	// 2) Bare name resolved against the current PATH.
	const bare = candidates.find(c => !c.includes('/'));
	if (bare) {
		for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
			if (!dir) {
				continue;
			}
			const full = path.join(dir, bare);
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
 *  is NOT "logged in" — a headless call can still fail with an auth error, which
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
 * We can't use child_process.exec's `input` option — it silently drops the
 * prompt (the bug that used to make Claude exit with an empty buffer).
 *
 * Rejects on non-zero exit, spawn error, or timeout (the child is SIGTERM'd).
 */
export function runWithStdin(bin: string, args: string[], input: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
 * timeout, non-zero exit) — callers decide how to fall back.
 */
export async function runHeadless(provider: HeadlessProvider, prompt: string, timeoutMs = 30000): Promise<string> {
	const bin = resolveProviderBin(provider);
	if (!bin) {
		throw new Error(`${provider} CLI not found on this machine.`);
	}
	return runWithStdin(bin, headlessArgs(provider), prompt, timeoutMs);
}
