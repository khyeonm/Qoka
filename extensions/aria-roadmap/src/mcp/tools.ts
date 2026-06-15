/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Column, COLUMN_LABELS, RoadmapState } from '../state';
import { ROADMAP_BRAINSTORM_GUIDE } from './guide';

/** Optional notifier the extension wires in so MCP-driven mutations
 *  push the canvas to re-render without polling. Workbench commands
 *  registered in commands.ts wrap the same state and fire the same
 *  notification, so both edit paths converge on one update channel. */
export type StateChangeNotifier = () => void;

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: unknown;
	handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface CallToolResult {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
}

function ok(text: string): CallToolResult {
	return { content: [{ type: 'text', text }] };
}

function err(text: string): CallToolResult {
	return { content: [{ type: 'text', text }], isError: true };
}

function asString(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}

function asColumn(v: unknown): Column | undefined {
	if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
		return undefined;
	}
	// 0..3 are the named stages; deeper columns (4+) are allowed so the user
	// can keep nesting sub-details under a Detail node.
	return v;
}

/** Builds the per-server tool set bound to a single RoadmapState instance.
 *  Keeps the state out of module scope so we can spin up isolated states
 *  for tests later without restarting the server. The optional
 *  `notify` is fired after every state mutation so the canvas can
 *  re-render in real time. */
