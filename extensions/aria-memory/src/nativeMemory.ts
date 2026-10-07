/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Disable Claude Code's native auto-memory for Qoka's Claude sessions so it stops
 * capturing into `<config>/projects/<...>/memory/` and the `aria-memory` MCP tools
 * become the sole, provider-neutral memory store (needed for Codex consistency).
 *
 * The native engine only honours this from an on-disk settings file loaded via
 * `settingSources` - inline SDK options (`settings` / `managedSettings`) are
 * ignored for `autoMemoryEnabled`, confirmed by testing. We write it into the
 * USER settings file of Qoka's OWN Claude config, ~/.qoka/claude/settings.json
 * (the isolated CLAUDE_CONFIG_DIR every Qoka-launched Claude reads; the same
 * file aria-skills registers its hook in).
 *
 * Deliberately NOT the project's `.claude/settings.local.json` and NOT the
 * system `~/.claude/settings.json`: both are read by the user's own standalone
 * `claude` too, so writing either would switch off native memory outside Qoka.
 * Qoka must not change how the user's own Claude Code behaves.
 *
 * Non-destructive: merges the one key into whatever else is in the file, and
 * bails without writing if the file is present but unparseable or not an
 * object - better to leave native memory on than to clobber the config.
 */
const QOKA_CLAUDE_SETTINGS = path.join(os.homedir(), '.qoka', 'claude', 'settings.json');

export function ensureNativeMemoryDisabled(): void {
	const file = QOKA_CLAUDE_SETTINGS;
	const dir = path.dirname(file);

	let settings: Record<string, unknown> = {};
	try {
		if (fs.existsSync(file)) {
			const raw = fs.readFileSync(file, 'utf8').trim();
			const parsed = raw ? JSON.parse(raw) : {};
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				console.warn('[aria-memory] Qoka Claude settings.json is not a JSON object; leaving it untouched');
				return;
			}
			settings = parsed as Record<string, unknown>;
		}
	} catch (e) {
		console.warn(`[aria-memory] could not parse Qoka Claude settings.json; leaving it untouched: ${(e as Error).message}`);
		return;
	}

	if (settings.autoMemoryEnabled === false) {
		return; // already disabled - no write
	}

	settings.autoMemoryEnabled = false;
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
		console.log(`[aria-memory] disabled native auto-memory in ${file}`);
	} catch (e) {
		console.warn(`[aria-memory] could not write Qoka Claude settings.json: ${(e as Error).message}`);
	}
}
