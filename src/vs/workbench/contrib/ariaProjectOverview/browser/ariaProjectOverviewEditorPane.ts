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
import { AriaProjectOverviewEditorInput } from './ariaProjectOverviewEditorInput.js';
import { computeRoadmapLayout, layoutBounds, COLUMN_WIDTH, NODE_LINE_HEIGHT, NODE_LABEL_PAD_X } from '../../ariaRoadmapWizard/browser/roadmapCanvasLayout.js';

interface OverviewTask {
	id: string;
	label: string;
	done: boolean;
	checkedAt?: string;
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
	private folderResource: URI | undefined;

	private container: HTMLElement | undefined;
	private titleInput: HTMLInputElement | undefined;
	private contentTextarea: HTMLTextAreaElement | undefined;
	private startCardEl: HTMLElement | undefined;
	private sectionsEl: HTMLElement | undefined;
	private readonly watcherStore = this._register(new DisposableStore());
	private lastSelfWriteAt = 0;
	private readonly saveScheduler = this._register(new RunOnceScheduler(() => void this.persist(), 500));

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
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
		const card = append(root, $('div'));
		Object.assign(card.style, {
			flex: '0 0 auto', display: 'none', flexDirection: 'column', gap: '6px',
			border: '1px solid var(--vscode-focusBorder, rgba(120,170,255,0.5))', borderRadius: '8px',
			background: 'rgba(120,170,255,0.08)', padding: '12px 16px', margin: '14px 20px 0 20px', maxWidth: '760px',
		});
		const cardText = append(card, $('div'));
		cardText.textContent = 'Enter this project\'s name and what it will be, in the AI chat.';
		Object.assign(cardText.style, { fontSize: '13px', lineHeight: '1.5' });
		this.startCardEl = card;