export function buildTools(
	state: RoadmapState,
	notify: StateChangeNotifier = () => { /* no-op */ },
	setFinalized: (value: boolean) => void = () => { /* no-op */ },
): ToolDefinition[] {
	const after = <T>(value: T): T => { notify(); return value; };
	return [
		{
			name: 'get_roadmap_guide',
			description: 'Return the facilitation guide for this roadmap brainstorming session. Call this FIRST, before anything else, to learn how to run the session (it explains the one-question-per-message method, how to propose nodes, and the finalize handshake).',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => ok(ROADMAP_BRAINSTORM_GUIDE),
		},
		{
			name: 'get_tree',
			description: 'Return the current roadmap snapshot: committed nodes and pending proposals. Call this whenever you need to see what is already on the canvas before proposing more. If you have not yet read get_roadmap_guide this session, call that first.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => ok(JSON.stringify({
				columnLabels: COLUMN_LABELS,
				...state.snapshot(),
			})),
		},
		{
			name: 'propose_node',
			description: 'Suggest a new node. Renders on the canvas with a "proposed" treatment so the user can accept, edit, or reject it. column is 0 (Goal), 1 (Milestone), 2 (Task), 3 (Detail), and may go deeper (4, 5, …) for sub-details. parent must be null for column 0 and otherwise reference a COMMITTED node id in the previous column. Keep label SHORT (a card headline) and put any longer text in description — the user reads the full description by clicking the node. Write all labels and descriptions in English.',
			inputSchema: {
				type: 'object',
				properties: {
					parent: { type: ['string', 'null'], description: 'Committed parent node id, or null for a column-0 root.' },
					column: { type: 'integer', description: '0=Goal, 1=Milestone, 2=Task, 3=Detail, 4+=deeper sub-detail.' },
					label: { type: 'string', description: 'Short English headline that fits on a card.' },
					description: { type: 'string', description: 'Optional longer English explanation shown when the user clicks the node.' },
				},
				required: ['column', 'label'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const column = asColumn(args.column);
				const label = asString(args.label);
				if (column === undefined || !label) {
					return err('propose_node requires column (0..3) and a non-empty label');
				}
				try {
					const proposal = state.propose({
						parent: asString(args.parent) ?? null,
						column,
						label,
						description: asString(args.description),
					});
					return ok(JSON.stringify(after(proposal)));
				} catch (e) {
					return err(`propose_node failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'update_proposal',
			description: 'Edit a pending proposal in place. Use when refining wording before the user accepts it.',
			inputSchema: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					label: { type: 'string' },
					description: { type: 'string' },
				},
				required: ['id'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = asString(args.id);
				if (!id) { return err('update_proposal requires id'); }
				try {
					const updated = state.updateProposal(id, {
						label: asString(args.label),
						description: asString(args.description),
					});
					return ok(JSON.stringify(after(updated)));
				} catch (e) {
					return err(`update_proposal failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'accept_proposal',
			description: 'Promote a proposal to a committed node. The user is expected to drive this from the canvas; tools usually call it only when the AI is explicitly authorized by the user to auto-accept.',
			inputSchema: {
				type: 'object',
				properties: { id: { type: 'string' } },
				required: ['id'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = asString(args.id);
				if (!id) { return err('accept_proposal requires id'); }
				try {
					const node = state.acceptProposal(id);
					return ok(JSON.stringify(after(node)));
				} catch (e) {
					return err(`accept_proposal failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'reject_proposal',
			description: 'Discard a pending proposal without committing it.',
			inputSchema: {
				type: 'object',
				properties: { id: { type: 'string' } },
				required: ['id'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = asString(args.id);
				if (!id) { return err('reject_proposal requires id'); }
				try {
					state.rejectProposal(id);
					notify();
					return ok('proposal rejected');
				} catch (e) {
					return err(`reject_proposal failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'accept_all_proposals',
			description: 'Bulk-accept every pending proposal. Children whose parents are also pending in this batch are accepted parent-first.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				const accepted = state.acceptAllProposals();
				notify();
				return ok(JSON.stringify({ accepted: accepted.length, nodes: accepted }));
			},
		},
		{
			name: 'reject_all_proposals',
			description: 'Bulk-reject every pending proposal.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				state.rejectAllProposals();
				notify();
				return ok('all proposals rejected');
			},
		},
		{
			name: 'list_proposals',
			description: 'Return the ordered list of pending proposal ids — the order the sequential review tour visits them in.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => ok(JSON.stringify(state.listProposalIds())),
		},
		{
			name: 'update_node',
			description: 'Edit a committed node\'s label, description, or status. Use for in-place revision after acceptance.',
			inputSchema: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					label: { type: 'string' },
					description: { type: 'string' },
					status: { type: 'string', enum: ['todo', 'in_progress', 'done'] },
				},
				required: ['id'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = asString(args.id);
				if (!id) { return err('update_node requires id'); }
				try {
					const status = asString(args.status);
					const node = state.updateNode(id, {
						label: asString(args.label),
						description: asString(args.description),
						status: status === 'todo' || status === 'in_progress' || status === 'done' ? status : undefined,
					});
					return ok(JSON.stringify(after(node)));
				} catch (e) {
					return err(`update_node failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'delete_node',
			description: 'Remove a committed node and every descendant under it. Pending proposals that hung off the removed branch are dropped too.',
			inputSchema: {
				type: 'object',
				properties: { id: { type: 'string' } },
				required: ['id'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = asString(args.id);
				if (!id) { return err('delete_node requires id'); }
				try {
					state.deleteNode(id);
					notify();
					return ok('node deleted (with descendants)');
				} catch (e) {
					return err(`delete_node failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'move_node',
			description: 'Re-parent a committed node. The new parent must be a committed node in the column immediately to the left, or null for a column-0 root.',
			inputSchema: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					new_parent: { type: ['string', 'null'] },
				},
				required: ['id'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = asString(args.id);
				if (!id) { return err('move_node requires id'); }
				try {
					const node = state.moveNode(id, asString(args.new_parent) ?? null);
					return ok(JSON.stringify(after(node)));
				} catch (e) {
					return err(`move_node failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'finalize_roadmap',
			description: 'Signal that the roadmap is structurally complete enough to save. Call ONLY after the user has explicitly confirmed in chat. Sets a flag the canvas reads to enable the Save & Accept button.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				setFinalized(true);
				notify();
				return ok('roadmap marked as ready to save');
			},
		},
	];
}
