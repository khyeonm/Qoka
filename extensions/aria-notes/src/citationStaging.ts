/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AnchorMatch, insertCitation } from './citations';
import { blocksToMarkdown } from './notes';

/**
 * Staged citation edits waiting on the user.
 *
 * `insert_citations` never fails on a bad anchor. Anchors it could place are
 * applied to a staged copy of the note; anchors it could not become QUESTIONS
 * the user answers in the editor. The tool returns immediately either way, so
 * the MCP call never blocks on a human (every other Qoka tool proposes and
 * returns; a tool that waits would hit the client's timeout and leave the model
 * unable to say anything meanwhile).
 *
 * The staged blocks live HERE rather than in the workbench so one place owns the
 * splice rules (leading space, adjacent merge). The pane only reports where the
 * user pointed; this module applies it and re-fires the proposal.
 *
 * State is in memory, like the workbench-side proposal it mirrors: a window
 * reload drops unanswered questions, and the assistant can simply stage them
 * again.
 */

export interface PendingCitation {
	/** Addresses this question. The same paper can be queued twice (two anchors,
	 *  both unplaceable), so the citekey alone is not a handle. */
	id: string;
	citekey: string;
	/** Paper title, so the question can name what is being cited. */
	title: string;
	/** The anchor the assistant asked for, shown as the intent behind the question. */
	anchor: string;
	reason: 'not_found' | 'ambiguous';
	/** For `ambiguous`: every place the anchor actually occurs. */
	candidates?: AnchorMatch[];
}

interface StagedEdit {
	filePath: string;
	title: string;
	/** The saved note, for diffing in the editor. */
	currentMarkdown: string;
	/** The note with every placed citation applied. */
	blocks: unknown[];
	pending: PendingCitation[];
}

const staged = new Map<string, StagedEdit>();

/** Sends the staged edit to the workbench note editor. Injected on activation. */
export type FireProposal = (payload: {
	filePath: string;
	title: string;
	blocks: unknown[];
	currentMarkdown: string;
	proposedMarkdown: string;
	pendingCitations: PendingCitation[];
}) => void;

let fire: FireProposal = () => { /* set on activate */ };

export function setFireProposal(fn: FireProposal): void {
	fire = fn;
}

/** True while the user still has citation questions open for this note. A second
 *  insert_citations must be refused then: the workbench keeps ONE proposal per
 *  note and would overwrite it, discarding answers already given. */
export function hasOpenQuestions(filePath: string): boolean {
	return (staged.get(filePath)?.pending.length ?? 0) > 0;
}

export function clearStaging(filePath: string): void {
	staged.delete(filePath);
}

export async function stage(edit: Omit<StagedEdit, never>): Promise<void> {
	staged.set(edit.filePath, edit);
	await publish(edit);
}

async function publish(edit: StagedEdit): Promise<void> {
	let proposedMarkdown = '';
	try {
		proposedMarkdown = await blocksToMarkdown(edit.blocks);
	} catch {
		// Only carried for context; the editor writes `blocks` on Accept.
	}
	fire({
		filePath: edit.filePath,
		title: edit.title,
		blocks: edit.blocks,
		currentMarkdown: edit.currentMarkdown,
		proposedMarkdown,
		pendingCitations: edit.pending,
	});
}

export interface ResolveResult {
	ok: boolean;
	message: string;
	remaining: number;
}

/** The user picked a spot: apply that citation and re-publish. */
export async function resolveLocation(filePath: string, id: string, blockId: string, offset: number): Promise<ResolveResult> {
	const edit = staged.get(filePath);
	if (!edit) { return { ok: false, message: 'No staged citations for this note.', remaining: 0 }; }
	const index = edit.pending.findIndex(p => p.id === id);
	if (index < 0) { return { ok: false, message: `No pending citation ${id}.`, remaining: edit.pending.length }; }
	const { citekey } = edit.pending[index];
	const { blocks, outcome } = insertCitation(edit.blocks, blockId, offset, citekey);
	if (outcome === 'unsupported') {
		// A table cell, a code block, or a block that has since gone. Keep the
		// question open: closing it here would drop the citation with nothing to
		// show for it, which is worse than asking again.
		return { ok: false, message: 'A citation cannot go there. Pick a spot in ordinary text.', remaining: edit.pending.length };
	}
	edit.blocks = blocks;
	edit.pending.splice(index, 1);
	await publish(edit);
	return { ok: true, message: `Placed [@${citekey}].`, remaining: edit.pending.length };
}

/** The user does not want this one after all. */
export async function skipPending(filePath: string, id: string): Promise<ResolveResult> {
	const edit = staged.get(filePath);
	if (!edit) { return { ok: false, message: 'No staged citations for this note.', remaining: 0 }; }
	const index = edit.pending.findIndex(p => p.id === id);
	if (index < 0) { return { ok: false, message: `No pending citation ${id}.`, remaining: edit.pending.length }; }
	const [removed] = edit.pending.splice(index, 1);
	await publish(edit);
	return { ok: true, message: `Skipped [@${removed.citekey}].`, remaining: edit.pending.length };
}
