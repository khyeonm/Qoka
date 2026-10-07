/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { QOKA_CLAUDE_CONFIG_DIR } from './headlessCli';

/**
 * Manage the user-level settings file of Qoka's OWN Claude config. Qoka writes
 * the per-skill auto-approve preferences into ~/.qoka/claude/settings.json (the
 * isolated CLAUDE_CONFIG_DIR every Qoka-launched Claude reads) so the user
 * doesn't get a permission prompt every time Claude wants to invoke a skill
 * they've already vetted from the Settings tab.
 *
 * Never the system ~/.claude/settings.json: that file belongs to the user's own
 * Claude Code, and Qoka must not change it.
 *
 * The file format is JSON; we preserve unknown top-level keys verbatim so
 * editing the Qoka toggle doesn't clobber settings put there for unrelated
 * reasons (e.g. the hook ariaHooks registers in the same file).
 */

const SETTINGS_PATH = path.join(QOKA_CLAUDE_CONFIG_DIR, 'settings.json');

interface PermissionsBlock {
	allow?: string[];
	deny?: string[];
}

interface ClaudeSettings {
	permissions?: PermissionsBlock;
	[key: string]: unknown;
}

export function settingsPath(): string {
	return SETTINGS_PATH;
}

/** Read the settings file. `{}` when it does not exist yet; `undefined` when it
 *  exists but is not a JSON object - callers must then leave it untouched rather
 *  than overwrite (and lose) its contents. */
function readSettings(): ClaudeSettings | undefined {
	if (!fs.existsSync(SETTINGS_PATH)) {
		return {};
	}
	try {
		const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
		if (!raw.trim()) { return {}; }
		const parsed = JSON.parse(raw);
		return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function writeSettings(settings: ClaudeSettings): void {
	fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
	const tmp = `${SETTINGS_PATH}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
	fs.renameSync(tmp, SETTINGS_PATH);
}

/**
 * The permission token Claude Code matches against when a skill is
 * invoked. Format mirrors Claude Code's tool-pattern syntax -
 * `Skill(name)` - so an entry in `permissions.allow` whitelists this
 * skill without affecting unrelated tools.
 */
export function skillPermissionToken(name: string): string {
	return `Skill(${name})`;
}

/**
 * Toggle a single skill's allow-list membership. `desired === true`
 * adds the token if absent; `desired === false` removes it if present.
 * Idempotent on either side - calling twice with the same value is a
 * no-op.
 */
export function setSkillAutoApprove(skillName: string, desired: boolean): void {
	syncAutoApproveFlags([{ name: skillName, autoApprove: desired }]);
}

/** Read the current state from Claude's settings file (not from the
 *  Qoka manifest, which can drift). */
export function isSkillAutoApproved(skillName: string): boolean {
	const settings = readSettings();
	return (settings?.permissions?.allow ?? []).includes(skillPermissionToken(skillName));
}

/**
 * Push the Qoka manifest's per-skill auto-approve flags into the
 * Claude settings file in one shot. Used when we install a batch of
 * skills (first-run wizard) so the settings file is consistent without
 * a flurry of individual writes.
 */
export function syncAutoApproveFlags(flags: { name: string; autoApprove: boolean }[]): void {
	const settings = readSettings();
	if (!settings) {
		console.warn(`[aria-skills] ${SETTINGS_PATH} is not valid JSON; leaving it untouched`);
		return;
	}
	const before = settings.permissions?.allow ?? [];
	const allow = new Set(before);
	for (const f of flags) {
		const token = skillPermissionToken(f.name);
		if (f.autoApprove) {
			allow.add(token);
		} else {
			allow.delete(token);
		}
	}
	const after = [...allow].sort();
	// Only write when the allow list actually changes, so a no-op (e.g. removing
	// a token that was never there) never creates or rewrites the file.
	if (after.length === before.length && after.every(t => before.includes(t))) {
		return;
	}
	settings.permissions = { ...(settings.permissions ?? {}), allow: after };
	writeSettings(settings);
}
