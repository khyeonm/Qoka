/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ServerBlockNoteEditor } from '@blocknote/server-util';

/**
 * Note storage + Markdown<->BlockNote conversion for the aria-notes MCP.
 *
 * Notes are BlockNote documents stored as `<workspace>/notes/<id>.json`
 * (`{ version, title, blocks, updatedAt }`). Claude works in Markdown; this
 * module converts at the boundary using @blocknote/server-util (DOM-free,
 * version-matched to the editor) so the conversion matches what the editor
 * itself would produce.
 */

let serverEditor: ServerBlockNoteEditor | undefined;
function getServerEditor(): ServerBlockNoteEditor {
	if (!serverEditor) {
		serverEditor = ServerBlockNoteEditor.create();
	}
	return serverEditor;
}

export interface NoteInfo {
	id: string;
	title: string;
	filePath: string;
}

export function notesDir(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder ? path.join(folder.uri.fsPath, 'notes') : undefined;
}

export function listNotes(): NoteInfo[] {
	const dir = notesDir();
	if (!dir) { return []; }
	let files: string[] = [];
	try {
		files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
	} catch {
		return [];
	}
	return files.map(f => {
		const filePath = path.join(dir, f);
		const id = f.replace(/\.json$/, '');
		return { id, title: readTitle(filePath) || id, filePath };
	});
}

/** Resolve a note by id (exact), then title (exact, then substring), case-insensitive. */
export function resolveNote(noteArg: string): NoteInfo | undefined {
	const notes = listNotes();
	const arg = noteArg.trim().toLowerCase();
	return notes.find(n => n.id.toLowerCase() === arg)
		?? notes.find(n => n.title.toLowerCase() === arg)
		?? notes.find(n => n.title.toLowerCase().includes(arg));
}

export function readBlocks(filePath: string): unknown[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		return Array.isArray(parsed.blocks) ? parsed.blocks : [];
	} catch {
		return [];
	}
}

export function readTitle(filePath: string): string {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		return typeof parsed.title === 'string' ? parsed.title : '';
	} catch {
		return '';
	}
}

export function writeBlocks(filePath: string, title: string, blocks: unknown[]): void {
	const payload = { version: 1, title: title || 'Untitled', blocks, updatedAt: new Date().toISOString() };
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

export function createNote(title: string, blocks: unknown[]): NoteInfo {
	const info = newNoteInfo(title);
	writeBlocks(info.filePath, title, blocks);
	return info;
}

/**
 * Allocate a path/id for a new note WITHOUT writing it. Used to stage a new-note
 * proposal: the file is only created when the user accepts in the editor.
 */
export function newNoteInfo(title: string): NoteInfo {
	const dir = notesDir();
	if (!dir) {
		throw new Error('No workspace folder is open.');
	}
	const id = 'note-' + crypto.randomBytes(4).toString('hex');
	const filePath = path.join(dir, id + '.json');
	return { id, title: title || 'Untitled', filePath };
}

export async function blocksToMarkdown(blocks: unknown[]): Promise<string> {
	return getServerEditor().blocksToMarkdownLossy(blocks as never);
}

export async function markdownToBlocks(markdown: string): Promise<unknown[]> {
	return (await getServerEditor().tryParseMarkdownToBlocks(markdown)) as unknown[];
}

/** First non-empty line of markdown, stripped of leading #/-/*, as a title. */
export function titleFromMarkdown(markdown: string): string {
	for (const raw of markdown.split('\n')) {
		const line = raw.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
		if (line) { return line.slice(0, 80); }
	}
	return 'Untitled';
}
