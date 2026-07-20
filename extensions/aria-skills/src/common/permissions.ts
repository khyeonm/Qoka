/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Manage Claude Code's user-level settings file. Qoka writes the
 * per-skill auto-approve preferences into ~/.claude/settings.json so
 * the user doesn't get a permission prompt every time Claude wants to
 * invoke a skill they've already vetted from the Skills tab.
 *
 * The file format is JSON; we preserve unknown top-level keys verbatim
 * so editing the Qoka toggle doesn't clobber settings Claude Code (or
 * the user) put there for unrelated reasons.
 */

const SETTINGS_PATH = path.join(os.homedir(), '.claude/settings.json');

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

function readSettings(): ClaudeSettings {
	if (!fs.existsSync(SETTINGS_PATH)) {
		return {};
	}
	try {
		const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		return (parsed && typeof parsed === 'object') ? parsed : {};
	} catch {
		// Corrupt JSON - return empty rather than throw, the writer will
		// regenerate on save.
		return {};
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
	const settings = readSettings();
	const token = skillPermissionToken(skillName);
	settings.permissions = settings.permissions ?? {};
	const allow = new Set(settings.permissions.allow ?? []);
	if (desired) {
		allow.add(token);
	} else {
		allow.delete(token);
	}
	settings.permissions.allow = [...allow].sort();
	writeSettings(settings);
}

/** Read the current state from Claude's settings file (not from the
 *  Qoka manifest, which can drift). */
export function isSkillAutoApproved(skillName: string): boolean {
	const settings = readSettings();
	return (settings.permissions?.allow ?? []).includes(skillPermissionToken(skillName));
}

/**
 * Push the Qoka manifest's per-skill auto-approve flags into the
 * Claude settings file in one shot. Used when we install a batch of
 * skills (first-run wizard) so the settings file is consistent without
 * a flurry of individual writes.
 */
export function syncAutoApproveFlags(flags: { name: string; autoApprove: boolean }[]): void {
	const settings = readSettings();
	settings.permissions = settings.permissions ?? {};
	const allow = new Set(settings.permissions.allow ?? []);
	for (const f of flags) {
		const token = skillPermissionToken(f.name);
		if (f.autoApprove) {
			allow.add(token);
		} else {
			allow.delete(token);
		}
	}
	settings.permissions.allow = [...allow].sort();
	writeSettings(settings);
}
