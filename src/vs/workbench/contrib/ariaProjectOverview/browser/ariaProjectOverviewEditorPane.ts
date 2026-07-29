/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { AriaProjectOverviewEditorInput } from './ariaProjectOverviewEditorInput.js';
import { computeRoadmapLayout, layoutBounds, COLUMN_WIDTH, NODE_LINE_HEIGHT, NODE_LABEL_PAD_X } from '../../ariaRoadmapWizard/browser/roadmapCanvasLayout.js';

interface OverviewTask {
	id: string;
	label: string;
	done: boolean;
	checkedAt?: string;
	/**
	 * Optional deadline. Dates and times are stored SEPARATELY and WITHOUT a
	 * timezone, as local wall-clock values: a deadline is "6pm on the 4th", not an
	 * instant, so an ISO timestamp would shift the day for anyone in another
	 * timezone (and around midnight for everyone). `startDate` is set only for a
	 * period; a single deadline uses `dueDate` alone.
	 */
	startDate?: string;   // 'YYYY-MM-DD'
	startTime?: string;   // 'HH:mm', 24-hour
	dueDate?: string;     // 'YYYY-MM-DD'
	dueTime?: string;     // 'HH:mm', 24-hour
}

interface PendingCompletion {
	taskId: string;
	reason?: string;
}

interface OverviewData {
	version: number;
	title: string;
	/** BlockNote blocks - the on-disk shape the aria-overview MCP tools read
	 *  (blocksToText) and write (markdownToBlocks). We edit it as plain Markdown
	 *  in a lightweight textarea and convert at the load/save edges, so the stored
	 *  format - and everything that consumes it - is unchanged. */
	content: unknown[];
	tasks: OverviewTask[];
	pendingCompletions: PendingCompletion[];
}

interface RoadmapNode {
	id: string;
	parent: string | null;
	column: number;
	label: string;
}

/** A roadmap's label for the Select dropdown: its explicit name, else its first Goal
 *  node (the hypothesis sentence), else a placeholder. Mirrors the Notebook list. */
function roadmapDisplayName(explicit: string | undefined, nodes: RoadmapNode[]): string {
	const name = (explicit ?? '').trim();
	if (name) { return name; }
	const goal = nodes.find(n => n.column === 0 && (n.parent === null || n.parent === undefined));
	return (goal?.label ?? '').trim() || 'Untitled roadmap';
}

const SCHEMA_VERSION = 1;

function emptyOverview(): OverviewData {
	return { version: SCHEMA_VERSION, title: '', content: [], tasks: [], pendingCompletions: [] };
}

// --- Markdown <-> BlockNote blocks -----------------------------------------
// The Content is persisted as BlockNote blocks so the aria-overview MCP tools
// keep working unchanged (they read via blocksToText, write via markdownToBlocks
// in overview.ts). The editor here is a plain Markdown textarea - far lighter
// than the 1.7MB BlockNote webview it replaces - so we convert blocks<->Markdown
// only at load/save. These helpers MUST emit the same block shapes as the
// extension's converter (paragraph / heading / bulletListItem / numberedListItem
// with bold/italic/code inline styles); anything richer degrades to plain text.

