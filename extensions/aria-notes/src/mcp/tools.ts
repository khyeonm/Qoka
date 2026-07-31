/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import {
	blocksToMarkdown, createNote, listNotes, markdownToBlocks,
	readBlocks, readTitle, resolveNote, titleFromMarkdown,
} from '../notes';
import { collectCitations, findAnchorMatches, insertCitation } from '../citations';
import { hasOpenQuestions, PendingCitation, stage } from '../citationStaging';
import { citableByKey } from '../paperLibrary';

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

/** Stage a proposed change for the workbench to show for Accept/Reject. */
export type ProposeChange = (
	filePath: string,
	title: string,
	proposedBlocks: unknown[],
	currentMarkdown: string,
	proposedMarkdown: string,
) => void;

/** Reveal the Notebook tab and open the note at the given file path. */
export type OpenNote = (filePath: string) => void;

function ok(text: string): CallToolResult { return { content: [{ type: 'text', text }] }; }
function err(text: string): CallToolResult { return { content: [{ type: 'text', text }], isError: true }; }
function asString(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined; }

/**
 * Refuse to stage anything over a note whose citation questions are still open.
 * The workbench keeps ONE proposal per note, so a second staging call would
 * overwrite the first and silently discard the placements the user has already
 * answered.
 */
function blockedByOpenQuestions(filePath: string, title: string): CallToolResult | undefined {
	if (!hasOpenQuestions(filePath)) { return undefined; }
	return err(
		`"${title}" already has citation questions open - the user is choosing where those citations go. ` +
		`Wait for them to finish in the note editor before staging anything else here; calling again now would discard their answers.`
	);
}

/**
 * Note tools. Reads are direct; edits to an EXISTING note (update/append) are
 * STAGED as a proposal the user accepts in the editor - they do not write the
 * file. create/delete are direct. After create_note writes the new note, the
 * Notebook tab is opened and the new note is shown - narrate that to the
 * user.
 */
