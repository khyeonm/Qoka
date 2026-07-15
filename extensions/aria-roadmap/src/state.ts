/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';

/**
 * Roadmap state for the New Project wizard.
 *
 * The wizard's tree has four fixed columns (0..3) - the research-domain
 * progression the user locked in: 목표 → 마일스톤 → 작업 → 세부. Nodes are
 * either committed (the canvas's stable tree) or proposed (an AI suggestion
 * that the user must accept, edit, or reject). Both kinds are kept here so
 * the canvas can render them with different treatments and the AI can read
 * the full tree with one `get_tree()` call.
 */

/** Depth of a node in the roadmap tree. Columns 0..3 are the named research
 *  stages (see COLUMN_LABELS); the tree may extend deeper (4, 5, …) as the user
 *  keeps adding children under a Detail node - those deeper columns are
 *  unnamed and simply nest further. */
export type Column = number;

/** Names for the first four columns. Deeper columns have no name. */
export const COLUMN_LABELS = ['Goal', 'Milestone', 'Task', 'Detail'] as const;
export const NAMED_COLUMN_COUNT = COLUMN_LABELS.length;

export type NodeStatus = 'todo' | 'in_progress' | 'done';

export interface RoadmapNode {
	id: string;
	column: Column;
	parent: string | null;
	label: string;
	description?: string;
	status?: NodeStatus;
}

export interface RoadmapProposal {
	id: string;
	column: Column;
	parent: string | null;
	label: string;
	description?: string;
	/** Creation timestamp (ms). Used to order the sequential review tour. */
	proposedAt: number;
}

export interface RoadmapSnapshot {
	committed: RoadmapNode[];
	proposed: RoadmapProposal[];
}

export class RoadmapState {

	private committed = new Map<string, RoadmapNode>();
	private proposed = new Map<string, RoadmapProposal>();
	/** Monotonic counter so proposal ordering stays stable even if two
	 *  proposals arrive in the same millisecond. */
	private proposalSeq = 0;

	/** Replace all committed nodes with the given set (proposals cleared).
	 *  Used to hydrate from a project's persisted `.aria/roadmap.json` on
	 *  activation, so the AI's get_tree() and the sidebar both reflect the
	 *  saved roadmap in a project window. */
	load(nodes: RoadmapNode[]): void {
		this.committed.clear();
		this.proposed.clear();
		for (const node of nodes) {
			if (node && typeof node.id === 'string') {
				this.committed.set(node.id, { ...node });
			}
		}
	}

	snapshot(): RoadmapSnapshot {
		return {
			committed: [...this.committed.values()],
			proposed: [...this.proposed.values()].sort((a, b) => a.proposedAt - b.proposedAt),
		};
	}

	listProposalIds(): string[] {
		return [...this.proposed.values()]
			.sort((a, b) => a.proposedAt - b.proposedAt)
			.map(p => p.id);
	}

	hasNode(id: string): boolean {
		return this.committed.has(id) || this.proposed.has(id);
	}

	getCommitted(id: string): RoadmapNode | undefined {
		return this.committed.get(id);
	}

	getProposal(id: string): RoadmapProposal | undefined {
		return this.proposed.get(id);
	}

	/** Validate the parent reference: a committed node's parent must exist
	 *  (committed) and sit one column to the left. Column 0 must have a null
	 *  parent. Returns an error string when the structure is bad. */
	private validateParentForColumn(column: Column, parent: string | null): string | null {
		if (column === 0) {
			if (parent !== null) {
				return 'column 0 (root) nodes must have parent=null';
			}
			return null;
		}
		if (!parent) {
			return `column ${column} nodes need a parent (one of the column ${column - 1} nodes)`;
		}
		const p = this.committed.get(parent);
		if (!p) {
			return `parent ${parent} is not committed`;
		}
		if (p.column !== column - 1) {
			return `parent ${parent} is in column ${p.column}, expected column ${column - 1}`;
		}
		return null;
	}

	propose(input: { parent: string | null; column: Column; label: string; description?: string }): RoadmapProposal {
		const err = this.validateParentForColumn(input.column, input.parent);
		if (err) {
			throw new Error(err);
		}
		const proposal: RoadmapProposal = {
			id: this.newProposalId(),
			column: input.column,
			parent: input.parent,
			label: input.label,
			description: input.description,
			proposedAt: Date.now() * 1000 + (++this.proposalSeq),
		};
		this.proposed.set(proposal.id, proposal);
		return proposal;
	}

