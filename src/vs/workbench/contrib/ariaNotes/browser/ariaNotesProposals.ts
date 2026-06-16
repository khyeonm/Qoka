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
export interface NoteProposal {
	/** Key = the note file URI `.toString()`. */
	readonly fileKey: string;
	readonly title: string;
	readonly blocks: unknown[];
	readonly currentMarkdown: string;
	readonly proposedMarkdown: string;
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
