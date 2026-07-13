/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Column, COLUMN_LABELS } from './state';
import { RoadmapStore } from './roadmaps';

/**
 * VS Code commands that the workbench-side wizard UI calls. They operate on the
 * store's shared state — the ACTIVE roadmap — so a node Claude Code proposes via
 * MCP shows up in the canvas, and a node the user adds manually shows up to the
 * AI on its next get_tree() call. Multi-roadmap: the workbench switches the
 * active roadmap (switchActive) when the user opens a different one, and every
 * mutation persists to that roadmap's own `.aria/roadmaps/<id>.json`.
 *
 * Every mutation re-emits `aria.roadmap.workbench.onStateChange` (carrying the
 * active roadmap id) so the matching canvas pane re-renders without polling.
 */
export function registerWorkbenchCommands(
	context: vscode.ExtensionContext,
	store: RoadmapStore,
	getFinalized: () => boolean,
	setFinalized: (value: boolean) => void,
): void {
	const state = store.state;

	const fireChange = () => {
		void vscode.commands.executeCommand(
			'aria.roadmap.workbench.onStateChange',
			snapshotPayload(store, getFinalized()),
		);
		// Keep the active roadmap's file in sync with every edit so the sidebar
		// (which lists roadmaps by their persisted content) refreshes and the
		// roadmap survives a reload.
		store.persistActive();
	};

	context.subscriptions.push(
		// Read the active roadmap's snapshot on wizard mount.
		vscode.commands.registerCommand('aria.roadmap.getState', () => snapshotPayload(store, getFinalized())),

		// --- Multi-roadmap management -----------------------------------------
		// List every roadmap in the project (id + hypothesis sentence + counts).
		vscode.commands.registerCommand('aria.roadmap.list', () => store.list()),

		// Create a new empty roadmap; returns its id. Does NOT switch active — the
		// caller (sidebar / New Project) opens it, which switches active.
		vscode.commands.registerCommand('aria.roadmap.createRoadmap', () => store.create()),

		// Make `id` the active roadmap and return its snapshot. The pane calls
		// this on open/focus so edits target the roadmap the user is looking at.
		vscode.commands.registerCommand('aria.roadmap.switchActive', (id: string) => {
			// Skip the notify/persist churn when this roadmap is already active —
			// the pane re-asserts active on every focus, which would otherwise
			// re-render and rewrite the file needlessly.
			const changed = store.activeId !== id;
			store.switchActive(id);
			if (changed) {
				fireChange();
			}
			return snapshotPayload(store, getFinalized());
		}),

		// Ensure some roadmap is active (newest, or a fresh one); returns its id.
		vscode.commands.registerCommand('aria.roadmap.ensureActive', () => {
			const id = store.ensureActive();
			fireChange();
			return id;
		}),

		// Delete a roadmap entirely. Returns the id that is active afterwards.
		vscode.commands.registerCommand('aria.roadmap.deleteRoadmap', (id: string) => {
			const nextActive = store.delete(id);
			fireChange();
			return nextActive;
		}),

		// Set (or clear, with an empty string) a roadmap's custom name.
		vscode.commands.registerCommand('aria.roadmap.rename', (id: string, name: string) => {
			store.rename(id, name);
			fireChange();
		}),

		// --- Per-node mutations (act on the active roadmap) -------------------
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

		// New Project: create a fresh EMPTY roadmap under the given (about-to-be-
		// opened) folder, so a new project starts with its own independent roadmap.
		vscode.commands.registerCommand('aria.roadmap.createEmptyAt', async (folderPath: string) => {
			return writeNewRoadmapAt(folderPath, []);
		}),

		// Save the active tree to a specific folder (used when finalizing into a
		// freshly created project folder). Writes a new roadmap file there.
		vscode.commands.registerCommand('aria.roadmap.saveTo', async (folderPath: string) => {
			return writeNewRoadmapAt(folderPath, state.snapshot().committed);
		}),

		// Explicit save from the canvas — the roadmap already auto-persists on
		// every edit, so this just flushes the active roadmap to disk.
		vscode.commands.registerCommand('aria.roadmap.persist', async () => {
			store.persistActive();
		}),

		// Clear the active roadmap's nodes (used by the canvas "Delete roadmap
		// content" affordance). The roadmap file itself stays (now empty).
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

/** Write a roadmap (possibly empty) as a NEW file under `<folder>/.aria/roadmaps/`
 *  and return its path. Used for New Project, which targets a folder other than
 *  the current workspace, so it goes straight to disk rather than via the store. */
async function writeNewRoadmapAt(folderPath: string, nodes: unknown[]): Promise<string> {
	const dir = path.join(folderPath, '.aria', 'roadmaps');
	await fs.promises.mkdir(dir, { recursive: true });
	const id = `r_${Math.random().toString(16).slice(2, 12)}`;
	const filePath = path.join(dir, `${id}.json`);
	const payload = { version: 1, columnLabels: COLUMN_LABELS, nodes, updatedAt: Date.now() };
	await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
	return filePath;
}

export function snapshotPayload(store: RoadmapStore, finalized: boolean) {
	const snap = store.state.snapshot();
	return {
		columnLabels: COLUMN_LABELS,
		committed: snap.committed,
		proposed: snap.proposed,
		finalized,
		roadmapId: store.activeId,
		roadmapName: store.activeDisplayName(),
	};
}
