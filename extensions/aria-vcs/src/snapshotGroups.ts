/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Snapshot grouping — a DISPLAY-only concept. Every save is its own git commit
 * (never amended), so any snapshot stays individually restorable. Consecutive
 * snapshots that continue the same task share a `groupId`; the Versions
 * timeline collapses them into one expandable entry.
 *
 * The mapping `commitHash -> { groupId, continuation }` lives in a sidecar JSON
 * at `<workspace>/.aria/snapshot-groups.json`, kept OUT of git (added to
 * `.git/info/exclude`) so it never pollutes the user's history or the Advanced
 * mode diff. If the sidecar is lost the timeline just shows flat — no data loss.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface SnapshotGroupInfo {
	groupId: string;
	/** True when this snapshot continued the previous one's task. */
	continuation: boolean;
}

type GroupMap = Record<string, SnapshotGroupInfo>;

function ariaDir(cwd: string): string {
	return path.join(cwd, '.aria');
}

function sidecarPath(cwd: string): string {
	return path.join(ariaDir(cwd), 'snapshot-groups.json');
}

/** Path we git-exclude — ONLY the sidecar, never the whole `.aria/` dir (which
 *  may hold tracked project data like roadmap.json). Keeping it out of git also
 *  stops `git add -A` in saveSnapshot from committing it into every snapshot. */
const EXCLUDE_LINE = '.aria/snapshot-groups.json';

/** Ensure the sidecar is git-ignored via `.git/info/exclude` (no tracked
 *  .gitignore change needed). Best-effort. */
function ensureExcluded(cwd: string): void {
	try {
		const excludePath = path.join(cwd, '.git', 'info', 'exclude');
		let content = '';
		try { content = fs.readFileSync(excludePath, 'utf8'); } catch { /* may not exist yet */ }
		const already = content.split('\n').some(l => l.trim() === EXCLUDE_LINE);
		if (!already) {
			fs.mkdirSync(path.dirname(excludePath), { recursive: true });
			fs.appendFileSync(excludePath, (content.endsWith('\n') || content === '' ? '' : '\n') + EXCLUDE_LINE + '\n');
		}
	} catch {
		// no .git yet, or read-only — harmless; the sidecar is non-essential.
	}
}

function readMap(cwd: string): GroupMap {
	try {
		const raw = fs.readFileSync(sidecarPath(cwd), 'utf8');
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed as GroupMap : {};
	} catch {
		return {};
	}
}

function writeMap(cwd: string, map: GroupMap): void {
	try {
		// Exclude BEFORE creating the file so git never sees it as untracked.
		ensureExcluded(cwd);
		fs.mkdirSync(ariaDir(cwd), { recursive: true });
		fs.writeFileSync(sidecarPath(cwd), JSON.stringify(map, null, 2), 'utf8');
	} catch {
		// Storage failure — grouping just won't persist; snapshots are unaffected.
	}
}

/** The group info recorded for a commit, or undefined if none. */
export function getGroup(cwd: string, hash: string): SnapshotGroupInfo | undefined {
	return readMap(cwd)[hash];
}

/**
 * Record grouping for a freshly-saved snapshot.
 *  - `continuation` true  → reuse the previous snapshot's group (fall back to a
 *    new group if the previous one has no recorded group);
 *  - `continuation` false → start a fresh group.
 * Returns the assigned groupId.
 */
export function recordGroup(cwd: string, hash: string, prevHash: string | undefined, continuation: boolean): string {
	const map = readMap(cwd);
	let groupId: string;
	if (continuation && prevHash && map[prevHash]) {
		groupId = map[prevHash].groupId;
	} else {
		groupId = 'g-' + crypto.randomBytes(5).toString('hex');
	}
	map[hash] = { groupId, continuation };
	writeMap(cwd, map);
	return groupId;
}
