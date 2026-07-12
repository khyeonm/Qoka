/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Names a snapshot for the Versions view by asking the user's own AI CLI
 * (Claude Code or Codex) to summarise the diff. Runs the CLI HEADLESS (prompt
 * on stdin, plain stdout) — it never touches the visible chat.
 *
 * Two jobs in one call:
 *   - a one-line English title for the snapshot;
 *   - whether the change CONTINUES the previous snapshot's work (used to group
 *     consecutive saves in the timeline — display only, no history rewriting).
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

const BIN_CANDIDATES: Record<AiProvider, string[]> = {
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

function withNvm(name: AiProvider, candidates: string[]): string[] {
	const extra: string[] = [];
	try {
		for (const v of fs.readdirSync(NVM_DIR)) {
			extra.push(path.join(NVM_DIR, v, 'bin', name));
		}
	} catch {
		// no nvm
	}
	return [...candidates, ...extra];
}

/** Resolve an executable path for a provider, or undefined if not found.
 *  GUI-launched Electron apps often run with a truncated PATH that omits
 *  ~/.local/bin, nvm, and /opt/homebrew/bin — so we must NOT just trust the
 *  bare name. Prefer an absolute candidate that exists on disk; only fall back
 *  to resolving the bare name against whatever PATH we do have. This always
 *  returns a concrete, spawnable path (or undefined), which also keeps
 *  availableProviders() honest. */
function resolveBin(provider: AiProvider): string | undefined {
	const candidates = withNvm(provider, BIN_CANDIDATES[provider]);
	// 1) Absolute candidates that actually exist.
	for (const c of candidates) {
		if (c.includes('/')) {
			try {
				if (fs.existsSync(c)) {
					return c;
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

/** Headless argv per provider — prompt is fed on stdin. */
function headlessArgs(provider: AiProvider): string[] {
	return provider === 'claude'
		? ['--print', '--output-format', 'text']
		: ['exec', '--skip-git-repo-check', '-'];
}

function runWithStdin(bin: string, args: string[], input: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
		// an uncaught exception in the extension host. Swallow it — the 'close'
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