	updateProposal(id: string, patch: { label?: string; description?: string }): RoadmapProposal {
		const existing = this.proposed.get(id);
		if (!existing) {
			throw new Error(`no proposal with id ${id}`);
		}
		const updated: RoadmapProposal = {
			...existing,
			label: patch.label ?? existing.label,
			description: patch.description ?? existing.description,
		};
		this.proposed.set(id, updated);
		return updated;
	}

	acceptProposal(id: string): RoadmapNode {
		const proposal = this.proposed.get(id);
		if (!proposal) {
			throw new Error(`no proposal with id ${id}`);
		}
		// Re-validate at accept time - the parent could have been deleted
		// between propose and accept.
		const err = this.validateParentForColumn(proposal.column, proposal.parent);
		if (err) {
			throw new Error(`cannot accept proposal: ${err}`);
		}
		this.proposed.delete(id);
		const node: RoadmapNode = {
			id: proposal.id,
			column: proposal.column,
			parent: proposal.parent,
			label: proposal.label,
			description: proposal.description,
			status: 'todo',
		};
		this.committed.set(node.id, node);
		return node;
	}

	rejectProposal(id: string): void {
		if (!this.proposed.delete(id)) {
			throw new Error(`no proposal with id ${id}`);
		}
	}

	acceptAllProposals(): RoadmapNode[] {
		const accepted: RoadmapNode[] = [];
		// Accept in column order so a child proposal whose parent is also a
		// proposal in the same batch gets its parent committed first.
		const ordered = [...this.proposed.values()].sort((a, b) => a.column - b.column || a.proposedAt - b.proposedAt);
		for (const proposal of ordered) {
			try {
				accepted.push(this.acceptProposal(proposal.id));
			} catch {
				// Skip ones whose parent never made it - they'll stay in the
				// proposed set so the user can decide what to do with them.
			}
		}
		return accepted;
	}

	rejectAllProposals(): void {
		this.proposed.clear();
	}

	updateNode(id: string, patch: { label?: string; description?: string; status?: NodeStatus }): RoadmapNode {
		const existing = this.committed.get(id);
		if (!existing) {
			throw new Error(`no committed node with id ${id}`);
		}
		const updated: RoadmapNode = {
			...existing,
			label: patch.label ?? existing.label,
			description: patch.description ?? existing.description,
			status: patch.status ?? existing.status,
		};
		this.committed.set(id, updated);
		return updated;
	}

	deleteNode(id: string): void {
		const node = this.committed.get(id);
		if (!node) {
			throw new Error(`no committed node with id ${id}`);
		}
		// Cascade: remove every descendant too, so the canvas never shows
		// orphans pointing at a missing parent.
		const toRemove = new Set<string>([id]);
		let grew = true;
		while (grew) {
			grew = false;
			for (const candidate of this.committed.values()) {
				if (candidate.parent && toRemove.has(candidate.parent) && !toRemove.has(candidate.id)) {
					toRemove.add(candidate.id);
					grew = true;
				}
			}
		}
		for (const removeId of toRemove) {
			this.committed.delete(removeId);
		}
		// Drop any proposals that hung off removed parents too.
		for (const proposal of [...this.proposed.values()]) {
			if (proposal.parent && toRemove.has(proposal.parent)) {
				this.proposed.delete(proposal.id);
			}
		}
	}

	moveNode(id: string, newParent: string | null): RoadmapNode {
		const node = this.committed.get(id);
		if (!node) {
			throw new Error(`no committed node with id ${id}`);
		}
		const err = this.validateParentForColumn(node.column, newParent);
		if (err) {
			throw new Error(err);
		}
		// Prevent cycles: the new parent must not be a descendant of `id`.
		let walker: string | null = newParent;
		while (walker) {
			if (walker === id) {
				throw new Error('cannot move a node under one of its own descendants');
			}
			const w = this.committed.get(walker);
			walker = w?.parent ?? null;
		}
		const updated: RoadmapNode = { ...node, parent: newParent };
		this.committed.set(id, updated);
		return updated;
	}

	private newProposalId(): string {
		return `p_${crypto.randomBytes(4).toString('hex')}`;
	}
}
