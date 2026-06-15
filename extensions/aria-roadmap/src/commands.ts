/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Column, COLUMN_LABELS, RoadmapState } from './state';

/**
 * VS Code commands that the workbench-side wizard UI calls. Same state
 * instance as the MCP tools — they are two faces of one tree, so a node
 * that Claude Code proposes via MCP shows up in the canvas, and a node
 * the user adds manually in the canvas shows up to the AI on its next
 * get_tree() call.
 *
 * Every mutation re-emits a workbench-facing notification command
 * `aria.roadmap.workbench.onStateChange` so the canvas can re-render
 * without polling. The workbench-side contribution registers a handler
 * for that command at activation.
 */
export function registerWorkbenchCommands(
	context: vscode.ExtensionContext,
	state: RoadmapState,
	// Set by the extension when finalize_roadmap is called via MCP, OR
	// when the user clicks the "I'm done" affordance in chat. The
	// canvas reads this to enable Save & Accept.
	getFinalized: () => boolean,
	setFinalized: (value: boolean) => void,
): void {
	const fireChange = () => {
		void vscode.commands.executeCommand(
			'aria.roadmap.workbench.onStateChange',
			snapshotPayload(state, getFinalized()),
		);
		// In a project window, keep `.aria/roadmap.json` in sync with every
		// edit so the sidebar view (which reads the file) refreshes and the
		// saved roadmap survives a reload. No-op in the empty wizard window —
		// there the roadmap is persisted explicitly by Save & Accept.
		void persistToWorkspace(state);
	};

	context.subscriptions.push(
		// Read state on wizard mount.
		vscode.commands.registerCommand('aria.roadmap.getState', () => snapshotPayload(state, getFinalized())),

		// Per-tool mutations. Each mirrors an MCP tool but is callable
		// directly from workbench code (so the canvas's manual edits go
		// through the same state path the AI does).
		vscode.commands.registerCommand('aria.roadmap.propose', (args: {
			parent: string | null;
			column: Column;
			label: string;
			description?: string;
		}) => {
			const proposal = state.propose(args);
			fireChange();
			return proposal;
		}),
		vscode.commands.registerCommand('aria.roadmap.updateProposal', (id: string, patch: { label?: string; description?: string }) => {
			const updated = state.updateProposal(id, patch);
			fireChange();
			return updated;
		}),
		vscode.commands.registerCommand('aria.roadmap.acceptProposal', (id: string) => {
			const node = state.acceptProposal(id);
			fireChange();
			return node;
		}),
		vscode.commands.registerCommand('aria.roadmap.rejectProposal', (id: string) => {
			state.rejectProposal(id);
			fireChange();
		}),
		vscode.commands.registerCommand('aria.roadmap.acceptAllProposals', () => {
			const accepted = state.acceptAllProposals();
			fireChange();
			return accepted;
		}),
		vscode.commands.registerCommand('aria.roadmap.rejectAllProposals', () => {
			state.rejectAllProposals();
			fireChange();
		}),
		vscode.commands.registerCommand('aria.roadmap.updateNode', (id: string, patch: { label?: string; description?: string; status?: 'todo' | 'in_progress' | 'done' }) => {
			const node = state.updateNode(id, patch);
			fireChange();
			return node;
		}),
		vscode.commands.registerCommand('aria.roadmap.deleteNode', (id: string) => {
			state.deleteNode(id);
			fireChange();
		}),
		vscode.commands.registerCommand('aria.roadmap.moveNode', (id: string, newParent: string | null) => {
			const node = state.moveNode(id, newParent);
			fireChange();
			return node;
		}),
		vscode.commands.registerCommand('aria.roadmap.setFinalized', (value: boolean) => {
			setFinalized(value);
			fireChange();
		}),

		// Save & Accept: serialize the tree to <folder>/.aria/roadmap.json
		// and return the path so the workbench can vscode.openFolder it.
		vscode.commands.registerCommand('aria.roadmap.saveTo', async (folderPath: string) => {
			const ariaDir = path.join(folderPath, '.aria');
			const filePath = path.join(ariaDir, 'roadmap.json');
			await fs.promises.mkdir(ariaDir, { recursive: true });
			const snapshot = state.snapshot();
			const payload = {
				version: 1,
				columnLabels: COLUMN_LABELS,
				nodes: snapshot.committed,
			};
			await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
			return filePath;
		}),

		// Explicit save from the canvas's "Save" button — writes the current tree
		// to <workspace>/.aria/roadmap.json. (Edits already auto-persist via
		// fireChange; this just makes the user action explicit and reliable.)
		vscode.commands.registerCommand('aria.roadmap.persist', async () => {
			await persistToWorkspace(state);
		}),

		// Create a brand-new, EMPTY roadmap file at the given folder. Used by
		// New Project so a fresh project never inherits whatever roadmap happens
		// to be in memory — every project's roadmap is independent.
		vscode.commands.registerCommand('aria.roadmap.createEmptyAt', async (folderPath: string) => {
			const ariaDir = path.join(folderPath, '.aria');
			const filePath = path.join(ariaDir, 'roadmap.json');
			await fs.promises.mkdir(ariaDir, { recursive: true });
			const payload = { version: 1, columnLabels: COLUMN_LABELS, nodes: [] as unknown[] };
			await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
			return filePath;
		}),

		// Reset state for a fresh wizard session. Called when the user
		// cancels and reopens, or when the workbench needs a clean slate.
		vscode.commands.registerCommand('aria.roadmap.reset', () => {
			state.rejectAllProposals();
			for (const node of state.snapshot().committed) {
				try { state.deleteNode(node.id); } catch { /* descendant already gone */ }
			}
			setFinalized(false);
			fireChange();
		}),
	);
}

/** Write the committed tree to `<workspace>/.aria/roadmap.json` when a folder
 *  is open. Best-effort and debounce-free — edits are infrequent (human or AI
 *  tool calls), so a write per mutation is fine. */
async function persistToWorkspace(state: RoadmapState): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}
	try {
		const ariaDir = path.join(folder.uri.fsPath, '.aria');
		const filePath = path.join(ariaDir, 'roadmap.json');
		await fs.promises.mkdir(ariaDir, { recursive: true });
		const payload = {
			version: 1,
			columnLabels: COLUMN_LABELS,
			nodes: state.snapshot().committed,
		};
		await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
	} catch {
		// Disk error — non-fatal; the in-memory state is still authoritative.
	}
}

function snapshotPayload(state: RoadmapState, finalized: boolean) {
	const snap = state.snapshot();
	return {
		columnLabels: COLUMN_LABELS,
		committed: snap.committed,
		proposed: snap.proposed,
		finalized,
	};
}