interface InlineStyles { bold?: true; italic?: true; code?: true }

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
function markdownToBlocks(markdown: string): unknown[] {
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

/** Render a block's inline runs back to Markdown (inverse of parseInline). */
function inlineToMarkdown(content: unknown): string {
	if (!Array.isArray(content)) { return ''; }
	let out = '';
	for (const run of content) {
		const r = run as { text?: string; styles?: InlineStyles };
		let t = typeof r.text === 'string' ? r.text : '';
		if (!t) { continue; }
		const s = r.styles ?? {};
		if (s.code) { t = '`' + t + '`'; }
		if (s.italic) { t = '*' + t + '*'; }
		if (s.bold) { t = '**' + t + '**'; }
		out += t;
	}
	return out;
}

/** Render a single block (and its children) to one or more Markdown lines. */
function blockToMarkdown(b: unknown): string {
	const block = b as { type?: string; props?: { level?: number }; content?: unknown; children?: unknown[] };
	const text = inlineToMarkdown(block.content);
	let head: string;
	switch (block.type) {
		case 'heading': {
			const level = Math.min(Math.max(block.props?.level ?? 1, 1), 6);
			head = '#'.repeat(level) + ' ' + text;
			break;
		}
		case 'bulletListItem': head = '- ' + text; break;
		case 'numberedListItem': head = '1. ' + text; break;
		default: head = text; break;
	}
	if (Array.isArray(block.children) && block.children.length) {
		return head + '\n' + block.children.map(blockToMarkdown).join('\n');
	}
	return head;
}

/** Convert stored BlockNote blocks into editable Markdown. Adjacent list items
 *  stay tight; everything else is blank-line separated so markdownToBlocks
 *  round-trips paragraphs without merging them. */
function blocksToMarkdown(blocks: unknown[]): string {
	const arr = blocks as { type?: string }[];
	const isList = (t?: string) => t === 'bulletListItem' || t === 'numberedListItem';
	let out = '';
	for (let i = 0; i < arr.length; i++) {
		const md = blockToMarkdown(arr[i]);
		if (i === 0) { out = md; continue; }
		const sep = isList(arr[i - 1]?.type) && isList(arr[i]?.type) ? '\n' : '\n\n';
		out += sep + md;
	}
	return out;
}

/**
 * Project Overview editor pane. Opens full-width across the editor area (unlike
 * the other tabs which show a narrow list + editor): an editable Title, a
 * lightweight Markdown Content editor (a plain textarea - it replaces the heavy
 * BlockNote webview so the tab loads instantly, notably on Windows), and two
 * fixed sections below - the Roadmap (static picture of the project's active
 * roadmap) and the To-do checklist (with AI-proposed completions to Accept /
 * Reject). Reads/writes <folder>/.aria/overview.json; a watcher refreshes on
 * external (MCP) changes to the overview or the roadmap.
 */
export class AriaProjectOverviewEditorPane extends EditorPane {

	static readonly ID = AriaProjectOverviewEditorInput.EDITOR_ID;

	private data: OverviewData = emptyOverview();
	private roadmapNodes: RoadmapNode[] = [];
	/** Id of the roadmap the box currently shows. */
	private newestRoadmapId: string | undefined;
	/** All roadmaps directly under the Overview - the "Select" dropdown's choices. */
	private overviewRoadmaps: { id: string; name: string }[] = [];
	/** The roadmap the user explicitly picked in the dropdown (else the newest shows). */
	private selectedRoadmapId: string | undefined;
	/** Closes the open roadmap dropdown, if any (also used to toggle it). */
	private roadmapMenuClose: (() => void) | undefined;
	private folderResource: URI | undefined;

	private container: HTMLElement | undefined;
	private titleInput: HTMLInputElement | undefined;
	private contentTextarea: HTMLTextAreaElement | undefined;
	private startCardEl: HTMLElement | undefined;
	private sectionsEl: HTMLElement | undefined;
	private readonly watcherStore = this._register(new DisposableStore());
	private lastSelfWriteAt = 0;
	/** Fields the USER has edited locally and that must survive a merge on save. */
	private dirtyTitle = false;
	private dirtyContent = false;
	private readonly saveScheduler = this._register(new RunOnceScheduler(() => void this.persist(), 500));

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super(AriaProjectOverviewEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	// --- pane lifecycle ----------------------------------------------------

	protected createEditor(parent: HTMLElement): void {
		const root = document.createElement('div');
		Object.assign(root.style, {
			width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative',
			color: 'var(--vscode-foreground)', fontSize: '13px', boxSizing: 'border-box', overflow: 'hidden',
			background: 'var(--vscode-editor-background, #1e1e1e)',
			fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
		});

		// First-run guidance: tell the user to introduce the project in the AI chat.
		// Shown only while the project has no title/content yet (toggled in applyData).
		// Deliberately loud - yellow and gently pulsing - because on an empty project
		// this is the one thing the user needs to do, and the old faint blue box was
		// easy to miss next to a big empty editor.
		this.installCardPulseStyle(root.ownerDocument);
		const card = append(root, $('div'));
		card.className = 'aria-overview-start-card';
		Object.assign(card.style, {
			flex: '0 0 auto', display: 'none', flexDirection: 'row', alignItems: 'center', gap: '10px',
			border: '1px solid var(--vscode-editorWarning-foreground, #cca700)', borderRadius: '8px',
			background: 'rgba(255,193,7,0.16)', padding: '12px 16px', margin: '14px 20px 0 20px',
		});
		const cardIcon = append(card, $('span.codicon.codicon-arrow-right')) as HTMLElement;
		Object.assign(cardIcon.style, { fontSize: '16px', flexShrink: '0', opacity: '0.8' });
		const cardText = append(card, $('div'));
		cardText.textContent = 'Tell the AI chat on the right what you want to research, and it will help you write this project overview.';
		Object.assign(cardText.style, { fontSize: '13px', lineHeight: '1.5' });
		this.startCardEl = card;

		// Title (Notion-style large input).
		const title = append(root, $('input')) as HTMLInputElement;
		title.placeholder = 'Untitled project';
		Object.assign(title.style, {
			flex: '0 0 auto', width: '100%', boxSizing: 'border-box', border: 'none', outline: 'none',
			background: 'transparent', color: 'var(--vscode-foreground)', fontSize: '28px', fontWeight: '700',
			padding: '16px 20px 8px 20px', fontFamily: 'inherit',
		});
		title.onchange = () => { this.data.title = title.value; this.dirtyTitle = true; this.updateStartCard(); this.saveScheduler.schedule(); };
		this.titleInput = title;

		// Content (lightweight Markdown textarea) - the flexible middle region.
		const textarea = append(root, $('textarea')) as HTMLTextAreaElement;
		textarea.placeholder = 'Write the project overview in Markdown...';
		textarea.spellcheck = false;
		Object.assign(textarea.style, {
			flex: '1 1 auto', minHeight: '160px', width: '100%', boxSizing: 'border-box',
			border: 'none', outline: 'none', resize: 'none',
			background: 'transparent', color: 'var(--vscode-foreground)',
			fontSize: '14px', lineHeight: '1.6', padding: '4px 20px 12px 20px',
			fontFamily: 'var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
		});
		textarea.oninput = () => {
			this.data.content = markdownToBlocks(textarea.value);
			this.dirtyContent = true;
			this.updateStartCard();
			this.saveScheduler.schedule();
		};
		this.contentTextarea = textarea;

		// Draggable divider between the Content (above) and the Roadmap+To-do
		// sections (below). Dragging it up/down resizes the two areas.
		const divider = append(root, $('div'));
		Object.assign(divider.style, {
			flex: '0 0 auto', height: '7px', cursor: 'row-resize', position: 'relative',
			borderTop: '1px solid rgba(127,127,127,0.25)',
		});
		const grip = append(divider, $('div'));
		Object.assign(grip.style, {
			position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
			width: '40px', height: '3px', borderRadius: '2px', background: 'rgba(127,127,127,0.4)',
		});

		// Fixed sections below: Roadmap + To-do (own scroll).
		const sections = append(root, $('div'));
		Object.assign(sections.style, {
			flex: '0 0 auto', maxHeight: '45%', overflowY: 'auto', overflowX: 'hidden',
			padding: '4px 20px 16px 20px',
		});
		this.sectionsEl = sections;

		this.wireDividerDrag(root, divider, sections);

		parent.appendChild(root);
		this.container = root;
	}

	/**
	 * Make the divider drag to resize the Content area vs the sections below.
	 * A transparent overlay covers the pane during the drag so text selection in
	 * the textarea doesn't hijack the pointer stream mid-drag.
	 */
	private wireDividerDrag(root: HTMLElement, divider: HTMLElement, sections: HTMLElement): void {
		divider.addEventListener('mousedown', (e: MouseEvent) => {
			e.preventDefault();
			const doc = divider.ownerDocument;
			const startY = e.clientY;
			const startHeight = sections.getBoundingClientRect().height;
			const rootHeight = root.getBoundingClientRect().height;

			const overlay = doc.createElement('div');
			Object.assign(overlay.style, { position: 'absolute', inset: '0', zIndex: '50', cursor: 'row-resize' });
			root.appendChild(overlay);

			const onMove = (ev: MouseEvent) => {
				// Drag up => taller sections. Keep at least 200px for the content above.
				const min = 60;
				const max = Math.max(min, rootHeight - 200);
				const h = Math.min(max, Math.max(min, startHeight + (startY - ev.clientY)));
				sections.style.maxHeight = 'none';
				sections.style.height = `${h}px`;
			};
			const onUp = () => {
				doc.removeEventListener('mousemove', onMove, true);
				doc.removeEventListener('mouseup', onUp, true);
				overlay.remove();
			};
			doc.addEventListener('mousemove', onMove, true);
			doc.addEventListener('mouseup', onUp, true);
		});
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof AriaProjectOverviewEditorInput)) {
			return;
		}
		this.folderResource = input.folderResource;
		this.setupWatcher();
		await this.reload();
	}

	// --- storage -----------------------------------------------------------

	private folderUri(): URI | undefined {
		return this.folderResource && this.folderResource.scheme === 'file' ? this.folderResource : undefined;
	}

	private overviewUri(): URI | undefined {
		const f = this.folderUri();
		return f ? URI.joinPath(f, '.qoka', 'overview.json') : undefined;
	}

	private setupWatcher(): void {
		this.watcherStore.clear();
		try {
			const f = this.folderUri();
			if (!f) { return; }
			const dirUri = URI.joinPath(f, '.qoka');
			const overview = URI.joinPath(dirUri, 'overview.json');
			const roadmapsDir = URI.joinPath(dirUri, 'roadmaps');
			// index.json records which roadmap sits under the Overview, so a move
			// (which changes only the index) must also refresh the shown roadmap.
			const notebookIndex = URI.joinPath(dirUri, 'notebook', 'index.json');
			this.watcherStore.add(this.fileService.watch(dirUri));
			this.watcherStore.add(this.fileService.watch(roadmapsDir));
			this.watcherStore.add(this.fileService.onDidFilesChange(e => {
				// Only skip the echo of our OWN write, and only for a moment. The
				// previous guard dropped EVERY change in a 1s window, so an MCP write
				// that arrived right after a local edit was silently discarded.
				if (Date.now() - this.lastSelfWriteAt < 300) { return; }
				if (e.contains(overview) || e.affects(roadmapsDir) || e.contains(notebookIndex)) { void this.reload(); }
			}));
		} catch { /* best-effort */ }
	}

	override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		// Coming back to the tab (e.g. after the AI moved to the Roadmap and back)
		// must always show what is on disk now.
		if (visible) { void this.reload(); }
	}

	/**
	 * Re-read from disk and render. Deliberately UNCONDITIONAL: an earlier version
	 * skipped the render when the data matched what it had last read, but it
	 * recorded that BEFORE applyData, which skips fields it cannot write yet (the
	 * textarea may not exist, or may be focused). Once recorded, the same content
	 * never rendered again - and because the pane is reused, closing and reopening
	 * the tab did not help either. That is exactly the "the AI says it wrote the
	 * summary but the Content is empty" report. Re-rendering is cheap; being right
	 * matters more.
	 */
	private async reload(): Promise<void> {
		this.data = await this.readOverview();
		this.roadmapNodes = await this.readRoadmap();
		this.applyData();
	}

	private async readOverview(): Promise<OverviewData> {
		const uri = this.overviewUri();
		if (!uri) { return emptyOverview(); }
		try {
			const raw = (await this.fileService.readFile(uri)).value.toString();
			const p = JSON.parse(raw) as Partial<OverviewData> & { summary?: string };
			const content = Array.isArray(p.content) ? p.content : [];
			return {
				version: SCHEMA_VERSION,
				title: typeof p.title === 'string' ? p.title : '',
				content,
				tasks: Array.isArray(p.tasks) ? (p.tasks as OverviewTask[]) : [],
				pendingCompletions: Array.isArray(p.pendingCompletions) ? (p.pendingCompletions as PendingCompletion[]) : [],
			};
		} catch {
			return emptyOverview();
		}
	}

	/**
	 * Read the roadmap to show in the overview. A project can hold many roadmaps
	 * (each `.qoka/roadmaps/<id>.json`) placed anywhere in the Notebook tree, so the
	 * overview shows only a roadmap that sits DIRECTLY UNDER the Overview page - not
	 * whichever was edited last. Among those, the most recently updated one wins.
	 * Falls back to the legacy single `.aria/roadmap.json` if the folder is empty.
	 */
	private async readRoadmap(): Promise<RoadmapNode[]> {
		const f = this.folderUri();
		if (!f) { this.overviewRoadmaps = []; return []; }
		const parentOf = await this.readNotebookParents(f);
		const roadmapsDir = URI.joinPath(f, '.qoka', 'roadmaps');
		try {
			const dir = await this.fileService.resolve(roadmapsDir);
			// Every roadmap that sits directly under the Overview - the choices offered
			// in the section's "Select" dropdown.
			const candidates: { id: string; name: string; nodes: RoadmapNode[]; updatedAt: number }[] = [];
			for (const child of dir.children ?? []) {
				if (child.isDirectory || !child.name.endsWith('.json')) { continue; }
				const id = child.name.slice(0, -'.json'.length);
				// A roadmap absent from the index defaults to sitting under the Overview
				// root; one moved into a folder has that folder as its parent instead.
				const parent = parentOf.has(id) ? parentOf.get(id) : 'overview';
				if (parent !== 'overview') { continue; }
				try {
					const raw = (await this.fileService.readFile(child.resource)).value.toString();
					const parsed = JSON.parse(raw) as { nodes?: RoadmapNode[]; updatedAt?: number; name?: string };
					const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
					candidates.push({ id, name: roadmapDisplayName(parsed.name, nodes), nodes, updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0 });
				} catch { /* skip unreadable roadmap */ }
			}
			// Newest first, so the dropdown and the default choice share an order.
			candidates.sort((a, b) => b.updatedAt - a.updatedAt);
			this.overviewRoadmaps = candidates.map(c => ({ id: c.id, name: c.name }));
			// Show the user's picked roadmap if it still exists, else the newest with
			// content, else just the newest.
			const chosen = candidates.find(c => c.id === this.selectedRoadmapId)
				?? candidates.find(c => c.nodes.length)
				?? candidates[0];
			this.newestRoadmapId = chosen?.id;
			if (chosen) { return chosen.nodes; }
		} catch { /* no roadmaps dir yet */ }
		this.overviewRoadmaps = [];
		// Legacy single-file roadmap.
		try {
			const raw = (await this.fileService.readFile(URI.joinPath(f, '.qoka', 'roadmap.json'))).value.toString();
			const parsed = JSON.parse(raw) as { nodes?: RoadmapNode[] };
			return Array.isArray(parsed.nodes) ? parsed.nodes : [];
		} catch {
			return [];
		}
	}

	/** Map each Notebook page id to its parent page id, from the Notebook index. Used
	 *  to tell which roadmaps sit under the Overview. Missing/unreadable index -> an
	 *  empty map, so every roadmap falls back to its default (under the Overview). */
	private async readNotebookParents(folder: URI): Promise<Map<string, string | null>> {
		const out = new Map<string, string | null>();
		try {
			const raw = (await this.fileService.readFile(URI.joinPath(folder, '.qoka', 'notebook', 'index.json'))).value.toString();
			const parsed = JSON.parse(raw) as { pages?: Array<{ id?: string; parent?: string | null }> };
			for (const p of parsed.pages ?? []) {
				if (typeof p.id === 'string') { out.set(p.id, p.parent ?? null); }
			}
		} catch { /* no index yet - callers default to the Overview root */ }
		return out;
	}

	/**
	 * Save, MERGING onto whatever is on disk rather than writing our whole
	 * in-memory copy. The AI edits the same file through the overview MCP, so a
	 * blind write of a stale copy would silently erase a summary or a task list
	 * the AI had just added - the user then sees an empty Content and concludes
	 * nothing was ever written. Only fields the user actually touched win.
	 */
	private async persist(): Promise<void> {
		const uri = this.overviewUri();
		if (!uri) { return; }
		try {
			const onDisk = await this.readOverview();
			const merged: OverviewData = {
				...onDisk,
				title: this.dirtyTitle ? this.data.title : onDisk.title,
				content: this.dirtyContent ? this.data.content : onDisk.content,
				// Tasks and proposals are only ever changed here through explicit
				// user actions, which set this.data first, so they carry over.
				tasks: this.data.tasks,
				pendingCompletions: this.data.pendingCompletions,
			};
			this.data = merged;
			this.dirtyTitle = false;
			this.dirtyContent = false;
			this.lastSelfWriteAt = Date.now();
			await this.fileService.createFolder(URI.joinPath(this.folderUri()!, '.qoka')).catch(() => { /* exists */ });
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(merged, null, 2) + '\n'));
			this.lastSelfWriteAt = Date.now();
		} catch { /* best-effort */ }
	}

	// --- content + guidance ------------------------------------------------

	/** Show the "introduce your project" guidance only while it's still empty. */
	private updateStartCard(): void {
		if (!this.startCardEl) { return; }
		const empty = !this.data.title.trim() && this.data.content.length === 0;
		this.startCardEl.style.display = empty ? 'flex' : 'none';
	}

	/** Inject the start-card pulse keyframes once per document. Kept subtle (a soft
	 *  glow, not motion) so it draws the eye without being annoying. */
	private installCardPulseStyle(doc: Document): void {
		if (doc.getElementById('aria-overview-card-pulse-style')) { return; }
		const style = doc.createElement('style');
		style.id = 'aria-overview-card-pulse-style';
		style.textContent = `
@keyframes aria-overview-card-pulse {
	0%, 100% { box-shadow: 0 0 0 0 rgba(255,193,7,0.0); }
	50%      { box-shadow: 0 0 0 4px rgba(255,193,7,0.28); }
}
.aria-overview-start-card { animation: aria-overview-card-pulse 1.8s ease-in-out infinite; }`;
		doc.head.appendChild(style);
	}

	/**
	 * Push freshly-loaded data into the UI, skipping fields with UNSAVED user
	 * edits so an external (MCP) refresh never clobbers something being typed.
	 *
	 * "Has unsaved edits" is deliberately NOT "has focus". This pane's focus()
	 * focuses the content textarea, and the workbench calls focus() every time the
	 * editor is opened or activated - so a focus-based guard meant the textarea was
	 * permanently considered "in use" and never took an update. The summary the AI
	 * wrote landed in overview.json and showed up nowhere, and reopening the tab
	 * refocused the textarea and skipped it again. The dirty flags are cleared on
	 * save, so a real in-progress edit is still protected.
	 */
	private applyData(): void {
		if (this.titleInput && !this.dirtyTitle) {
			this.titleInput.value = this.data.title;
		}
		if (this.contentTextarea && !this.dirtyContent) {
			const markdown = blocksToMarkdown(this.data.content);
			// Preserve the caret when the text is unchanged, so a refresh triggered
			// while the user is reading does not jump them back to the top.
			if (this.contentTextarea.value !== markdown) {
				this.contentTextarea.value = markdown;
			}
		}
		this.updateStartCard();
		this.renderSections();
	}

	// --- fixed sections (roadmap + to-do) ----------------------------------

	/**
	 * Rebuild the roadmap + To-do area.
	 *
	 * The scroll offset is saved and restored because this container scrolls and
	 * `clearNode` resets `scrollTop` to 0 the instant its children go away. Every
	 * checkbox tick, rename and delete re-renders, so without this the view jumped
	 * back up to the roadmap each time - the user lost their place in the list
	 * exactly when they were working through it.
	 */
	private renderSections(): void {
		if (!this.sectionsEl) { return; }
		const scroll = this.sectionsEl.scrollTop;
		clearNode(this.sectionsEl);
		this.renderRoadmap(this.sectionsEl);
		this.renderTasks(this.sectionsEl);
		this.sectionsEl.scrollTop = scroll;
	}

	private sectionLabel(parent: HTMLElement, text: string): void {
		const l = append(parent, $('div'));
		l.textContent = text;
		Object.assign(l.style, { fontSize: '11px', fontWeight: '600', opacity: '0.6', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '14px 0 6px 0' });
	}

	private renderRoadmap(parent: HTMLElement): void {
		// Header row: the "Roadmap" label, plus a "Select" dropdown on the right when
		// more than one roadmap sits under the Overview.
		// Close any open dropdown left over from a previous render.
		this.roadmapMenuClose?.();
		if (this.overviewRoadmaps.length > 1) {
			const header = append(parent, $('div'));
			Object.assign(header.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '14px 0 6px 0' });
			const label = append(header, $('div'));
			label.textContent = 'Roadmap';
			Object.assign(label.style, { flex: '1', fontSize: '11px', fontWeight: '600', opacity: '0.6', textTransform: 'uppercase', letterSpacing: '0.04em' });

			// A custom dropdown so the popup list can be styled to match Qoka (a native
			// <select> renders an OS-styled, square list we cannot theme).
			const current = this.overviewRoadmaps.find(r => r.id === this.newestRoadmapId);
			const trigger = append(header, $('div'));
			trigger.title = 'Choose which roadmap to show';
			Object.assign(trigger.style, {
				display: 'flex', alignItems: 'center', gap: '6px', maxWidth: '60%', boxSizing: 'border-box',
				fontSize: '11px', padding: '3px 8px', borderRadius: '6px', cursor: 'pointer',
				background: 'var(--vscode-dropdown-background)', color: 'var(--vscode-dropdown-foreground)',
				border: '1px solid var(--vscode-dropdown-border, rgba(127,127,127,0.35))',
			});
			const name = append(trigger, $('span'));
			name.textContent = current?.name ?? 'Select roadmap';
			Object.assign(name.style, { flex: '1', minWidth: '0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
			const chevron = append(trigger, $('span.codicon.codicon-chevron-down')) as HTMLElement;
			Object.assign(chevron.style, { fontSize: '13px', opacity: '0.8', flexShrink: '0' });
			trigger.onclick = () => this.toggleRoadmapMenu(trigger);
		} else {
			this.sectionLabel(parent, 'Roadmap');
		}
		const box = append(parent, $('div'));
		Object.assign(box.style, { border: '1px solid rgba(127,127,127,0.25)', borderRadius: '6px', padding: '8px', cursor: 'pointer', overflowX: 'auto' });
		box.title = 'Open this roadmap (and show the Notebook list)';
		// The Roadmap tab was merged into the Notebook tab. Reveal the Notebook page
		// tree (via the views service, which focuses without toggling the sidebar
		// shut) so the roadmaps are listed, then open the active roadmap in the editor.
		box.onclick = () => {
			void (async () => {
				try { await this.viewsService.openViewContainer('workbench.view.ariaNotebook', true); } catch { /* sidebar optional */ }
				try {
					if (this.newestRoadmapId) {
						await this.commandService.executeCommand('aria.roadmap.openWizard', { id: this.newestRoadmapId });
					}
				} catch { /* editor optional */ }
			})();
		};

		if (this.roadmapNodes.length === 0) {
			const empty = append(box, $('div'));
			empty.textContent = 'No roadmap yet. Add one in the Notebook tab.';
			Object.assign(empty.style, { opacity: '0.6', padding: '6px' });
			return;
		}
		this.drawRoadmapGraph(box, this.roadmapNodes);
	}

	private toggleRoadmapMenu(trigger: HTMLElement): void {
		if (this.roadmapMenuClose) { this.roadmapMenuClose(); return; }
		this.openRoadmapMenu(trigger);
	}

	/** A Qoka-styled dropdown list anchored under `trigger`: rounded, soft-shadowed,
	 *  with hover highlight and a check on the current roadmap. */
	private openRoadmapMenu(trigger: HTMLElement): void {
		const doc = trigger.ownerDocument;
		const rect = trigger.getBoundingClientRect();
		const menu = doc.createElement('div');
		Object.assign(menu.style, {
			position: 'fixed', left: `${rect.left}px`, top: `${rect.bottom + 4}px`,
			minWidth: `${Math.max(rect.width, 180)}px`, maxWidth: '340px', zIndex: '3000',
			background: 'var(--vscode-editorWidget-background, var(--vscode-dropdown-background))',
			border: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.35))', borderRadius: '8px',
			boxShadow: '0 6px 24px rgba(0,0,0,0.35)', padding: '4px', maxHeight: '260px', overflowY: 'auto',
			fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)', fontSize: '12px', color: 'var(--vscode-foreground)',
		});

		const close = () => {
			doc.removeEventListener('mousedown', onDown, true);
			doc.removeEventListener('keydown', onKey, true);
			menu.remove();
			this.roadmapMenuClose = undefined;
		};
		const onDown = (e: MouseEvent) => {
			const t = e.target as Node;
			if (menu.contains(t) || trigger.contains(t)) { return; }
			close();
		};
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); } };

		for (const r of this.overviewRoadmaps) {
			const item = append(menu, $('div'));
			Object.assign(item.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '5px', cursor: 'pointer' });
			item.addEventListener('mouseenter', () => { item.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.15))'; });
			item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
			const check = append(item, $('span.codicon.codicon-check')) as HTMLElement;
			Object.assign(check.style, { fontSize: '13px', flexShrink: '0', opacity: '0.85', visibility: r.id === this.newestRoadmapId ? 'visible' : 'hidden' });
			const label = append(item, $('span'));
			label.textContent = r.name;
			Object.assign(label.style, { flex: '1', minWidth: '0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
			item.onclick = () => { close(); this.selectedRoadmapId = r.id; void this.reload(); };
		}

		doc.body.appendChild(menu);
		doc.addEventListener('mousedown', onDown, true);
		doc.addEventListener('keydown', onKey, true);
		this.roadmapMenuClose = close;
	}

	/**
	 * Draw the roadmap as the same line-connected node graph the Roadmap editor
	 * shows - reusing the shared, pure tidy-tree layout (roadmapCanvasLayout) so the
	 * shape matches exactly. This is a static, read-only render (no pan/zoom, kebab,
	 * or add buttons); the whole tree is fit to the section width via the viewBox.
	 */
	private drawRoadmapGraph(box: HTMLElement, nodes: RoadmapNode[]): void {
		const svgNS = 'http://www.w3.org/2000/svg';
		// Only persisted (committed) nodes exist here; no in-flight AI proposals.
		const laid = computeRoadmapLayout(nodes, []);
		if (laid.length === 0) { return; }
		const bounds = layoutBounds(laid);

		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
		svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
		Object.assign(svg.style, { width: '100%', aspectRatio: `${bounds.width} / ${bounds.height}`, maxHeight: '360px', display: 'block' });

		// Connections first (behind the cards), as cubic-bezier paths parent->child.
		for (const node of laid) {
			if (node.parent === null) { continue; }
			const parent = laid.find(n => n.id === node.parent);
			if (!parent) { continue; }
			const path = document.createElementNS(svgNS, 'path');
			const x1 = parent.x + COLUMN_WIDTH;
			const y1 = parent.y + parent.height / 2;
			const x2 = node.x;
			const y2 = node.y + node.height / 2;
			const mid = (x1 + x2) / 2;
			path.setAttribute('d', `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
			path.setAttribute('stroke', 'rgba(127,127,127,0.6)');
			path.setAttribute('stroke-width', '1.5');
			path.setAttribute('fill', 'none');
			svg.appendChild(path);
		}

		// Node cards: rounded rect + wrapped, vertically-centered label.
		for (const node of laid) {
			const g = document.createElementNS(svgNS, 'g');
			g.setAttribute('transform', `translate(${node.x}, ${node.y})`);

			const rect = document.createElementNS(svgNS, 'rect');
			rect.setAttribute('width', String(COLUMN_WIDTH));
			rect.setAttribute('height', String(node.height));
			rect.setAttribute('rx', '8');
			rect.setAttribute('ry', '8');
			rect.setAttribute('fill', 'var(--vscode-editor-background, #1e1e1e)');
			rect.setAttribute('stroke', 'rgba(127,127,127,0.5)');
			rect.setAttribute('stroke-width', '1.2');
			g.appendChild(rect);

			const label = document.createElementNS(svgNS, 'text');
			label.setAttribute('fill', 'var(--vscode-foreground, #cccccc)');
			label.setAttribute('font-size', '13');
			label.setAttribute('font-weight', '600');
			const blockHeight = node.lines.length * NODE_LINE_HEIGHT;
			const firstBaseline = (node.height - blockHeight) / 2 + NODE_LINE_HEIGHT - 4;
			node.lines.forEach((line, i) => {
				const tspan = document.createElementNS(svgNS, 'tspan');
				tspan.textContent = line;
				tspan.setAttribute('x', String(NODE_LABEL_PAD_X));
				tspan.setAttribute('y', String(firstBaseline + i * NODE_LINE_HEIGHT));
				label.appendChild(tspan);
			});
			g.appendChild(label);

			svg.appendChild(g);
		}

		box.appendChild(svg);
	}

	private renderTasks(parent: HTMLElement): void {
		this.sectionLabel(parent, 'To do');

		for (const pc of this.data.pendingCompletions) {
			const task = this.data.tasks.find(t => t.id === pc.taskId);
			if (!task) { continue; }
			const badge = append(parent, $('div'));
			Object.assign(badge.style, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', border: '1px solid rgba(240,200,0,0.5)', background: 'rgba(240,200,0,0.12)', borderRadius: '6px', padding: '6px 8px', margin: '0 0 6px 0' });
			const text = append(badge, $('span'));
			text.textContent = `Mark "${task.label}" complete?`;
			Object.assign(text.style, { flex: '1', minWidth: '0', fontSize: '12px' });
			if (pc.reason) { text.title = pc.reason; }
			badge.appendChild(this.smallButton('Accept', true, () => { void this.acceptCompletion(pc.taskId); }));
			badge.appendChild(this.smallButton('Reject', false, () => { void this.rejectCompletion(pc.taskId); }));
		}

		const list = append(parent, $('div'));
		Object.assign(list.style, { display: 'flex', flexDirection: 'column', gap: '2px' });
		for (const task of this.data.tasks) { list.appendChild(this.taskRow(task)); }

		const addRow = append(parent, $('div'));
		Object.assign(addRow.style, { display: 'flex', gap: '6px', marginTop: '8px' });
		const input = append(addRow, $('input')) as HTMLInputElement;
		input.placeholder = 'Add a task...';
		Object.assign(input.style, { flex: '1', minWidth: '0', boxSizing: 'border-box', padding: '5px 8px', borderRadius: '5px', border: '1px solid rgba(127,127,127,0.3)', background: 'var(--vscode-input-background, transparent)', color: 'var(--vscode-foreground)', fontSize: '12px', fontFamily: 'inherit' });
		const commit = () => {
			const label = input.value.trim();
			if (!label) { return; }
			this.data.tasks.push({ id: generateUuid(), label, done: false });
			input.value = '';
			void this.persist();
			this.renderSections();
		};
		input.onkeydown = (e) => { if (e.key === 'Enter') { commit(); } };
		addRow.appendChild(this.smallButton('Add', true, commit));
	}

	// --- deadlines --------------------------------------------------------

	/** Today as 'YYYY-MM-DD' in the user's own timezone. `toISOString()` is UTC and
	 *  would report the wrong day for anyone west of Greenwich in the evening. */
	private static todayKey(d = new Date()): string {
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}

	/** 'YYYY-MM-DD' -> a local Date at midnight (NOT Date.parse, which reads a
	 *  bare date as UTC). */
	private static parseKey(key: string): Date {
		const [y, m, d] = key.split('-').map(n => parseInt(n, 10));
		return new Date(y, (m || 1) - 1, d || 1);
	}

	/** Chip label, showing whatever was set: `Jul 4`, `Jul 4 18:00`, or the full
	 *  `Jul 1 18:00 - Jul 2 19:00` for a range. Times appear only when the user
	 *  chose them. */
	private static formatDeadline(task: OverviewTask): string {
		if (!task.dueDate) { return ''; }
		const part = (date: string, time?: string) => {
			const d = AriaProjectOverviewEditorPane.parseKey(date);
			const label = `${d.toLocaleDateString(undefined, { month: 'short' })} ${d.getDate()}`;
			return time ? `${label} ${time}` : label;
		};
		return task.startDate
			? `${part(task.startDate, task.startTime)} - ${part(task.dueDate, task.dueTime)}`
			: part(task.dueDate, task.dueTime);
	}

	/** How pressing this deadline is, for colour. A date with no time is due at the
	 *  END of that day - treating it as midnight would mark today's task overdue
	 *  from the moment the user woke up. Recomputed on every render, and the pane
	 *  re-renders when the tab becomes visible, so simply looking at the tab
	 *  refreshes it. */
	private static urgency(task: OverviewTask): 'overdue' | 'soon' | 'later' | 'none' {
		if (!task.dueDate || task.done) { return 'none'; }
		const [h, m] = (task.dueTime ?? '23:59').split(':').map(n => parseInt(n, 10));
		const due = AriaProjectOverviewEditorPane.parseKey(task.dueDate);
		due.setHours(h || 0, m || 0, 0, 0);
		const now = new Date();
		if (due.getTime() < now.getTime()) { return 'overdue'; }
		const tomorrowEnd = new Date();
		tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);
		tomorrowEnd.setHours(23, 59, 59, 999);
		return due.getTime() <= tomorrowEnd.getTime() ? 'soon' : 'later';
	}

	/**
	 * Drag a task row to a new position. The list order IS the user's priority, so
	 * nothing here ever sorts on its own - deadlines are shown, not obeyed.
	 *
	 * Pointer-based rather than HTML5 drag-and-drop: the rows live in a scrolling
	 * container and are re-rendered constantly, and native DnD's ghost image and
	 * drop-target quirks fight both. We track the pointer against each sibling row's
	 * midpoint, show a thin insertion line, and reorder the array on release.
	 */
	private beginTaskDrag(e: MouseEvent, row: HTMLElement, task: OverviewTask): void {
		e.preventDefault();
		const list = row.parentElement;
		if (!list) { return; }
		const doc = row.ownerDocument;
		const rows = Array.from(list.children) as HTMLElement[];
		const startIndex = rows.indexOf(row);

		row.classList.add('aria-task-dragging');
		row.style.opacity = '0.5';

		// A thin line marking where the row would land.
		const marker = doc.createElement('div');
		Object.assign(marker.style, { height: '2px', background: 'var(--vscode-focusBorder, #4a9eff)', margin: '0', pointerEvents: 'none' });

		let targetIndex = startIndex;
		const place = (clientY: number) => {
			// Insert before the first row whose midpoint is below the pointer.
			let idx = rows.length;
			for (let i = 0; i < rows.length; i++) {
				if (rows[i] === row) { continue; }
				const r = rows[i].getBoundingClientRect();
				if (clientY < r.top + r.height / 2) { idx = i; break; }
			}
			targetIndex = idx;
			if (idx >= rows.length) { list.appendChild(marker); }
			else { list.insertBefore(marker, rows[idx]); }
		};
		place(e.clientY);

		const onMove = (ev: MouseEvent) => place(ev.clientY);
		const onUp = () => {
			doc.removeEventListener('mousemove', onMove, true);
			doc.removeEventListener('mouseup', onUp, true);
			marker.remove();
			// Translate the marker position into a destination index within the array.
			// Removing the dragged item first shifts everything after it left by one.
			let dest = targetIndex;
			if (dest > startIndex) { dest--; }
			if (dest !== startIndex && dest >= 0 && dest <= this.data.tasks.length - 1) {
				const from = this.data.tasks.indexOf(task);
				if (from >= 0) {
					this.data.tasks.splice(from, 1);
					this.data.tasks.splice(dest, 0, task);
					void this.persist();
				}
			}
			this.renderSections();
		};
		doc.addEventListener('mousemove', onMove, true);
		doc.addEventListener('mouseup', onUp, true);
	}

	private taskRow(task: OverviewTask): HTMLElement {
		const row = $('div');
		Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0' });

		// Drag handle, LEFT of the checkbox. A single up/down grip (↕): grab it and
		// drag the row to a new spot. Always visible on the first row so the feature
		// is discoverable; hidden until hover elsewhere, since a grip on every row is
		// noise. Space is reserved either way (visibility, not display) so rows do
		// not shift on hover.
		const index = this.data.tasks.indexOf(task);
		const isFirst = index === 0;
		const handle = append(row, $('span')) as HTMLElement;
		handle.textContent = '↕'; // ↕
		handle.title = 'Drag to reorder';
		Object.assign(handle.style, {
			flexShrink: '0', cursor: 'grab', opacity: '0.5', padding: '0 2px',
			fontSize: '13px', userSelect: 'none', fontFamily: 'var(--vscode-font-family)',
			visibility: isFirst ? 'visible' : 'hidden',
		});
		row.dataset.taskId = task.id;
		handle.addEventListener('mousedown', (e) => this.beginTaskDrag(e, row, task));
		if (!isFirst) {
			row.addEventListener('mouseenter', () => { if (!row.classList.contains('aria-task-dragging')) { handle.style.visibility = 'visible'; } });
			row.addEventListener('mouseleave', () => { if (!row.classList.contains('aria-task-dragging')) { handle.style.visibility = 'hidden'; } });
		}

		const cb = append(row, $('input')) as HTMLInputElement;
		cb.type = 'checkbox';
		cb.checked = task.done;
		cb.style.cursor = 'pointer';
		cb.onchange = () => {
			task.done = cb.checked;
			task.checkedAt = cb.checked ? new Date().toISOString() : undefined;
			this.data.pendingCompletions = this.data.pendingCompletions.filter(p => p.taskId !== task.id);
			void this.persist();
			this.renderSections();
		};
		const label = append(row, $('span'));
		label.textContent = task.label;
		Object.assign(label.style, { flex: '1', minWidth: '0', fontSize: '13px', textDecoration: task.done ? 'line-through' : 'none', opacity: task.done ? '0.55' : '1' });

		// Deadline chip: a calendar glyph until a date is set, then the date itself.
		// Always visible (unlike the row's hover icons) - a deadline is information,
		// not an action, and hiding it would defeat the point.
		const due = append(row, $('span')) as HTMLElement;
		const urgency = AriaProjectOverviewEditorPane.urgency(task);
		const colour = urgency === 'overdue'
			? 'var(--vscode-errorForeground, #f14c4c)'
			: urgency === 'soon' ? 'var(--vscode-editorWarning-foreground, #cca700)' : 'var(--vscode-foreground)';
		if (task.dueDate) {
			due.textContent = AriaProjectOverviewEditorPane.formatDeadline(task);
			Object.assign(due.style, { fontSize: '11px', color: colour, opacity: urgency === 'later' ? '0.6' : '1', fontFamily: 'var(--vscode-font-family)' });
		} else {
			due.className = 'codicon codicon-calendar';
			Object.assign(due.style, { fontSize: '13px', opacity: '0.45' });
		}
		Object.assign(due.style, { cursor: 'pointer', flexShrink: '0', padding: '2px', whiteSpace: 'nowrap' });
		due.title = task.dueDate ? AriaProjectOverviewEditorPane.formatDeadline(task) : 'Set a deadline';
		due.onclick = (e) => { e.stopPropagation(); this.openDeadlinePicker(due, task); };

		// Pencil = inline-rename this task (same edit glyph the research notes use).
		const edit = append(row, $('span.codicon.codicon-edit')) as HTMLElement;
		edit.title = 'Edit task';
		Object.assign(edit.style, { cursor: 'pointer', opacity: '0.5', flexShrink: '0', padding: '2px' });
		edit.onclick = () => this.beginEditTask(row, label, task);

		const del = append(row, $('span.codicon.codicon-trash')) as HTMLElement;
		del.title = 'Delete task';
		Object.assign(del.style, { cursor: 'pointer', opacity: '0.5', flexShrink: '0', padding: '2px' });
		del.onclick = () => {
			this.data.tasks = this.data.tasks.filter(t => t.id !== task.id);
			this.data.pendingCompletions = this.data.pendingCompletions.filter(p => p.taskId !== task.id);
			void this.persist();
			this.renderSections();
		};
		return row;
	}

	/**
	 * Month-grid date picker for a task's deadline.
	 *
	 * Hand-rolled because the workbench has no date widget. Deliberately explicit:
	 * the user picks dates, optionally ticks a time, then presses Save - nothing is
	 * written until then, so a stray click on the grid costs nothing. Clear removes
	 * the deadline entirely, which Save/Cancel alone could not express.
	 */
	private openDeadlinePicker(anchorEl: HTMLElement, task: OverviewTask): void {
		const doc = anchorEl.ownerDocument;
		const pop = doc.createElement('div');
		Object.assign(pop.style, {
			position: 'fixed', zIndex: '1000', minWidth: '250px',
			background: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))',
			border: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.35))',
			borderRadius: '6px', padding: '10px', boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
			fontSize: '12px', color: 'var(--vscode-foreground)',
			// Match the workbench UI font. The popup attaches inside the pane (below)
			// so it inherits the same --vscode-font-family the rest of Qoka resolves;
			// the explicit value with a fallback guards the case where it does not.
			fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
		});

		// Draggable title bar. The popup can cover a row the user wants to see, so
		// let them grab this and move it out of the way.
		const bar = append(pop, $('div'));
		bar.textContent = 'Deadline';
		Object.assign(bar.style, {
			cursor: 'move', userSelect: 'none', fontSize: '11px', fontWeight: '600',
			opacity: '0.7', margin: '-2px 0 8px 0', paddingBottom: '6px',
			borderBottom: '1px solid rgba(127,127,127,0.2)',
		});
		bar.addEventListener('mousedown', (e) => {
			e.preventDefault();
			const r = pop.getBoundingClientRect();
			const dx = e.clientX - r.left;
			const dy = e.clientY - r.top;
			const onMove = (ev: MouseEvent) => {
				pop.style.left = `${Math.max(8, Math.min(ev.clientX - dx, doc.documentElement.clientWidth - pop.offsetWidth - 8))}px`;
				pop.style.top = `${Math.max(8, Math.min(ev.clientY - dy, doc.documentElement.clientHeight - pop.offsetHeight - 8))}px`;
			};
			const onUp = () => { doc.removeEventListener('mousemove', onMove, true); doc.removeEventListener('mouseup', onUp, true); };
			doc.addEventListener('mousemove', onMove, true);
			doc.addEventListener('mouseup', onUp, true);
		});

		// Working copy - only written back on Save.
		let from: string | undefined = task.startDate ?? task.dueDate;
		let to: string | undefined = task.dueDate;
		let tStart = task.startTime ?? '';
		let tDue = task.dueTime ?? '';
		const today = new Date();
		let year = (from ? AriaProjectOverviewEditorPane.parseKey(from) : today).getFullYear();
		let month = (from ? AriaProjectOverviewEditorPane.parseKey(from) : today).getMonth();

		// --- year / month selectors ---
		const head = append(pop, $('div'));
		Object.assign(head.style, { display: 'flex', gap: '6px', marginBottom: '8px' });
		const selectStyle = { flex: '1', minWidth: '0', padding: '3px', fontSize: '12px', fontFamily: 'inherit', background: 'var(--vscode-dropdown-background, transparent)', color: 'var(--vscode-foreground)', border: '1px solid rgba(127,127,127,0.3)', borderRadius: '4px' };
		const yearSel = append(head, $('select')) as HTMLSelectElement;
		Object.assign(yearSel.style, selectStyle);
		for (let y = today.getFullYear() - 2; y <= today.getFullYear() + 5; y++) {
			const o = append(yearSel, $('option')) as HTMLOptionElement;
			o.value = String(y); o.textContent = String(y);
		}
		const monthSel = append(head, $('select')) as HTMLSelectElement;
		Object.assign(monthSel.style, selectStyle);
		for (let m = 0; m < 12; m++) {
			const o = append(monthSel, $('option')) as HTMLOptionElement;
			o.value = String(m);
			o.textContent = new Date(2020, m, 1).toLocaleDateString(undefined, { month: 'long' });
		}

		const grid = append(pop, $('div'));

		const hint = append(pop, $('div'));
		hint.textContent = 'Pick two dates for a period, or one date for a single deadline.';
		Object.assign(hint.style, { fontSize: '11px', opacity: '0.7', margin: '8px 0', lineHeight: '1.4' });

		// --- optional time ---
		const timeToggleRow = append(pop, $('label'));
		Object.assign(timeToggleRow.style, { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', margin: '2px 0' });
		const timeToggle = append(timeToggleRow, $('input')) as HTMLInputElement;
		timeToggle.type = 'checkbox';
		timeToggle.checked = !!(task.startTime || task.dueTime);
		const timeToggleLabel = append(timeToggleRow, $('span'));
		timeToggleLabel.textContent = 'Set a time';

		const timeBox = append(pop, $('div'));
		Object.assign(timeBox.style, { display: timeToggle.checked ? 'block' : 'none', margin: '6px 0 2px 20px' });
		const timeField = (label: string, value: string, onInput: (v: string) => void) => {
			const line = append(timeBox, $('div'));
			Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '6px', margin: '3px 0' });
			const l = append(line, $('span'));
			l.textContent = label;
			// Wide enough for a `Jul 3` date label, not just `Start`.
			Object.assign(l.style, { minWidth: '52px', opacity: '0.75', whiteSpace: 'nowrap' });
			const inp = append(line, $('input')) as HTMLInputElement;
			inp.value = value;
			inp.placeholder = '18:30';
			Object.assign(inp.style, { width: '64px', padding: '2px 5px', fontSize: '12px', fontFamily: 'inherit', background: 'var(--vscode-input-background, transparent)', color: 'var(--vscode-foreground)', border: '1px solid rgba(127,127,127,0.3)', borderRadius: '4px' });
			inp.oninput = () => onInput(inp.value);
		};
		const dateLabel = (key: string) => {
			const d = AriaProjectOverviewEditorPane.parseKey(key);
			return `${d.toLocaleDateString(undefined, { month: 'short' })} ${d.getDate()}`;
		};
		// One time for a single date, two for a range - rebuilt when the selection
		// switches between the two. Each row is labelled with ITS date (the user
		// picks dates first, so `Jul 1 [ ]` / `Jul 3 [ ]` reads naturally). Typed
		// values survive the rebuild via tStart/tDue.
		const renderTimeFields = () => {
			clearNode(timeBox);
			const isRange = !!from && !!to && from !== to;
			if (isRange) {
				timeField(dateLabel(from!), tStart, v => { tStart = v; });
				timeField(dateLabel(to!), tDue, v => { tDue = v; });
			} else if (to) {
				timeField(dateLabel(to), tDue, v => { tDue = v; });
			} else {
				timeField('Time', tDue, v => { tDue = v; });
			}
		};
		renderTimeFields();
		timeToggle.onchange = () => { timeBox.style.display = timeToggle.checked ? 'block' : 'none'; };

		// --- buttons ---
		const buttons = append(pop, $('div'));
		Object.assign(buttons.style, { display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '10px' });

		const close = () => {
			doc.removeEventListener('mousedown', onOutside, true);
			doc.removeEventListener('keydown', onKey, true);
			pop.remove();
		};
		const onOutside = (e: MouseEvent) => { if (!pop.contains(e.target as Node)) { close(); } };
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); } };

		/** 'HH:mm' or undefined. Anything unparseable is treated as "no time" rather
		 *  than silently storing a bad value. */
		const readTime = (raw: string): string | undefined => {
			const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
			if (!m) { return undefined; }
			const h = parseInt(m[1], 10);
			const min = parseInt(m[2], 10);
			if (h > 23 || min > 59) { return undefined; }
			return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
		};

		buttons.appendChild(this.smallButton('Clear', false, () => {
			task.startDate = undefined; task.dueDate = undefined;
			task.startTime = undefined; task.dueTime = undefined;
			close();
			void this.persist();
			this.renderSections();
		}));
		buttons.appendChild(this.smallButton('Cancel', false, close));
		buttons.appendChild(this.smallButton('Save', true, () => {
			if (!to) {
				task.startDate = undefined; task.dueDate = undefined;
				task.startTime = undefined; task.dueTime = undefined;
			} else {
				const isRange = !!from && from !== to;
				task.startDate = isRange ? from : undefined;
				task.dueDate = to;
				task.startTime = timeToggle.checked && isRange ? readTime(tStart) : undefined;
				task.dueTime = timeToggle.checked ? readTime(tDue) : undefined;
			}
			close();
			void this.persist();
			this.renderSections();
		}));

		const renderGrid = () => {
			clearNode(grid);
			yearSel.value = String(year);
			monthSel.value = String(month);
			const table = append(grid, $('div'));
			Object.assign(table.style, { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '1px', textAlign: 'center' });
			for (const d of ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']) {
				const h = append(table, $('div'));
				h.textContent = d;
				Object.assign(h.style, { fontSize: '10px', opacity: '0.55', padding: '2px 0' });
			}
			const first = new Date(year, month, 1);
			const days = new Date(year, month + 1, 0).getDate();
			for (let i = 0; i < first.getDay(); i++) { append(table, $('div')); }
			const todayKey = AriaProjectOverviewEditorPane.todayKey();
			for (let d = 1; d <= days; d++) {
				const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
				const cell = append(table, $('div'));
				cell.textContent = String(d);
				const inRange = !!from && !!to && key >= from && key <= to;
				const isEdge = key === from || key === to;
				Object.assign(cell.style, {
					padding: '3px 0', borderRadius: '3px', cursor: 'pointer', fontSize: '12px',
					outline: key === todayKey ? '1px solid var(--vscode-focusBorder, #4a9eff)' : 'none',
					background: isEdge
						? 'var(--vscode-button-background, #0e639c)'
						: inRange ? 'rgba(120,170,255,0.18)' : 'transparent',
					color: isEdge ? 'var(--vscode-button-foreground, #fff)' : 'inherit',
				});
				cell.onclick = () => {
					// First click starts a new selection; a second click completes a
					// range. Clicking again after that starts over, so a mis-click is
					// always one click from being corrected.
					if (!from || (from && to && from !== to) || key < from) {
						from = key; to = key;
					} else {
						to = key;
					}
					renderGrid();
					renderTimeFields(); // single vs range may have changed
				};
			}
		};
		yearSel.onchange = () => { year = parseInt(yearSel.value, 10); renderGrid(); };
		monthSel.onchange = () => { month = parseInt(monthSel.value, 10); renderGrid(); };
		renderGrid();

		// Append first (so we can measure it), THEN place it fully on screen. Below
		// the chip by default; flipped above when it would run off the bottom - the
		// old fixed `rect.bottom + 4` cut off the lower rows' popups.
		// Attach inside the pane container, not document.body, so CSS custom
		// properties (and thus the font) resolve exactly as they do for every other
		// element here. position:fixed still positions it against the viewport, so
		// nothing else about the placement changes.
		(this.container ?? doc.body).appendChild(pop);
		const rect = anchorEl.getBoundingClientRect();
		const vw = doc.documentElement.clientWidth;
		const vh = doc.documentElement.clientHeight;
		const h = pop.offsetHeight;
		const w = pop.offsetWidth;
		const below = rect.bottom + 4;
		const top = (below + h <= vh - 8) ? below : Math.max(8, rect.top - h - 4);
		pop.style.left = `${Math.max(8, Math.min(rect.left, vw - w - 8))}px`;
		pop.style.top = `${Math.max(8, Math.min(top, vh - h - 8))}px`;

		setTimeout(() => {
			doc.addEventListener('mousedown', onOutside, true);
			doc.addEventListener('keydown', onKey, true);
		}, 0);
	}

	/** Swap a task's label for an inline text input; commit on Enter/blur, cancel on Escape. */
	private beginEditTask(row: HTMLElement, label: HTMLElement, task: OverviewTask): void {
		const input = document.createElement('input');
		input.value = task.label;
		Object.assign(input.style, { flex: '1', minWidth: '0', boxSizing: 'border-box', padding: '3px 6px', borderRadius: '4px', border: '1px solid rgba(127,127,127,0.4)', background: 'var(--vscode-input-background, transparent)', color: 'var(--vscode-foreground)', fontSize: '13px', fontFamily: 'inherit' });
		row.replaceChild(input, label);
		input.focus();
		input.select();
		let done = false;
		const commit = () => {
			if (done) { return; }
			done = true;
			const next = input.value.trim();
			if (next && next !== task.label) {
				task.label = next;
				void this.persist();
			}
			this.renderSections();
		};
		input.onkeydown = (e) => {
			if (e.key === 'Enter') { commit(); }
			else if (e.key === 'Escape') { done = true; this.renderSections(); }
		};
		input.onblur = () => commit();
	}

	private async acceptCompletion(taskId: string): Promise<void> {
		const task = this.data.tasks.find(t => t.id === taskId);
		if (task) { task.done = true; task.checkedAt = new Date().toISOString(); }
		this.data.pendingCompletions = this.data.pendingCompletions.filter(p => p.taskId !== taskId);
		await this.persist();
		this.renderSections();
	}

	private async rejectCompletion(taskId: string): Promise<void> {
		this.data.pendingCompletions = this.data.pendingCompletions.filter(p => p.taskId !== taskId);
		await this.persist();
		this.renderSections();
	}

	private smallButton(text: string, primary: boolean, onClick: () => void): HTMLElement {
		const b = $('button');
		b.textContent = text;
		Object.assign(b.style, { padding: '4px 10px', fontSize: '12px', fontFamily: 'inherit', borderRadius: '5px', cursor: 'pointer', flexShrink: '0', border: primary ? 'none' : '1px solid rgba(127,127,127,0.4)', background: primary ? 'var(--vscode-button-background)' : 'transparent', color: primary ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)' });
		b.onclick = onClick;
		return b;
	}

	override clearInput(): void {
		this.saveScheduler.cancel();
		this.watcherStore.clear();
		this.folderResource = undefined;
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this.contentTextarea?.focus();
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}
}