		// Title (Notion-style large input).
		const title = append(root, $('input')) as HTMLInputElement;
		title.placeholder = 'Untitled project';
		Object.assign(title.style, {
			flex: '0 0 auto', width: '100%', maxWidth: '760px', boxSizing: 'border-box', border: 'none', outline: 'none',
			background: 'transparent', color: 'var(--vscode-foreground)', fontSize: '28px', fontWeight: '700',
			padding: '16px 20px 8px 20px', fontFamily: 'inherit',
		});
		title.onchange = () => { this.data.title = title.value; this.updateStartCard(); this.saveScheduler.schedule(); };
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
		return f ? URI.joinPath(f, '.aria', 'overview.json') : undefined;
	}

	private setupWatcher(): void {
		this.watcherStore.clear();
		try {
			const f = this.folderUri();
			if (!f) { return; }
			const dirUri = URI.joinPath(f, '.aria');
			const overview = URI.joinPath(dirUri, 'overview.json');
			const roadmapsDir = URI.joinPath(dirUri, 'roadmaps');
			this.watcherStore.add(this.fileService.watch(dirUri));
			this.watcherStore.add(this.fileService.watch(roadmapsDir));
			this.watcherStore.add(this.fileService.onDidFilesChange(e => {
				if (Date.now() - this.lastSelfWriteAt < 1000) { return; }
				if (e.contains(overview) || e.affects(roadmapsDir)) { void this.reload(); }
			}));
		} catch { /* best-effort */ }
	}

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
	 * Read the project's active roadmap. Roadmaps live under
	 * `.aria/roadmaps/<id>.json` (one file per hypothesis); we render the most
	 * recently updated one - the roadmap the user is currently building. Falls
	 * back to the legacy single `.aria/roadmap.json` if the folder is empty.
	 */
	private async readRoadmap(): Promise<RoadmapNode[]> {
		const f = this.folderUri();
		if (!f) { return []; }
		const roadmapsDir = URI.joinPath(f, '.aria', 'roadmaps');
		try {
			const dir = await this.fileService.resolve(roadmapsDir);
			let newest: { nodes: RoadmapNode[]; updatedAt: number } | undefined;
			for (const child of dir.children ?? []) {
				if (child.isDirectory || !child.name.endsWith('.json')) { continue; }
				try {
					const raw = (await this.fileService.readFile(child.resource)).value.toString();
					const parsed = JSON.parse(raw) as { nodes?: RoadmapNode[]; updatedAt?: number };
					const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
					const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0;
					if (nodes.length && (!newest || updatedAt >= newest.updatedAt)) {
						newest = { nodes, updatedAt };
					}
				} catch { /* skip unreadable roadmap */ }
			}
			if (newest) { return newest.nodes; }
		} catch { /* no roadmaps dir yet */ }
		// Legacy single-file roadmap.
		try {
			const raw = (await this.fileService.readFile(URI.joinPath(f, '.aria', 'roadmap.json'))).value.toString();
			const parsed = JSON.parse(raw) as { nodes?: RoadmapNode[] };
			return Array.isArray(parsed.nodes) ? parsed.nodes : [];
		} catch {
			return [];
		}
	}

	private async persist(): Promise<void> {
		const uri = this.overviewUri();
		if (!uri) { return; }
		try {
			this.lastSelfWriteAt = Date.now();
			await this.fileService.createFolder(URI.joinPath(this.folderUri()!, '.aria')).catch(() => { /* exists */ });
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(this.data, null, 2) + '\n'));
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

	/** Push freshly-loaded data into the UI. We skip fields the user is actively
	 *  editing so an external (MCP) refresh never clobbers a live edit. */
	private applyData(): void {
		if (this.titleInput && document.activeElement !== this.titleInput) {
			this.titleInput.value = this.data.title;
		}
		if (this.contentTextarea && document.activeElement !== this.contentTextarea) {
			this.contentTextarea.value = blocksToMarkdown(this.data.content);
		}
		this.updateStartCard();
		this.renderSections();
	}

	// --- fixed sections (roadmap + to-do) ----------------------------------

	private renderSections(): void {
		if (!this.sectionsEl) { return; }
		clearNode(this.sectionsEl);
		this.renderRoadmap(this.sectionsEl);
		this.renderTasks(this.sectionsEl);
	}

	private sectionLabel(parent: HTMLElement, text: string): void {
		const l = append(parent, $('div'));
		l.textContent = text;
		Object.assign(l.style, { fontSize: '11px', fontWeight: '600', opacity: '0.6', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '14px 0 6px 0' });
	}

	private renderRoadmap(parent: HTMLElement): void {
		this.sectionLabel(parent, 'Roadmap');
		const box = append(parent, $('div'));
		Object.assign(box.style, { border: '1px solid rgba(127,127,127,0.25)', borderRadius: '6px', padding: '8px', cursor: 'pointer', overflowX: 'auto' });
		box.title = 'Open the full Roadmap';
		// Clicking opens the Roadmap tab + the active roadmap in the editor. NB: the
		// registered command is the container id verbatim (`workbench.view.ariaRoadmap`)
		// - the `.focus` suffix is never registered, so calling it throws.
		box.onclick = () => {
			void (async () => {
				try { await this.commandService.executeCommand('workbench.view.ariaRoadmap'); } catch { /* sidebar optional */ }
				try { await this.commandService.executeCommand('aria.roadmap.openWizard'); } catch { /* editor optional */ }
			})();
		};

		if (this.roadmapNodes.length === 0) {
			const empty = append(box, $('div'));
			empty.textContent = 'No roadmap yet. Build one in the Roadmap tab.';
			Object.assign(empty.style, { opacity: '0.6', padding: '6px' });
			return;
		}
		this.drawRoadmapGraph(box, this.roadmapNodes);
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
		Object.assign(list.style, { display: 'flex', flexDirection: 'column', gap: '2px', maxWidth: '760px' });
		for (const task of this.data.tasks) { list.appendChild(this.taskRow(task)); }

		const addRow = append(parent, $('div'));
		Object.assign(addRow.style, { display: 'flex', gap: '6px', marginTop: '8px', maxWidth: '760px' });
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

	private taskRow(task: OverviewTask): HTMLElement {
		const row = $('div');
		Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0' });
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
