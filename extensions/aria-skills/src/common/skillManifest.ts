/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	MANIFEST_VERSION,
	SkillInfo,
	SkillsManifest,
} from './types';

/**
 * Qoka's skills manifest lives at ~/.config/aria/skills-manifest.json and
 * is the source of truth for "which skills did Qoka install and what does
 * the user care about for each?". The skill scripts themselves live in
 * ~/.claude/skills/ (so Claude Code can discover them), but this file
 * adds Qoka-specific metadata (category, autoApprove, install source,
 * env var requirements) that doesn't belong in the upstream skill.
 *
 * Keeping the manifest separate from ~/.claude/skills/ means an Qoka
 * uninstall leaves the skills functional for any other Claude Code user
 * on the same machine; only the Qoka-specific metadata is lost.
 */

const MANIFEST_DIR = path.join(os.homedir(), '.config', 'aria');
const MANIFEST_PATH = path.join(MANIFEST_DIR, 'skills-manifest.json');

/** Fresh manifest used when no on-disk file exists yet. */
function emptyManifest(): SkillsManifest {
	return {
		version: MANIFEST_VERSION,
		skills: [],
		categories: [],
		firstRunCompleted: false,
	};
}

/**
 * Read the manifest from disk. Missing file or parse failure both return
 * the empty default - Qoka can always rebuild the manifest by scanning
 * ~/.claude/skills/, so falling back here is safer than throwing.
 */
export function readManifest(): SkillsManifest {
	if (!fs.existsSync(MANIFEST_PATH)) {
		return emptyManifest();
	}
	try {
		const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
		const parsed = JSON.parse(raw) as Partial<SkillsManifest>;
		// Defensive: coerce missing fields to defaults so older manifests
		// from earlier versions still load.
		return {
			version: typeof parsed.version === 'number' ? parsed.version : MANIFEST_VERSION,
			skills: Array.isArray(parsed.skills) ? parsed.skills : [],
			categories: Array.isArray(parsed.categories) ? parsed.categories : [],
			firstRunCompleted: parsed.firstRunCompleted === true,
		};
	} catch {
		// Corrupted manifest - pretend it didn't exist. The user can
		// re-add their custom categories and skills from the Skills tab.
		return emptyManifest();
	}
}

/**
 * Write the manifest atomically. mkdirSync(...{ recursive: true }) creates
 * ~/.config/aria/ on first call, then the standard tmp+rename pattern
 * makes the write itself atomic.
 */
export function writeManifest(manifest: SkillsManifest): void {
	fs.mkdirSync(MANIFEST_DIR, { recursive: true });
	const tmp = `${MANIFEST_PATH}.tmp`;
	const body = JSON.stringify(manifest, null, 2);
	fs.writeFileSync(tmp, body, { mode: 0o644 });
	fs.renameSync(tmp, MANIFEST_PATH);
}

/** Add a new skill to the manifest, replacing any prior entry with the same name. */
export function upsertSkill(skill: SkillInfo): SkillsManifest {
	const m = readManifest();
	m.skills = m.skills.filter(s => s.name !== skill.name);
	m.skills.push(skill);
	// Make sure the skill's category is in the list so the filter shows it.
	if (skill.category && !m.categories.includes(skill.category)) {
		m.categories.push(skill.category);
	}
	writeManifest(m);
	return m;
}

/** Remove a skill (by name) from the manifest. Returns the updated manifest. */
export function removeSkill(name: string): SkillsManifest {
	const m = readManifest();
	m.skills = m.skills.filter(s => s.name !== name);
	writeManifest(m);
	return m;
}

/** Look up a single skill by name. Returns undefined if not present. */
export function findSkill(name: string): SkillInfo | undefined {
	return readManifest().skills.find(s => s.name === name);
}

/**
 * Patch in-place fields on a skill (category, autoApprove, envVars, etc.)
 * without disturbing the rest. Returns the updated skill, or undefined
 * if no skill with that name exists.
 */
export function updateSkill(
	name: string,
	patch: Partial<SkillInfo>,
): SkillInfo | undefined {
	const m = readManifest();
	const idx = m.skills.findIndex(s => s.name === name);
	if (idx < 0) {
		return undefined;
	}
	m.skills[idx] = { ...m.skills[idx], ...patch };
	// Keep the categories list in sync if the patch introduces a new one.
	const newCat = m.skills[idx].category;
	if (newCat && !m.categories.includes(newCat)) {
		m.categories.push(newCat);
	}
	writeManifest(m);
	return m.skills[idx];
}

/** Add a category to the manifest's category list. Idempotent. */
export function addCategory(category: string): SkillsManifest {
	const m = readManifest();
	const trimmed = category.trim();
	if (trimmed && !m.categories.includes(trimmed)) {
		m.categories.push(trimmed);
		writeManifest(m);
	}
	return m;
}

/**
 * Drop any category that no installed skill references. Qoka used to seed
 * the manifest with a fixed list (Literature, Protein, …) - leftover
 * entries pollute the filter dropdown after we switched to user-driven
 * categories. Called on every activation so older manifests self-heal.
 */
export function reconcileCategories(): void {
	const m = readManifest();
	const used = new Set<string>();
	for (const s of m.skills) {
		if (s.category) {
			used.add(s.category);
		}
	}
	const filtered = m.categories.filter(c => used.has(c));
	if (filtered.length !== m.categories.length) {
		m.categories = filtered;
		writeManifest(m);
	}
}

/** Mark the first-run wizard as completed so it doesn't replay. */
export function markFirstRunCompleted(): void {
	const m = readManifest();
	if (!m.firstRunCompleted) {
		m.firstRunCompleted = true;
		writeManifest(m);
	}
}

/** Absolute manifest path, for surfaces (e.g. error messages) that need it. */
export function manifestPath(): string {
	return MANIFEST_PATH;
}
