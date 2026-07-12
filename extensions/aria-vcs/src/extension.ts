/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { VcsService, Snapshot, StatusInfo, FileChange } from './vcsService';
import { summarizeDiff, availableProviders, AiProvider } from './aiSummarizer';
import { recordGroup, getGroup } from './snapshotGroups';

/** Returned by aria.vcs.prepareSnapshot — everything the Save dialog needs. */
export interface SnapshotDraft {
	/** AI (or fallback) title to pre-fill the name field. */
	suggestedTitle: string;
	/** Did the AI judge this a continuation of the previous snapshot? */
	continuation: boolean;
	/** Previous snapshot's title, shown as the "group with …" label. Undefined
	 *  when there is no previous snapshot. */
	previousTitle?: string;
	/** Whether the AI actually ran (false → title is a plain template). */
	aiUsed: boolean;
	/** Provider CLIs detected on this machine. */
	providers: AiProvider[];
}

export function activate(context: vscode.ExtensionContext): void {

	const service = new VcsService();

	function activeWorkspacePath(): string | undefined {
		const folders = vscode.workspace.workspaceFolders;
		return folders?.[0]?.uri.fsPath;
	}

	function todayLabel(): string {
		const d = new Date();
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	// Save Snapshot: prompts for a description (defaults to a timestamp) and commits.
	// Optional second arg `selectedPaths` restricts the snapshot to a subset of
	// changed files — this is what the Versions view passes when the user has
	// unchecked some entries in the Changes list.
	context.subscriptions.push(vscode.commands.registerCommand('aria.vcs.saveSnapshot', async (presetMessage?: string, selectedPaths?: string[], groupWithPrevious?: boolean) => {
		const cwd = activeWorkspacePath();
		if (!cwd) {
			vscode.window.showWarningMessage('Open a folder to save snapshots.');
			return undefined;
		}

		let message = presetMessage;
		if (!message) {
			message = await vscode.window.showInputBox({
				prompt: 'Describe this snapshot',
				placeHolder: 'What changed?',
				value: `Snapshot ${todayLabel()}`,
			});
			if (message === undefined) {
				return undefined; // user cancelled
			}
			if (message.trim().length === 0) {
				message = `Snapshot ${todayLabel()}`;
			}
		}

		// Capture the current HEAD BEFORE committing so we can link this new
		// snapshot's group to the previous one when the user grouped them.
		const prevHash = (await service.getRecentSnapshots(cwd, 1))[0]?.hash;

		try {
			const snapshot = await service.saveSnapshot(cwd, message, selectedPaths);
			if (snapshot) {
				// Display-only grouping: continuation → same group as the previous
				// snapshot; otherwise a fresh group. Never rewrites git history.
				recordGroup(cwd, snapshot.hash, prevHash, groupWithPrevious === true);
				vscode.window.showInformationMessage(`Snapshot saved: ${snapshot.message}`);
				return snapshot;
			}
			vscode.window.showInformationMessage('Nothing to save — no changes since the last snapshot.');
			return undefined;
		} catch (err) {
			vscode.window.showErrorMessage(`Could not save snapshot: ${(err as Error).message}`);
			return undefined;
		}
	}));

	// Prepare a snapshot: gather the diff, ask the AI for a one-line title +
	// whether it continues the previous snapshot, and return everything the
	// Save dialog needs. Falls back to a timestamp title when no AI is usable.
	context.subscriptions.push(vscode.commands.registerCommand('aria.vcs.prepareSnapshot', async (selectedPaths?: string[]): Promise<SnapshotDraft> => {
		const cwd = activeWorkspacePath();
		const fallback: SnapshotDraft = { suggestedTitle: `Snapshot ${todayLabel()}`, continuation: false, aiUsed: false, providers: availableProviders() };
		if (!cwd) {
			return fallback;
		}
		try {
			const recent = await service.getRecentSnapshots(cwd, 1);
			const prev = recent[0];
			const diff = await service.getDiffText(cwd, selectedPaths);
			const summary = await summarizeDiff(diff, prev?.message, prev?.filesChanged ?? 0);
			if (summary) {
				return {
					suggestedTitle: summary.message,
					continuation: summary.continuation && !!prev,
					previousTitle: prev?.message,
					aiUsed: true,
					providers: availableProviders(),
				};
			}
		} catch {
			// fall through to the template
		}
		return { ...fallback, previousTitle: (await service.getRecentSnapshots(cwd, 1))[0]?.message };
	}));

	// Return recent snapshots — used by the Versions view to populate its list.
	context.subscriptions.push(vscode.commands.registerCommand('aria.vcs.getRecent', async (limit?: number): Promise<Snapshot[]> => {
		const cwd = activeWorkspacePath();
		if (!cwd) {
			return [];
		}
		try {
			const snapshots = await service.getRecentSnapshots(cwd, limit ?? 10);
			// Attach display-only grouping (from the sidecar) so the timeline can
			// collapse consecutive same-group snapshots.
			for (const s of snapshots) {
				const g = getGroup(cwd, s.hash);
				if (g) {
					s.groupId = g.groupId;
					s.continuation = g.continuation;
				}
			}
			return snapshots;
		} catch {
			return [];
		}
	}));

	// Go back to a snapshot — truncates history to that point and surfaces
	// the now-undone changes as snapshot candidates in the Changes list.
	context.subscriptions.push(vscode.commands.registerCommand('aria.vcs.restoreSnapshot', async (hash?: string) => {
		const cwd = activeWorkspacePath();
		if (!cwd) {
			vscode.window.showWarningMessage('Open a folder to go back to a snapshot.');
			return;
		}
		if (!hash) {
			vscode.window.showErrorMessage('Snapshot id missing.');
			return;
		}

		const choice = await vscode.window.showWarningMessage(
			'Are you sure you want to go back to this version?',
			{
				modal: true,
				detail: 'Snapshots saved after this point will be removed from history. Their changes will reappear in the Changes list, so you can selectively re-save what you want to keep. Your current working files are preserved.',
			},
			'Yes, Go Back'
		);
		if (choice !== 'Yes, Go Back') {
			return;
		}

		try {
			await service.restoreSnapshot(cwd, hash);
			vscode.window.showInformationMessage('Went back to this version. The undone changes are now in Changes.');
		} catch (err) {
			vscode.window.showErrorMessage(`Could not go back: ${(err as Error).message}`);
		}
	}));

	// Files changed *in* a specific snapshot — used by the Versions view to
	// expand a snapshot row into its file list.
	context.subscriptions.push(vscode.commands.registerCommand('aria.vcs.getSnapshotChanges', async (hash?: string): Promise<FileChange[]> => {
		const cwd = activeWorkspacePath();
		if (!cwd || !hash) {
			return [];
		}
		try {
			return await service.getSnapshotChanges(cwd, hash);
		} catch {
			return [];
		}
	}));

	// Diff a single file's content between a snapshot and its parent.
	context.subscriptions.push(vscode.commands.registerCommand('aria.vcs.openSnapshotDiff', async (hash?: string, filePath?: string) => {
		const cwd = activeWorkspacePath();
		if (!cwd || !hash || !filePath) {
			return;
		}
		const parentRef = `${hash}^`;
		const beforeUri = vscode.Uri.parse(`aria-vcs-snapshot:${filePath}?${parentRef}`);
		const afterUri = vscode.Uri.parse(`aria-vcs-snapshot:${filePath}?${hash}`);
		await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, `${filePath} (${hash.slice(0, 7)})`);
	}));

	// List of files changed since the last snapshot — used to drill into "what
	// changed". Each entry knows the relative path and kind of change.
	context.subscriptions.push(vscode.commands.registerCommand('aria.vcs.getChanges', async (): Promise<FileChange[]> => {
		const cwd = activeWorkspacePath();
		if (!cwd) {
			return [];
		}
		try {
			return await service.getChanges(cwd);
		} catch {
			return [];
		}
	}));

	// Open a per-file diff between the working copy and the last snapshot
	// (or against a specific snapshot when `against` is passed).
	context.subscriptions.push(vscode.commands.registerCommand('aria.vcs.openDiff', async (filePath: string, against?: string) => {
		const cwd = activeWorkspacePath();
		if (!cwd || !filePath) {
			return;
		}

		const ref = against ?? 'HEAD';
		const fileUri = vscode.Uri.file(`${cwd}/${filePath}`);
		// VS Code's built-in `git:` URI scheme is only available with the
		// git extension active — Easy mode disables it — so we materialize
		// the old version as a virtual document via the workbench's
		// `vscode.diff` command + an in-memory provider.
		const oldUri = vscode.Uri.parse(`aria-vcs-snapshot:${filePath}?${ref}`);

		await vscode.commands.executeCommand('vscode.diff', oldUri, fileUri, `${filePath} (since ${ref === 'HEAD' ? 'last snapshot' : ref.slice(0, 7)})`);
	}));

	// Provide the contents of `aria-vcs-snapshot:` URIs by running `git show`.
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('aria-vcs-snapshot', {
		async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
			const cwd = activeWorkspacePath();
			if (!cwd) {
				return '';
			}
			const ref = uri.query || 'HEAD';
			try {
				return await service.showFileAt(cwd, ref, uri.path);
			} catch {
				return '';
			}
		}
	}));

	// Current repo / unsaved-changes status — used to drive the Versions view header.
	context.subscriptions.push(vscode.commands.registerCommand('aria.vcs.getStatus', async (): Promise<StatusInfo> => {
		const cwd = activeWorkspacePath();
		if (!cwd) {
			return { isRepo: false, unsavedChanges: 0, hasHead: false };
		}
		try {
			return await service.getStatus(cwd);
		} catch {
			return { isRepo: false, unsavedChanges: 0, hasHead: false };
		}
	}));
}

export function deactivate(): void {
	// Nothing to clean up — child processes are short-lived.
}
