/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Disable Claude Code's native auto-memory for the open workspace so it stops
 * capturing into `~/.claude/projects/<...>/memory/` and the `aria-memory` MCP
 * tools become the sole, provider-neutral memory store (needed for Codex
 * consistency later).
 *
 * The native engine only honours this from an on-disk settings file loaded via
 * `settingSources` - inline SDK options (`settings` / `managedSettings`) are
 * ignored for `autoMemoryEnabled`, confirmed by testing. We write it into
 * `.claude/settings.local.json` (the 'local' scope), NOT `.claude/settings.json`:
 *   - `settings.local.json` is gitignored by convention, so we never pollute
 *     the user's committed repo.
 *   - 'local' outranks 'project'/'user' in the settings hierarchy, so it wins.
 *
 * Scope is deliberately per-project, not the global `~/.claude/settings.json`:
 * that keeps native memory working for the user's standalone `claude` CLI
 * sessions (where the aria-memory MCP server isn't running), and only unifies
 * memory inside Aria.
 *
 * Non-destructive: merges the one key into whatever else is in the file, and
 * bails without writing if the file is present but unparseable or not an
 * object - better to leave native memory on than to clobber the user's config.
 */
export function ensureNativeMemoryDisabled(): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) { return; }

	const dir = path.join(folder.uri.fsPath, '.claude');
	const file = path.join(dir, 'settings.local.json');

	let settings: Record<string, unknown> = {};
	try {
		if (fs.existsSync(file)) {
			const raw = fs.readFileSync(file, 'utf8').trim();
			const parsed = raw ? JSON.parse(raw) : {};
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				console.warn('[aria-memory] settings.local.json is not a JSON object; leaving it untouched');
				return;
			}
			settings = parsed as Record<string, unknown>;
		}
	} catch (e) {
		console.warn(`[aria-memory] could not parse settings.local.json; leaving it untouched: ${(e as Error).message}`);
		return;
	}

	if (settings.autoMemoryEnabled === false) {
		return; // already disabled - no write, no git noise
	}

	settings.autoMemoryEnabled = false;
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
		console.log('[aria-memory] disabled native auto-memory via .claude/settings.local.json');
	} catch (e) {
		console.warn(`[aria-memory] could not write settings.local.json: ${(e as Error).message}`);
	}
}
