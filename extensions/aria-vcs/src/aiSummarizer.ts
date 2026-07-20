/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Names a snapshot for the Versions view by asking the user's own AI CLI
 * (Claude Code or Codex) to summarise the diff. Runs the CLI HEADLESS (prompt
 * on stdin, plain stdout) - it never touches the visible chat.
 *
 * Two jobs in one call:
 *   - a one-line English title for the snapshot;
 *   - whether the change CONTINUES the previous snapshot's work (used to group
 *     consecutive saves in the timeline - display only, no history rewriting).
 *
 * Provider follows the app-wide `aria.aiProvider` setting (auto → Claude first).
 * Everything is best-effort: if no provider is installed / logged in, or the
 * output can't be parsed, we return undefined and the caller falls back to a
 * plain timestamped title. Version control never depends on the AI.
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type AiProvider = 'claude' | 'codex';

export interface SnapshotSummary {
	/** True when this change continues the previous snapshot's task. */
	continuation: boolean;
	/** One-line English title (<= 60 chars). */
	message: string;
}

const isWin = process.platform === 'win32';
const HOME = os.homedir();

// Qoka's private home for tools it provisions itself (portable Node,
// npm-installed CLIs). These MUST match aria-skills/headlessCli so a
// self-provisioned CLI is found here too. On Windows npm's `.cmd` shims sit at
// the prefix root; on Unix they land under `<prefix>/bin`.
const ARIA_HOME = path.join(HOME, '.aria');
const ARIA_NODE_DIR = path.join(ARIA_HOME, 'node');
const ARIA_NPM_PREFIX = path.join(ARIA_HOME, 'npm');

/** Portable Node bin dir (root on Windows, `bin/` on Unix), if Qoka provisioned
 *  it - prepended to PATH so an npm-installed CLI's node shebang resolves. */
function ariaNodeBinDir(): string | undefined {
	const dir = isWin ? ARIA_NODE_DIR : path.join(ARIA_NODE_DIR, 'bin');
	try {
		return fs.existsSync(dir) ? dir : undefined;
	} catch {
		return undefined;
	}
}

/** nvm-installed bins (Unix layout). */
function nvmBinDirs(): string[] {
	const nvmRoot = path.join(HOME, '.nvm/versions/node');
	try {
		return fs.readdirSync(nvmRoot).map(v => path.join(nvmRoot, v, 'bin'));
	} catch {
		return [];
	}
}

/** Directories where a provider CLI may live, most-specific first. Covers the
 *  Windows npm shims + native installer locations and the Unix bin dirs - a
 *  GUI-launched Electron process often can't see these via PATH. Mirrors
 *  aria-skills/headlessCli.providerDirs so both find the same CLI. */
