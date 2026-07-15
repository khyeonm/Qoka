/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Run git with an argv array (NO shell). This avoids any shell interpretation of
 * commit messages / file paths, so titles like `add $5 tier`, names with
 * backticks, or a trailing `\` can never break the command or inject anything.
 */
async function git(args: string[], cwd: string, opts: { maxBuffer?: number } = {}): Promise<string> {
	const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: opts.maxBuffer });
	return stdout;
}

export interface Snapshot {
	hash: string;
	timestamp: number;       // ms since epoch
	message: string;
	filesChanged: number;
	/** Display-only grouping id (from the snapshot-groups sidecar); consecutive
	 *  snapshots that continue the same task share it. Filled by the command
	 *  layer, not git. */
	groupId?: string;
	/** True when this snapshot continued the previous one's task. */
	continuation?: boolean;
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
			await git(['rev-parse', 'HEAD'], workspacePath);
		} catch {
			hasHead = false;
		}

		let unsavedChanges = 0;
		try {
			const stdout = await git(['status', '--porcelain', '--untracked-files=all'], workspacePath);
			unsavedChanges = stdout.split('\n').filter(line => line.trim().length > 0).length;
		} catch {
			// ignore
		}

		return { isRepo, unsavedChanges, hasHead };
	}

	async initRepo(workspacePath: string): Promise<void> {
		await git(['init'], workspacePath);
		// Keep assistant/app working files out of the user's snapshots — they're
		// tool machinery (session config, MCP ports that change every launch),
		// not research content, and would only add noise to every snapshot diff.
		this.ensureGitignore(workspacePath);
		// Make sure commits will succeed without any user setup. If the user
		// already has user.name / user.email configured globally we keep
		// using those — only fall back to an Aria-local identity when no
		// global config is found, so we don't override the user's real
		// name on shared / multi-tool machines.
		await this.ensureLocalIdentity(workspacePath);
	}

	/** Write (or top up) a project `.gitignore` so Aria's own working files never
	 *  land in a snapshot. Idempotent — the Aria block is only appended once. */
	private ensureGitignore(workspacePath: string): void {
		const HEADER = '# --- Aria: assistant/app working files (kept out of snapshots) ---';
		const block = [
			HEADER,
			'.claude/',        // Claude Code project/session config (MCP, settings)
			'.codex/',         // Codex working dir
			'.mcp.json',       // MCP server config — ports change every launch
			'.aria/',          // Aria app state (roadmaps etc.) — managed by the app
			'node_modules/',
			'.DS_Store',
			'',
		].join('\n');
		const gitignorePath = path.join(workspacePath, '.gitignore');
		let existing = '';
		try { existing = fs.readFileSync(gitignorePath, 'utf8'); } catch { /* no file yet */ }
		if (existing.includes(HEADER)) {
			return;
		}
		const sep = existing && !existing.endsWith('\n') ? '\n' : '';
		try { fs.writeFileSync(gitignorePath, existing + sep + block); } catch { /* best-effort */ }
	}

	private async ensureLocalIdentity(workspacePath: string): Promise<void> {
		const hasGlobalIdentity = async (key: string): Promise<boolean> => {
			try {
				const stdout = await git(['config', '--global', key], workspacePath);
				return stdout.trim().length > 0;
			} catch {
				return false;
			}
		};

		if (!(await hasGlobalIdentity('user.email'))) {
			await git(['config', 'user.email', 'aria@localhost'], workspacePath).catch(() => { });
		}
		if (!(await hasGlobalIdentity('user.name'))) {
			await git(['config', 'user.name', 'Aria User'], workspacePath).catch(() => { });
		}
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
			await git(['add', '--', ...paths], workspacePath);
		} else {
			await git(['add', '-A'], workspacePath);
		}

		// Check whether there is anything to commit (avoids "nothing to commit" errors).
		const staged = await git(['diff', '--cached', '--name-only'], workspacePath);
		if (staged.trim().length === 0) {
			return undefined;
		}

		await git(['commit', '-m', message], workspacePath);

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
		const stdout = await git(
			['log', '-n', String(limit), `--pretty=format:%H${sep}%ct${sep}%s`],
			workspacePath
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
				const numstat = await git(['show', '--stat', '--format=', hash], workspacePath);
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
		let status = await this.getStatus(workspacePath);
		if (!status.isRepo) {
			// The folder isn't tracked yet. Start tracking now (git init) so files
			// the user has ALREADY added show up as changes for their first
			// snapshot — otherwise the panel looks empty and they think nothing was
			// detected. No-op after the first time; returns [] if the machine has
			// no git available (e.g. Windows without git installed).
			try {
				await this.initRepo(workspacePath);
			} catch {
				return [];
			}
			status = await this.getStatus(workspacePath);
			if (!status.isRepo) {
				return [];
			}
		}

		// `--untracked-files=all` makes git report every file inside untracked
		// directories instead of collapsing them to "dir/". Without this flag
		// the user sees a single row for a new folder full of files.
		const porcelain = await git(['status', '--porcelain', '--untracked-files=all'], workspacePath);
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
			const numstat = await git(['diff', '--numstat', 'HEAD'], workspacePath);
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

	/**
	 * Plain-text diff of what changed since the last snapshot — fed to the AI
	 * summariser. Includes tracked changes (`git diff HEAD`) plus the contents of
	 * untracked files (which git diff omits). Scoped to `paths` when the caller
	 * saved only a subset, so the summary matches the actual snapshot. Bounded so
	 * a huge change doesn't make an enormous prompt.
	 */
	async getDiffText(workspacePath: string, paths?: readonly string[]): Promise<string> {
		const status = await this.getStatus(workspacePath);
		if (!status.isRepo) {
			return '';
		}
		const scope = paths && paths.length > 0 ? new Set(paths) : undefined;
		const MAX = 60000;
		let out = '';

		// Tracked changes vs HEAD (staged + unstaged). No HEAD yet → skip (the
		// untracked pass below still captures brand-new files on the first save).
		if (status.hasHead) {
			const args = scope
				? ['diff', 'HEAD', '--', ...Array.from(scope)]
				: ['diff', 'HEAD'];
			try {
				out += await git(args, workspacePath, { maxBuffer: 16 * 1024 * 1024 });
			} catch {
				// ignore
			}
		}

		// Untracked files: git diff omits them, so append their contents as new files.
		try {
			const stdout = await git(['status', '--porcelain', '--untracked-files=all'], workspacePath);
			for (const line of stdout.split('\n')) {
				if (!line.startsWith('??')) {
					continue;
				}
				const p = line.substring(3).trim();
				if (scope && !scope.has(p)) {
					continue;
				}
				if (out.length > MAX) {
					break;
				}
				try {
					const content = fs.readFileSync(path.join(workspacePath, p), 'utf8');
					out += `\n=== new file: ${p} ===\n${content}\n`;
				} catch {
					// binary or unreadable — skip
				}
			}
		} catch {
			// ignore
		}

		return out.length > MAX ? out.slice(0, MAX) + '\n… (diff truncated)' : out;
	}

	async showFileAt(workspacePath: string, ref: string, filePath: string): Promise<string> {
		// Strip leading slash that `vscode.Uri.parse` adds to the path component.
		const rel = filePath.startsWith('/') ? filePath.slice(1) : filePath;
		try {
			return await git(['show', `${ref}:${rel}`], workspacePath);
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
			await git(['tag', tagName, 'HEAD'], workspacePath);
		} catch {
			// best-effort — proceed even if the tag couldn't be created
		}

		// The actual go-back. Working tree is untouched, so files that
		// existed in later snapshots stay on disk; git just no longer
		// considers them part of the snapshot history beyond <hash>.
		await git(['reset', '--mixed', hash], workspacePath);
	}

	async getSnapshotChanges(workspacePath: string, hash: string): Promise<FileChange[]> {
		// What changed *in* this snapshot (relative to its parent). Used by
		// the Versions view when the user expands a snapshot row.
		let stdout = '';
		try {
			// `--root` lets us still get output when the snapshot has no parent
			// (the very first snapshot in the repo).
			stdout = await git(['show', '--name-status', '--format=', '--root', hash], workspacePath);
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
			const ns = await git(['show', '--numstat', '--format=', '--root', hash], workspacePath);
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
