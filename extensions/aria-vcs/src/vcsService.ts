/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

export interface Snapshot {
	hash: string;
	timestamp: number;       // ms since epoch
	message: string;
	filesChanged: number;
}

export interface StatusInfo {
	isRepo: boolean;
	unsavedChanges: number;  // count of modified + untracked files
	hasHead: boolean;        // false means no snapshots yet
}

export type FileChangeKind = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';

export interface FileChange {
	path: string;            // path relative to the workspace root
	kind: FileChangeKind;
	additions?: number;      // lines added (modified / added files)
	deletions?: number;      // lines removed
}

/**
 * Thin wrapper around the `git` command-line tool. All public methods take a
 * workspace folder path and run git inside it.
 *
 * The user never sees the word "git": this layer exists purely so the Versions
 * view in Easy mode can speak the Mercurial-style language of "snapshots".
 */
export class VcsService {

	async getStatus(workspacePath: string): Promise<StatusInfo> {
		const repoPath = path.join(workspacePath, '.git');
		const isRepo = fs.existsSync(repoPath);
		if (!isRepo) {
			return { isRepo: false, unsavedChanges: 0, hasHead: false };
		}

		let hasHead = true;
		try {
			await execAsync('git rev-parse HEAD', { cwd: workspacePath });
		} catch {
			hasHead = false;
		}

		let unsavedChanges = 0;
		try {
			const { stdout } = await execAsync('git status --porcelain --untracked-files=all', { cwd: workspacePath });
			unsavedChanges = stdout.split('\n').filter(line => line.trim().length > 0).length;
		} catch {
			// ignore
		}

		return { isRepo, unsavedChanges, hasHead };
	}

	async initRepo(workspacePath: string): Promise<void> {
		await execAsync('git init', { cwd: workspacePath });
		// Set up a default identity so commits work without external config.
		await execAsync('git config user.email "aria@localhost"', { cwd: workspacePath }).catch(() => { });
		await execAsync('git config user.name "Aria User"', { cwd: workspacePath }).catch(() => { });
	}