function providerDirs(): string[] {
	if (isWin) {
		const appdata = process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming');
		const localappdata = process.env.LOCALAPPDATA ?? path.join(HOME, 'AppData', 'Local');
		return [
			ARIA_NODE_DIR,                                   // portable node's own dir (npm.cmd etc.)
			ARIA_NPM_PREFIX,                                 // Qoka-managed npm global (.cmd shims at root)
			path.join(appdata, 'npm'),                       // default npm global on Windows
			path.join(HOME, '.local', 'bin'),                // Claude's Windows installer mirrors ~/.local/bin
			path.join(localappdata, 'Programs', 'claude'),   // alt Claude install location
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

/** Executable name variants to try. On Windows npm/native installers produce
 *  `.cmd`/`.exe` shims, never a bare extension-less file. */
function binNames(provider: AiProvider): string[] {
	return isWin ? [`${provider}.cmd`, `${provider}.exe`, `${provider}.bat`, provider] : [provider];
}

/** Resolve an executable path for a provider, or undefined if not found.
 *  GUI-launched Electron apps often run with a truncated PATH, so we probe the
 *  known install dirs first (with per-OS name variants) and only then scan PATH.
 *  Always returns a concrete, spawnable path (or undefined), which also keeps
 *  availableProviders() honest. */
function resolveBin(provider: AiProvider): string | undefined {
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
	// 2) Whatever PATH we do have (covers Homebrew/system installs on PATH, plus
	//    the login-shell dirs aria-skills folds in via ensureAriaBinsOnPath).
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

/** Which providers have a CLI on this machine (not necessarily logged in). */
export function availableProviders(): AiProvider[] {
	return (['claude', 'codex'] as AiProvider[]).filter(p => resolveBin(p) !== undefined);
}

/** The provider order implied by the aria.aiProvider setting (auto → Claude first). */
function providerOrder(): AiProvider[] {
	const pref = vscode.workspace.getConfiguration('aria').get<string>('aiProvider') ?? 'auto';
	const base: AiProvider[] = ['claude', 'codex'];
	return pref === 'claude' || pref === 'codex'
		? [pref, ...base.filter(p => p !== pref)]
		: base;
}

/** Headless argv per provider - prompt is fed on stdin. */
function headlessArgs(provider: AiProvider): string[] {
	return provider === 'claude'
		? ['--print', '--output-format', 'text']
		: ['exec', '--skip-git-repo-check', '-'];
}

function runWithStdin(bin: string, args: string[], input: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		// If Qoka provisioned a portable Node, put it on PATH so an npm-installed
		// CLI (e.g. codex) finds `node` for its shebang even with no system Node.
		const nodeBin = ariaNodeBinDir();
		const env = nodeBin
			? { ...process.env, PATH: nodeBin + path.delimiter + (process.env.PATH ?? '') }
			: process.env;
		// Windows: a `.cmd`/`.bat` shim (npm installs codex/claude this way) can't be
		// spawned directly on modern Node - it needs a shell. Quote the path so a
		// space (e.g. in the user profile) is safe; argv here are fixed literal flags.
		const useShell = isWin && /\.(cmd|bat)$/i.test(bin);
		const spawnBin = useShell ? `"${bin}"` : bin;
		const child = spawn(spawnBin, args, { stdio: ['pipe', 'pipe', 'pipe'], env, shell: useShell });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Timed out after ${timeoutMs}ms`)); }, timeoutMs);
		child.stdout.on('data', d => { stdout += d.toString(); });
		child.stderr.on('data', d => { stderr += d.toString(); });
		child.on('error', err => { clearTimeout(timer); reject(err); });
		child.on('close', code => {
			clearTimeout(timer);
			if (code === 0) { resolve(stdout); }
			else { reject(new Error(`${bin} exited ${code}: ${stderr.trim() || '(no stderr)'}`)); }
		});
		// A CLI that exits before reading stdin (not logged in / fast failure)
		// closes the pipe; without this listener the resulting EPIPE surfaces as
		// an uncaught exception in the extension host. Swallow it - the 'close'
		// handler already reports the real exit code.
		child.stdin.on('error', () => { });
		child.stdin.write(input);
		child.stdin.end();
	});
}

function buildPrompt(diff: string, prevMessage: string | undefined, prevFileCount: number): string {
	const prev = prevMessage
		? `PREVIOUS version: "${prevMessage}" (${prevFileCount} file${prevFileCount === 1 ? '' : 's'})`
		: 'PREVIOUS version: (this is the first save)';
	return [
		'You label a save for a researcher\'s version history.',
		'Given the CURRENT change (a diff) and the PREVIOUS version\'s summary:',
		'1) Decide if this CONTINUES the same task as the previous version, or starts a NEW one.',
		'2) Write ONE short line (<= 60 chars, plain, ALWAYS in ENGLISH regardless of the file language) describing what changed.',
		'Return ONLY this JSON, nothing else, no reasoning, no code fences:',
		'{"continuation": true|false, "message": "..."}',
		'',
		prev,
		'CURRENT CHANGE:',
		'```',
		diff,
		'```',
	].join('\n');
}

/** Pull the first {...} JSON object out of the model's stdout. */
function extractJson(text: string): SnapshotSummary | undefined {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) {
		return undefined;
	}
	try {
		const obj = JSON.parse(text.slice(start, end + 1));
		if (obj && typeof obj.message === 'string') {
			let message = obj.message.trim().replace(/\s+/g, ' ');
			if (message.length > 60) {
				message = message.slice(0, 60).trimEnd();
			}
			if (!message) {
				return undefined;
			}
			return { continuation: obj.continuation === true, message };
		}
	} catch {
		// not JSON
	}
	return undefined;
}

/**
 * Summarise a diff into a snapshot title + continuation flag. `provider`, if
 * given, forces a specific CLI; otherwise the aria.aiProvider order is used.
 * Returns undefined when no provider is usable or the response is unparseable.
 */
export async function summarizeDiff(
	diff: string,
	prevMessage: string | undefined,
	prevFileCount: number,
	provider?: AiProvider,
): Promise<SnapshotSummary | undefined> {
	if (!diff.trim()) {
		return undefined;
	}
	const order = provider ? [provider] : providerOrder();
	const prompt = buildPrompt(diff, prevMessage, prevFileCount);
	for (const p of order) {
		const bin = resolveBin(p);
		if (!bin) {
			continue;
		}
		try {
			const out = await runWithStdin(bin, headlessArgs(p), prompt, 30000);
			const parsed = extractJson(out);
			if (parsed) {
				return parsed;
			}
		} catch {
			// try the next provider
		}
	}
	return undefined;
}
