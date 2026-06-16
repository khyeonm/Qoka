/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import {
	blocksToMarkdown, createNote, listNotes, markdownToBlocks,
	readBlocks, resolveNote, titleFromMarkdown,
} from '../notes';

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

function ok(text: string): CallToolResult { return { content: [{ type: 'text', text }] }; }
function err(text: string): CallToolResult { return { content: [{ type: 'text', text }], isError: true }; }
function asString(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined; }

/**
 * Note tools. Reads are direct; edits to an EXISTING note (update/append) are
 * STAGED as a proposal the user accepts in the editor — they do not write the
 * file. create/delete are direct.
 */
export function buildTools(propose: ProposeChange): ToolDefinition[] {
	return [
		{
			name: 'list_notes',
			description: 'List the research notes in this project (notes/*.json). Returns id and title for each — use the id or title to address a note in other tools.',
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
			description: 'Create a brand-new note from Markdown (writes immediately). Use ONLY when the user wants a new note. To add to or change an EXISTING note, use append_note/update_note — those show the change inside that note for the user to Accept.',
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
					return ok(`Created note "${info.title}" (id: ${info.id}).`);
				} catch (e) {
					return err(`create_note failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'update_note',
			description: 'Propose REPLACING a note\'s entire content with the given Markdown. Does NOT write — the user reviews and accepts the change in the editor. NOTE: replacing flattens BlockNote-only blocks (e.g. toggles) to plain blocks; prefer append_note when you only add content.',
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
			description: 'Propose APPENDING the given Markdown to the end of a note. Does NOT write — the user reviews and accepts in the editor. Existing blocks are preserved exactly (toggles etc. survive); only the new content is added.',
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