	async saveSnapshot(workspacePath: string, message: string, paths?: readonly string[]): Promise<Snapshot | undefined> {
		const status = await this.getStatus(workspacePath);
		if (!status.isRepo) {
			await this.initRepo(workspacePath);
		}

		// `paths` lets the caller restrict the snapshot to a subset of changed
		// files. When undefined or empty, fall back to "include everything",
		// matching the Mercurial default of committing every tracked change.
		if (paths && paths.length > 0) {
			// `git add --` accepts file paths after the separator; quote each so
			// names with spaces or special characters round-trip safely.
			const quoted = paths.map(p => `"${p.replace(/"/g, '\\"')}"`).join(' ');
			await execAsync(`git add -- ${quoted}`, { cwd: workspacePath });
		} else {
			await execAsync('git add -A', { cwd: workspacePath });
		}

		// Check whether there is anything to commit (avoids "nothing to commit" errors).
		const { stdout: staged } = await execAsync('git diff --cached --name-only', { cwd: workspacePath });
		if (staged.trim().length === 0) {
			return undefined;
		}

		const safeMessage = message.replace(/"/g, '\\"');
		await execAsync(`git commit -m "${safeMessage}"`, { cwd: workspacePath });

		const recent = await this.getRecentSnapshots(workspacePath, 1);
		return recent[0];
	}

	async getRecentSnapshots(workspacePath: string, limit: number = 10): Promise<Snapshot[]> {
		const status = await this.getStatus(workspacePath);
		if (!status.isRepo || !status.hasHead) {
			return [];
		}

		// Custom format: hash | unix-timestamp | message
		// Use a delimiter unlikely to appear in commit messages.
		const sep = '<<ARIA-VCS-SEP>>';
		const { stdout } = await execAsync(
			`git log -n ${limit} --pretty=format:"%H${sep}%ct${sep}%s"`,
			{ cwd: workspacePath }
		);

		const lines = stdout.split('\n').filter(l => l.trim().length > 0);
		const snapshots: Snapshot[] = [];
		for (const line of lines) {
			const [hash, ts, message] = line.split(sep);
			if (!hash || !ts) {
				continue;
			}

			let filesChanged = 0;
			try {
				const { stdout: numstat } = await execAsync(
					`git show --stat --format="" ${hash}`,
					{ cwd: workspacePath }
				);
				const match = numstat.match(/(\d+) files? changed/);
				if (match) {
					filesChanged = parseInt(match[1], 10);
				}
			} catch {
				// ignore
			}

			snapshots.push({
				hash,
				timestamp: parseInt(ts, 10) * 1000,
				message: message ?? '',
				filesChanged,
			});
		}
		return snapshots;
	}

	async getChanges(workspacePath: string): Promise<FileChange[]> {
		const status = await this.getStatus(workspacePath);
		if (!status.isRepo) {
			return [];
		}

		// `--untracked-files=all` makes git report every file inside untracked
		// directories instead of collapsing them to "dir/". Without this flag
		// the user sees a single row for a new folder full of files.
		const { stdout: porcelain } = await execAsync('git status --porcelain --untracked-files=all', { cwd: workspacePath });
		const lines = porcelain.split('\n').filter(l => l.trim().length > 0);
		const changes: FileChange[] = [];
		for (const line of lines) {
			// Format: "XY path" or "XY orig -> new" for renames.
			const code = line.substring(0, 2);
			let path = line.substring(3).trim();
			let kind: FileChangeKind;

			if (code === '??') {
				kind = 'untracked';
			} else if (code.includes('R')) {
				kind = 'renamed';
				const arrowIdx = path.indexOf(' -> ');
				if (arrowIdx >= 0) {
					path = path.substring(arrowIdx + 4);
				}
			} else if (code.includes('A')) {
				kind = 'added';
			} else if (code.includes('D')) {
				kind = 'deleted';
			} else {
				kind = 'modified';
			}

			changes.push({ path, kind });
		}

		// Line counts for tracked changes. `--numstat` reports tabs between
		// numbers and filename; untracked files won't appear so they keep no count.
		try {
			const { stdout: numstat } = await execAsync('git diff --numstat HEAD', { cwd: workspacePath });
			const numstatMap = new Map<string, { add: number; del: number }>();
			for (const line of numstat.split('\n')) {
				const parts = line.split('\t');
				if (parts.length < 3) {
					continue;
				}
				const [a, d, p] = parts;
				const add = parseInt(a, 10);
				const del = parseInt(d, 10);
				if (!isNaN(add) && !isNaN(del) && p) {
					numstatMap.set(p, { add, del });
				}
			}
			for (const change of changes) {
				const ns = numstatMap.get(change.path);
				if (ns) {
					change.additions = ns.add;
					change.deletions = ns.del;
				}
			}
		} catch {
			// no HEAD yet (no snapshots) — skip line counts
		}

		return changes;
	}

	async showFileAt(workspacePath: string, ref: string, filePath: string): Promise<string> {
		// Strip leading slash that `vscode.Uri.parse` adds to the path component.
		const rel = filePath.startsWith('/') ? filePath.slice(1) : filePath;
		try {
			const { stdout } = await execAsync(`git show ${ref}:${rel}`, { cwd: workspacePath });
			return stdout;
		} catch {
			return '';
		}
	}

	async restoreSnapshot(workspacePath: string, hash: string): Promise<void> {
		// `git reset --mixed` moves HEAD and INDEX to <hash> while preserving
		// the working tree. The diff between the working tree and the new
		// INDEX shows up as unstaged changes in the Versions panel's Changes
		// list, ready to be selectively re-snapshotted.
		//
		// Tag the previous HEAD before resetting so users have a one-click
		// recovery anchor that survives further git operations (unlike
		// ORIG_HEAD, which is overwritten by the next reset/merge). The tag
		// name is timestamped and lives in `refs/tags/aria-pre-goback-*`.
		try {
			const tagName = `aria-pre-goback-${Date.now()}`;
			await execAsync(`git tag ${tagName} HEAD`, { cwd: workspacePath });
		} catch {
			// best-effort — proceed even if the tag couldn't be created
		}

		// The actual go-back. Working tree is untouched, so files that
		// existed in later snapshots stay on disk; git just no longer
		// considers them part of the snapshot history beyond <hash>.
		await execAsync(`git reset --mixed ${hash}`, { cwd: workspacePath });
	}

	async getSnapshotChanges(workspacePath: string, hash: string): Promise<FileChange[]> {
		// What changed *in* this snapshot (relative to its parent). Used by
		// the Versions view when the user expands a snapshot row.
		const sep = '<<ARIA-NAMESTAT-SEP>>';
		let stdout = '';
		try {
			// `--root` lets us still get output when the snapshot has no parent
			// (the very first snapshot in the repo).
			const result = await execAsync(
				`git show --name-status --format="" --root ${hash}`,
				{ cwd: workspacePath }
			);
			stdout = result.stdout;
		} catch {
			return [];
		}

		const changes: FileChange[] = [];
		for (const line of stdout.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			// Format: "M\tpath" or "A\tpath" or "R100\told\tnew" etc.
			const parts = trimmed.split('\t');
			const code = parts[0];
			const path = parts[parts.length - 1];
			let kind: FileChangeKind;
			if (code === 'A') { kind = 'added'; }
			else if (code === 'D') { kind = 'deleted'; }
			else if (code.startsWith('R')) { kind = 'renamed'; }
			else { kind = 'modified'; }
			changes.push({ path, kind });
		}

		// Line counts: `--numstat` reports +/- per file in the same diff.
		try {
			const { stdout: ns } = await execAsync(
				`git show --numstat --format="" --root ${hash}`,
				{ cwd: workspacePath }
			);
			const nsMap = new Map<string, { add: number; del: number }>();
			for (const line of ns.split('\n')) {
				const parts = line.split('\t');
				if (parts.length < 3) { continue; }
				const [a, d, p] = parts;
				const add = parseInt(a, 10);
				const del = parseInt(d, 10);
				if (!isNaN(add) && !isNaN(del) && p) {
					nsMap.set(p, { add, del });
				}
			}
			for (const c of changes) {
				const stat = nsMap.get(c.path);
				if (stat) {
					c.additions = stat.add;
					c.deletions = stat.del;
				}
			}
		} catch {
			// numstat optional
		}

		return changes;
	}
}
