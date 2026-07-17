/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ServerBlockNoteEditor } from '@blocknote/server-util';

/**
 * Storage layer for the Project Overview, PER-PROJECT at
 * <workspace>/.aria/overview.json. The workbench Project Overview view reads and
 * writes the same file directly (and watches it), so tools here just mutate the
 * file and the tab refreshes. Falls back to ~/.config/aria when no folder is open
 * so calls never crash.
 */

const SCHEMA_VERSION = 1;

export interface OverviewTask {
	id: string;
	label: string;
	done: boolean;
	checkedAt?: string;
}

export interface PendingCompletion {
	taskId: string;
	reason?: string;
}

export interface OverviewData {
	version: number;
	title: string;
	/** Notion-style "Content" as BlockNote blocks (the tab hosts a BlockNote
	 *  editor). MCP tools read/write it as plain text via the helpers below. */
	content: unknown[];
	tasks: OverviewTask[];
	pendingCompletions: PendingCompletion[];
}

/** Extract plain text from BlockNote blocks (best-effort, no BlockNote dep). */
export function blocksToText(blocks: unknown[]): string {
	const lines: string[] = [];
	for (const b of blocks) {
		const block = b as { content?: unknown; children?: unknown[] };
		const inline = Array.isArray(block.content) ? block.content : [];
		const text = inline.map(i => (i as { text?: string }).text ?? '').join('');
		lines.push(text);
		if (Array.isArray(block.children) && block.children.length) {
			lines.push(blocksToText(block.children));
		}
	}
	return lines.join('\n').trim();
}

/** Turn plain text into simple paragraph blocks (BlockNote fills ids on load). */
/** Split plain text into paragraph blocks. Used only for the LEGACY `summary`
 *  string migration; new writes go through markdownToBlocks so Markdown the AI
 *  sends (## headings, - lists, **bold**) becomes real BlockNote blocks instead
 *  of literal text. */
export function textToBlocks(text: string): unknown[] {
	const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
	if (paras.length === 0) { return []; }
	return paras.map(p => ({ type: 'paragraph', content: [{ type: 'text', text: p, styles: {} }] }));
}

// The tools advertise `summary` as Markdown, so parse it into real blocks with
// the SAME BlockNote version the editor webview runs (0.51.4) - otherwise the
// raw "## Heading" / "- item" text shows up verbatim in the Content editor.
let serverEditor: ServerBlockNoteEditor | undefined;
function getServerEditor(): ServerBlockNoteEditor {
	if (!serverEditor) {
		serverEditor = ServerBlockNoteEditor.create();
	}
	return serverEditor;
}

/** Parse Markdown into BlockNote blocks (headings, lists, bold, ...). Falls back
 *  to plain paragraphs if parsing ever fails, so a summary is never lost. */
export async function markdownToBlocks(markdown: string): Promise<unknown[]> {
	try {
		return (await getServerEditor().tryParseMarkdownToBlocks(markdown)) as unknown[];
	} catch {
		return textToBlocks(markdown);
	}
}

function overviewDir(): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder && folder.uri.scheme === 'file') {
		return path.join(folder.uri.fsPath, '.aria');
	}
	return path.join(os.homedir(), '.config', 'aria');
}

export function overviewPath(): string {
	return path.join(overviewDir(), 'overview.json');
}

function empty(): OverviewData {
	return { version: SCHEMA_VERSION, title: '', content: [], tasks: [], pendingCompletions: [] };
}

export function readOverview(): OverviewData {
	try {
		const raw = fs.readFileSync(overviewPath(), 'utf8');
		const p = JSON.parse(raw) as Partial<OverviewData> & { summary?: string };
		// Back-compat: an older `summary` string becomes content blocks.
		const content = Array.isArray(p.content)
			? p.content
			: (typeof p.summary === 'string' && p.summary ? textToBlocks(p.summary) : []);
		return {
			version: SCHEMA_VERSION,
			title: typeof p.title === 'string' ? p.title : '',
			content,
			tasks: Array.isArray(p.tasks) ? (p.tasks as OverviewTask[]) : [],
			pendingCompletions: Array.isArray(p.pendingCompletions) ? (p.pendingCompletions as PendingCompletion[]) : [],
		};
	} catch {
		return empty();
	}
}

function writeOverview(data: OverviewData): void {
	const p = overviewPath();
	const tmp = `${p}.tmp`;
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
	fs.renameSync(tmp, p);
}

/** Read-modify-write helper. */
function mutate<T>(fn: (d: OverviewData) => T): T {
	const d = readOverview();
	const r = fn(d);
	writeOverview(d);
	return r;
}

// --- title / summary ----------------------------------------------------

export function setTitle(title: string): void {
	mutate(d => { d.title = title; });
}

export function getSummaryText(): string {
	return blocksToText(readOverview().content);
}

export async function updateSummary(text: string, mode: 'replace' | 'append'): Promise<void> {
	// Parse BEFORE mutating so the (async) Markdown parse can't interleave with
	// the read-modify-write in mutate().
	const blocks = await markdownToBlocks(text);
	mutate(d => {
		d.content = mode === 'append' ? [...d.content, ...blocks] : blocks;
	});
}

// --- tasks --------------------------------------------------------------

export function addTask(label: string): OverviewTask {
	return mutate(d => {
		const task: OverviewTask = { id: crypto.randomUUID(), label, done: false };
		d.tasks.push(task);
		return task;
	});
}

export function addTasks(labels: string[]): OverviewTask[] {
	return mutate(d => {
		const added = labels.filter(l => l.trim()).map(l => ({ id: crypto.randomUUID(), label: l.trim(), done: false }));
		d.tasks.push(...added);
		return added;
	});
}

export function updateTask(id: string, patch: { label?: string }): boolean {
	return mutate(d => {
		const t = d.tasks.find(x => x.id === id);
		if (!t) { return false; }
		if (typeof patch.label === 'string') { t.label = patch.label; }
		return true;
	});
}

export function removeTask(id: string): boolean {
	return mutate(d => {
		const before = d.tasks.length;
		d.tasks = d.tasks.filter(x => x.id !== id);
		d.pendingCompletions = d.pendingCompletions.filter(p => p.taskId !== id);
		return d.tasks.length !== before;
	});
}

export function setTasksDone(ids: string[], done: boolean, when: string): { updated: string[] } {
	return mutate(d => {
		const updated: string[] = [];
		for (const id of ids) {
			const t = d.tasks.find(x => x.id === id);
			if (t) {
				t.done = done;
				t.checkedAt = done ? when : undefined;
				updated.push(id);
			}
		}
		// Completing/uncompleting clears any pending proposal for those tasks.
		d.pendingCompletions = d.pendingCompletions.filter(p => !ids.includes(p.taskId));
		return { updated };
	});
}

// --- AI completion proposals -------------------------------------------

export function proposeCompletions(taskIds: string[], reason: string | undefined): { proposed: string[] } {
	return mutate(d => {
		const proposed: string[] = [];
		for (const id of taskIds) {
			const t = d.tasks.find(x => x.id === id);
			if (!t || t.done) { continue; }                 // skip unknown / already-done
			if (d.pendingCompletions.some(p => p.taskId === id)) { continue; } // already pending
			d.pendingCompletions.push({ taskId: id, reason });
			proposed.push(id);
		}
		return { proposed };
	});
}
