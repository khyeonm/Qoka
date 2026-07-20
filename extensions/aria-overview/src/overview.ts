/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

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

/** Split plain text into paragraph blocks (BlockNote fills ids on load). Kept
 *  for legacy string-summary migration; new writes go through markdownToBlocks. */
export function textToBlocks(text: string): unknown[] {
	const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
	if (paras.length === 0) { return []; }
	return paras.map(p => ({ type: 'paragraph', content: [{ type: 'text', text: p, styles: {} }] }));
}

// --- Markdown -> BlockNote blocks ------------------------------------------
// A tiny, dependency-free Markdown converter. We deliberately do NOT use
// @blocknote/server-util for this: it drags in a huge transitive tree (jsdom,
// tldts, ...) that blew the CI file-descriptor limit (EMFILE) on macOS, for a
// job this small. The tools only advertise a handful of Markdown features
// (headings, bullet / numbered lists, bold / italic / inline code, paragraphs),
// so a ~50-line parser covers what the AI actually sends and emits the SAME
// block shapes the editor already renders (see textToBlocks). Anything fancier
// (tables, nested lists) degrades to plain text rather than being lost.

interface InlineStyles { bold?: true; italic?: true; code?: true; }

/** Parse inline **bold**, *italic* / _italic_, `code` into styled text runs. */
function parseInline(text: string): unknown[] {
	const out: unknown[] = [];
	const push = (t: string, styles: InlineStyles) => { if (t) { out.push({ type: 'text', text: t, styles }); } };
	const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_|`([^`]+)`/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m.index > last) { push(text.slice(last, m.index), {}); }
		if (m[1] !== undefined) { push(m[1], { bold: true }); }
		else if (m[2] !== undefined) { push(m[2], { italic: true }); }
		else if (m[3] !== undefined) { push(m[3], { italic: true }); }
		else if (m[4] !== undefined) { push(m[4], { code: true }); }
		last = re.lastIndex;
	}
	if (last < text.length) { push(text.slice(last), {}); }
	return out;
}

/** Convert a Markdown string into BlockNote blocks. Never throws. */
export function markdownToBlocks(markdown: string): unknown[] {
	const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
	const blocks: unknown[] = [];
	let para: string[] = [];
	const flush = () => {
		if (para.length) {
			const text = para.join(' ').trim();
			if (text) { blocks.push({ type: 'paragraph', content: parseInline(text) }); }
			para = [];
		}
	};
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) { flush(); continue; }
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			flush();
			blocks.push({ type: 'heading', props: { level: Math.min(heading[1].length, 3) }, content: parseInline(heading[2].trim()) });
			continue;
		}
		const bullet = /^[-*+]\s+(.*)$/.exec(line);
		if (bullet) {
			flush();
			blocks.push({ type: 'bulletListItem', content: parseInline(bullet[1].trim()) });
			continue;
		}
		const numbered = /^\d+\.\s+(.*)$/.exec(line);
		if (numbered) {
			flush();
			blocks.push({ type: 'numberedListItem', content: parseInline(numbered[1].trim()) });
			continue;
		}
		para.push(line);
	}
	flush();
	return blocks;
}

function overviewDir(): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder && folder.uri.scheme === 'file') {
		return path.join(folder.uri.fsPath, '.qoka');
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

export function updateSummary(text: string, mode: 'replace' | 'append'): void {
	const blocks = markdownToBlocks(text);
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
