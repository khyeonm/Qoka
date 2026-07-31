/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';

/**
 * Pending note-edit proposals from Claude Code (via the aria-notes MCP).
 *
 * The MCP server stages a proposal (it does NOT write the note) and fires the
 * `aria.notes.workbench.onProposal` command; the contribution stores it here
 * and opens the note. The note editor pane reads the pending proposal and
 * shows it read-only with Accept / Reject. Mirrors the roadmap state channel.
 */
/** A citation the assistant could not place on its own, waiting for the user to
 *  say where it goes. `not_found` = the anchor is not in the note (the user picks
 *  a spot by clicking); `ambiguous` = the anchor occurs more than once, so
 *  `candidates` lists the real positions to choose between. */
export interface PendingCitation {
	/** Addresses this question. The same paper can be queued twice (two anchors,
	 *  both unplaceable), so the citekey alone is not a handle. */
	readonly id: string;
	readonly citekey: string;
	readonly title: string;
	readonly anchor: string;
	readonly reason: 'not_found' | 'ambiguous';
	readonly candidates?: readonly { readonly blockId: string; readonly offset: number; readonly context: string }[];
}

export interface NoteProposal {
	/** Key = the note file URI `.toString()`. */
	readonly fileKey: string;
	/** Absolute path, so the pane can address the extension's staged edit. */
	readonly filePath: string;
	readonly title: string;
	readonly blocks: unknown[];
	readonly currentMarkdown: string;
	readonly proposedMarkdown: string;
	/** Non-empty while the proposal still needs the user to position citations.
	 *  Accept stays disabled until every one is placed or skipped, so the review
	 *  always shows the note exactly as it will be written. */
	readonly pendingCitations: readonly PendingCitation[];
}

const pending = new Map<string, NoteProposal>();
const _onDidProposeNote = new Emitter<NoteProposal>();
export const onDidProposeNote: Event<NoteProposal> = _onDidProposeNote.event;

export function setNoteProposal(proposal: NoteProposal): void {
	pending.set(proposal.fileKey, proposal);
	_onDidProposeNote.fire(proposal);
}

export function getNoteProposal(fileKey: string): NoteProposal | undefined {
	return pending.get(fileKey);
}

export function clearNoteProposal(fileKey: string): void {
	pending.delete(fileKey);
}