export function buildTools(propose: ProposeChange, openNote: OpenNote): ToolDefinition[] {
	return [
		{
			name: 'list_notes',
			description: 'List the research notes in this project (notes/*.json). Returns id and title for each - use the id or title to address a note in other tools.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => ok(JSON.stringify(listNotes().map(n => ({ id: n.id, title: n.title })))),
		},
		{
			name: 'read_note',
			description: 'Read a note as Markdown. `note` is the note id or title (from list_notes).',
			inputSchema: {
				type: 'object',
				properties: { note: { type: 'string', description: 'Note id or title.' } },
				required: ['note'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const note = asString(args.note);
				if (!note) { return err('read_note requires `note` (id or title)'); }
				const info = resolveNote(note);
				if (!info) { return err(`No note matches "${note}". Use list_notes to see ids/titles.`); }
				try {
					return ok(await blocksToMarkdown(readBlocks(info.filePath)));
				} catch (e) {
					return err(`read_note failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'create_note',
			description: 'Create a brand-new note from Markdown (writes immediately). After it is created, the Notebook tab opens and the new note is shown - tell the user it is now open. Use ONLY when the user wants a new note. To add to or change an EXISTING note, use append_note/update_note - those show the change inside that note for the user to Accept. You may cite papers inline as [@citekey] (citekeys come from list_saved_papers / save_paper); never write a References section, it is generated from the citekeys.',
			inputSchema: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'Optional title; defaults to the first line of the content.' },
					markdown: { type: 'string', description: 'Note body in Markdown.' },
				},
				required: ['markdown'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const markdown = asString(args.markdown) ?? '';
				try {
					const blocks = await markdownToBlocks(markdown);
					const title = asString(args.title)?.trim() || titleFromMarkdown(markdown);
					const info = createNote(title, blocks);
					openNote(info.filePath);
					return ok(`Created note "${info.title}" (id: ${info.id}). The Notebook tab is now open showing this note.`);
				} catch (e) {
					return err(`create_note failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'update_note',
			description: 'Propose REPLACING a note\'s entire content with the given Markdown. Does NOT write - the user reviews and accepts the change in the editor. NOTE: replacing flattens BlockNote-only blocks (e.g. toggles) to plain blocks; prefer append_note when you only add content. If all you want is to ADD a citation to text that already exists, use insert_citations instead - it does not rewrite the note.',
			inputSchema: {
				type: 'object',
				properties: {
					note: { type: 'string', description: 'Note id or title.' },
					markdown: { type: 'string', description: 'The full new note body in Markdown.' },
				},
				required: ['note', 'markdown'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const note = asString(args.note);
				const markdown = asString(args.markdown);
				if (!note || markdown === undefined) { return err('update_note requires `note` and `markdown`'); }
				const info = resolveNote(note);
				if (!info) { return err(`No note matches "${note}".`); }
				const blocked = blockedByOpenQuestions(info.filePath, info.title);
				if (blocked) { return blocked; }
				try {
					const currentMarkdown = await blocksToMarkdown(readBlocks(info.filePath));
					const proposedBlocks = await markdownToBlocks(markdown);
					propose(info.filePath, titleFromMarkdown(markdown) || info.title, proposedBlocks, currentMarkdown, markdown);
					return ok(`Proposed a full rewrite of "${info.title}". Ask the user to Accept it in the note editor.`);
				} catch (e) {
					return err(`update_note failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'append_note',
			description: 'Propose APPENDING the given Markdown to the end of a note. Does NOT write - the user reviews and accepts in the editor. Existing blocks are preserved exactly (toggles etc. survive); only the new content is added. You may cite papers inline as [@citekey] (citekeys come from list_saved_papers / save_paper); never write a References section, it is generated from the citekeys.',
			inputSchema: {
				type: 'object',
				properties: {
					note: { type: 'string', description: 'Note id or title.' },
					markdown: { type: 'string', description: 'Markdown to append at the end.' },
				},
				required: ['note', 'markdown'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const note = asString(args.note);
				const markdown = asString(args.markdown);
				if (!note || markdown === undefined) { return err('append_note requires `note` and `markdown`'); }
				const info = resolveNote(note);
				if (!info) { return err(`No note matches "${note}".`); }
				const blocked = blockedByOpenQuestions(info.filePath, info.title);
				if (blocked) { return blocked; }
				try {
					const currentBlocks = readBlocks(info.filePath);
					const currentMarkdown = await blocksToMarkdown(currentBlocks);
					const addedBlocks = await markdownToBlocks(markdown);
					const proposedBlocks = [...currentBlocks, ...addedBlocks];
					const proposedMarkdown = currentMarkdown + (currentMarkdown ? '\n\n' : '') + markdown;
					propose(info.filePath, info.title, proposedBlocks, currentMarkdown, proposedMarkdown);
					return ok(`Proposed appending to "${info.title}". Ask the user to Accept it in the note editor.`);
				} catch (e) {
					return err(`append_note failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'insert_citations',
			description: 'Add one or more citations into a note\'s EXISTING text without rewriting it. Each item inserts [@citekey] immediately after `anchor`, a short snippet copied VERBATIM from the note\'s current text (call read_note first and copy from what you read - do not paraphrase). The anchor must sit inside a single paragraph. Every citekey must already exist in the paper library: check list_saved_papers, and for a paper that is not there yet call save_paper first (its response returns the citekey). All items are staged as ONE proposal the user accepts in the editor, so pass them together instead of calling this repeatedly. An anchor that is missing or occurs more than once is NOT an error: that citation is queued as a question for the user to answer in the note, and comes back in `needsLocation`. Report what happened and then STOP - do not retry with a guessed anchor, and do not call this again for the same note until the user has finished (a second call while questions are open is refused and would discard their answers). The note is not changed until the user accepts, so never say the citations are in the note.',
			inputSchema: {
				type: 'object',
				properties: {
					note: { type: 'string', description: 'Note id or title.' },
					citations: {
						type: 'array',
						description: 'The citations to add, in any order.',
						items: {
							type: 'object',
							properties: {
								anchor: { type: 'string', description: 'Verbatim snippet of the note\'s current text; the citation lands right after it.' },
								citekey: { type: 'string', description: 'Citekey from the paper library (list_saved_papers / save_paper).' },
							},
							required: ['anchor', 'citekey'],
							additionalProperties: false,
						},
					},
				},
				required: ['note', 'citations'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const note = asString(args.note);
				const raw = Array.isArray(args.citations) ? args.citations : undefined;
				if (!note || !raw || raw.length === 0) { return err('insert_citations requires `note` and a non-empty `citations` array.'); }
				const info = resolveNote(note);
				if (!info) { return err(`No note matches "${note}". Use list_notes to see ids/titles.`); }
				const blocked = blockedByOpenQuestions(info.filePath, info.title);
				if (blocked) { return blocked; }

				const requests = raw.map(item => {
					const obj = (item && typeof item === 'object') ? item as Record<string, unknown> : {};
					return { anchor: asString(obj.anchor)?.trim() ?? '', citekey: asString(obj.citekey)?.trim() ?? '' };
				});
				const bad = requests.filter(r => !r.anchor || !r.citekey);
				if (bad.length) { return err('Every citation needs a non-empty `anchor` and `citekey`.'); }

				// An unknown citekey is a mistake, not a placement question: it would
				// render as plain text and cite nothing, so reject the whole call.
				const library = await citableByKey();
				if (library.size > 0) {
					const unknown = [...new Set(requests.map(r => r.citekey))].filter(k => !library.has(k));
					if (unknown.length) {
						return err(
							`Not in the paper library: ${unknown.map(k => `[@${k}]`).join(', ')}. ` +
							`Citekeys come from list_saved_papers; for a paper that is not saved yet, call save_paper first and use the citekey it returns.`
						);
					}
				}

				try {
					let blocks = readBlocks(info.filePath);
					const currentMarkdown = await blocksToMarkdown(blocks);
					const pending: PendingCitation[] = [];
					const placed: string[] = [];
					let questionSeq = 0;
					for (const request of requests) {
						// Re-search each time: an earlier insertion shifts the offsets of
						// everything after it in the same block.
						const matches = findAnchorMatches(blocks, request.anchor);
						const title = library.get(request.citekey)?.title ?? request.citekey;
						if (matches.length === 1) {
							const result = insertCitation(blocks, matches[0].blockId, matches[0].offset, request.citekey);
							blocks = result.blocks;
							// 'duplicate' counts as placed - it IS cited right there.
							if (result.outcome !== 'unsupported') { placed.push(request.citekey); }
							continue;
						}
						pending.push({
							id: `q${++questionSeq}`,
							citekey: request.citekey,
							title,
							anchor: request.anchor,
							reason: matches.length === 0 ? 'not_found' : 'ambiguous',
							candidates: matches.length > 1 ? matches : undefined,
						});
					}

					await stage({
						filePath: info.filePath,
						title: readTitle(info.filePath) || info.title,
						currentMarkdown,
						blocks,
						pending,
					});

					const summary = {
						placed: placed.length,
						needsLocation: pending.map(p => ({ citekey: p.citekey, anchor: p.anchor, reason: p.reason })),
					};
					const tail = pending.length
						? ` ${pending.length} could not be placed and are now questions for the user to answer in the note editor - tell them, then wait.`
						: ' Ask the user to Accept it in the note editor.';
					return ok(`Staged citations for "${info.title}".${tail}\n${JSON.stringify(summary, null, 2)}`);
				} catch (e) {
					return err(`insert_citations failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'get_note_citations',
			description: 'List the papers a note cites, in reference-list order (order of first appearance; a paper cited again reuses its number and is listed once). Each entry is { number, citekey, title, occurrences, resolved }, where resolved is false when the citekey has no matching paper in the library - those render as plain text and cite nothing. Call this before adding citations so you do not duplicate one that is already there, and whenever the user asks what a note cites.',
			inputSchema: {
				type: 'object',
				properties: { note: { type: 'string', description: 'Note id or title.' } },
				required: ['note'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const note = asString(args.note);
				if (!note) { return err('get_note_citations requires `note` (id or title)'); }
				const info = resolveNote(note);
				if (!info) { return err(`No note matches "${note}".`); }
				try {
					const uses = collectCitations(readBlocks(info.filePath));
					if (uses.length === 0) { return ok(`"${info.title}" does not cite anything yet.`); }
					const library = await citableByKey();
					const rows = uses.map(u => ({
						number: u.number,
						citekey: u.citekey,
						title: library.get(u.citekey)?.title,
						occurrences: u.occurrences,
						resolved: library.has(u.citekey),
					}));
					return ok(`"${info.title}" cites ${rows.length} paper(s):\n${JSON.stringify(rows, null, 2)}`);
				} catch (e) {
					return err(`get_note_citations failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'delete_note',
			description: 'Delete a note file. Writes immediately (irreversible). `note` is the id or title.',
			inputSchema: {
				type: 'object',
				properties: { note: { type: 'string' } },
				required: ['note'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const note = asString(args.note);
				if (!note) { return err('delete_note requires `note`'); }
				const info = resolveNote(note);
				if (!info) { return err(`No note matches "${note}".`); }
				try {
					fs.rmSync(info.filePath);
					return ok(`Deleted note "${info.title}".`);
				} catch (e) {
					return err(`delete_note failed: ${(e as Error).message}`);
				}
			},
		},
	];
}
