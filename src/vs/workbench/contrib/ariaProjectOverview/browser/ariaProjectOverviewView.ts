/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, $, clearNode, getWindow } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { FileAccess } from '../../../../base/common/network.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWebviewElement, IWebviewService } from '../../webview/browser/webview.js';
import { asWebviewUri, webviewGenericCspSource } from '../../webview/common/webview.js';
import { revealAiProviderChat } from '../../aria/browser/aiProviderChat.js';

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
	/** BlockNote blocks for the Notion-style Content editor. */
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

// Reuse the BlockNote editor bundle that aria-notes ships (media/notesEditor.js).
const MEDIA_ROOT = FileAccess.asFileUri('vs/workbench/contrib/ariaNotes/browser/media');

function emptyOverview(): OverviewData {
	return { version: SCHEMA_VERSION, title: '', content: [], tasks: [], pendingCompletions: [] };
}

/**
 * Project Overview view. Top: an editable Title + a Notion-style Content editor
 * (BlockNote, hosted in a webview reusing the aria-notes bundle). Below, two
 * FIXED sections: the Roadmap (static picture) and the To-do checklist (with any
 * AI-proposed completions to Accept / Reject). Reads/writes
 * <workspace>/.aria/overview.json; a watcher refreshes on external (MCP) changes.
 */
export class AriaProjectOverviewView extends ViewPane {

	static readonly ID = 'aria.projectOverview.main';

	private data: OverviewData = emptyOverview();
	private roadmapNodes: RoadmapNode[] = [];

	private titleInput: HTMLInputElement | undefined;
	private startCardEl: HTMLElement | undefined;
	private sectionsEl: HTMLElement | undefined;
	private webviewHost: HTMLElement | undefined;
	private webview: IWebviewElement | undefined;
	private readonly webviewStore = this._register(new DisposableStore());
	private webviewReady = false;
	/** JSON of the content we last pushed to / received from the webview, so an
	 *  external reload doesn't clobber the user's live edit (echo suppression). */
	private lastContentJson = '[]';
	private readonly saveScheduler = this._register(new RunOnceScheduler(() => void this.persist(), 500));

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWebviewService private readonly webviewService: IWebviewService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) { void this.reload(); }
		}));
		void this.setupWatcher();
	}

	// --- storage -----------------------------------------------------------

	private folderUri(): URI | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		return folder && folder.uri.scheme === 'file' ? folder.uri : undefined;
	}

	private overviewUri(): URI | undefined {
		const f = this.folderUri();
		return f ? URI.joinPath(f, '.aria', 'overview.json') : undefined;
	}

	private async setupWatcher(): Promise<void> {
		try {
			const f = this.folderUri();
			if (!f) { return; }
			const dirUri = URI.joinPath(f, '.aria');
			const overview = URI.joinPath(dirUri, 'overview.json');
			const roadmap = URI.joinPath(dirUri, 'roadmap.json');
			this._register(this.fileService.watch(dirUri));
			this._register(this.fileService.onDidFilesChange(e => {
				if (e.contains(overview) || e.contains(roadmap)) { void this.reload(); }
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

	private async readRoadmap(): Promise<RoadmapNode[]> {
		const f = this.folderUri();
		if (!f) { return []; }
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
			await this.fileService.createFolder(URI.joinPath(this.folderUri()!, '.aria')).catch(() => { /* exists */ });
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(this.data, null, 2) + '\n'));
		} catch { /* best-effort */ }
	}

	// --- layout ------------------------------------------------------------

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('div'));
		Object.assign(root.style, {
			display: 'flex', flexDirection: 'column', height: '100%',
			color: 'var(--vscode-foreground)', fontSize: '12px', boxSizing: 'border-box', overflow: 'hidden',
		});

		if (!this.folderUri()) {
			const p = append(root, $('p'));
			p.textContent = 'Open a project to see its overview.';
			Object.assign(p.style, { opacity: '0.6', padding: '12px' });
			return;
		}

		// First-run guidance: tell the user to introduce the project in the AI chat.
		// Shown only while the project has no title/content yet (toggled in applyData).
		const card = append(root, $('div'));
		Object.assign(card.style, {
			flex: '0 0 auto', display: 'none', flexDirection: 'column', gap: '8px',
			border: '1px solid var(--vscode-focusBorder, rgba(120,170,255,0.5))', borderRadius: '8px',
			background: 'rgba(120,170,255,0.08)', padding: '12px 14px', margin: '12px 14px 0 14px',
		});
		const cardText = append(card, $('div'));
		cardText.textContent = '이 프로젝트의 이름이랑 어떤 프로젝트가 될 것인지를 AI 채팅에 입력해주세요.';
		Object.assign(cardText.style, { fontSize: '13px', lineHeight: '1.5' });
		const openChat = this.smallButton('AI 채팅 열기', true, () => {
			void revealAiProviderChat(this.commandService, this.configurationService);
		});
		openChat.style.alignSelf = 'flex-start';
		card.appendChild(openChat);
		this.startCardEl = card;

		// Title (Notion-style large input).
		const title = append(root, $('input')) as HTMLInputElement;
		title.placeholder = 'Untitled project';
		Object.assign(title.style, {
			flex: '0 0 auto', width: '100%', boxSizing: 'border-box', border: 'none', outline: 'none',
			background: 'transparent', color: 'var(--vscode-foreground)', fontSize: '22px', fontWeight: '700',
			padding: '12px 14px 6px 14px',
		});
		title.onchange = () => { this.data.title = title.value; this.saveScheduler.schedule(); };
		this.titleInput = title;

		// Content (BlockNote webview) - the flexible middle region.
		const host = append(root, $('div'));
		Object.assign(host.style, { flex: '1 1 auto', minHeight: '120px', position: 'relative' });
		this.webviewHost = host;
		this.mountWebview();

		// Fixed sections below: Roadmap + To-do (own scroll so the webview above
		// keeps a stable position - webviews don't scroll inside a scrolling parent).
		const sections = append(root, $('div'));
		Object.assign(sections.style, {
			flex: '0 0 auto', maxHeight: '55%', overflowY: 'auto', overflowX: 'hidden',
			borderTop: '1px solid rgba(127,127,127,0.25)', padding: '4px 14px 12px 14px',
		});
		this.sectionsEl = sections;

		void this.reload();
	}

	private mountWebview(): void {
		this.webviewStore.clear();
		this.webview = undefined;
		this.webviewReady = false;
		if (!this.webviewHost) { return; }
		const webview = this.webviewStore.add(this.webviewService.createWebviewElement({
			title: undefined,
			options: {},
			contentOptions: { allowScripts: true, localResourceRoots: [MEDIA_ROOT] },
			extension: undefined,
		}));
		this.webview = webview;
		webview.mountTo(this.webviewHost, getWindow(this.webviewHost));
		webview.setHtml(this.html());
		this.webviewStore.add(webview.onMessage(e => this.onWebviewMessage(e.message)));
	}

	private onWebviewMessage(message: unknown): void {
		const msg = message as { type?: string; blocks?: unknown[] } | undefined;
		if (!msg) { return; }
		if (msg.type === 'ready') {
			this.webviewReady = true;
			void this.webview?.postMessage({ type: 'load', blocks: this.data.content, editable: true });
			this.lastContentJson = JSON.stringify(this.data.content);
		} else if (msg.type === 'save' && Array.isArray(msg.blocks)) {
			this.data.content = msg.blocks;
			this.lastContentJson = JSON.stringify(msg.blocks);
			this.saveScheduler.schedule();
		}
	}

	/** Push freshly-loaded data into the persistent UI without rebuilding the
	 *  webview (which would flicker / lose focus). */
	private applyData(): void {
		if (this.titleInput && document.activeElement !== this.titleInput) {
			this.titleInput.value = this.data.title;
		}
		// Show the "introduce your project" guidance only while it's still empty.
		if (this.startCardEl) {
			const empty = !this.data.title.trim() && this.data.content.length === 0;
			this.startCardEl.style.display = empty ? 'flex' : 'none';
		}
		// Only push content to the webview if it changed externally (not our echo).
		const incoming = JSON.stringify(this.data.content);
		if (this.webviewReady && incoming !== this.lastContentJson) {
			void this.webview?.postMessage({ type: 'load', blocks: this.data.content, editable: true });
			this.lastContentJson = incoming;
		}
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
		box.onclick = () => { void this.commandService.executeCommand('workbench.view.ariaRoadmap.focus'); };

		if (this.roadmapNodes.length === 0) {
			const empty = append(box, $('div'));
			empty.textContent = 'No roadmap yet. Build one in the Roadmap tab.';
			Object.assign(empty.style, { opacity: '0.6', padding: '6px' });
			return;
		}
		const maxCol = this.roadmapNodes.reduce((m, n) => Math.max(m, n.column), 0);
		const row = append(box, $('div'));
		Object.assign(row.style, { display: 'flex', gap: '10px', alignItems: 'flex-start' });
		for (let c = 0; c <= maxCol; c++) {
			const col = append(row, $('div'));
			Object.assign(col.style, { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '120px' });
			for (const n of this.roadmapNodes.filter(nn => nn.column === c)) {
				const card = append(col, $('div'));
				card.textContent = n.label;
				Object.assign(card.style, { border: '1px solid rgba(127,127,127,0.35)', borderRadius: '5px', padding: '5px 8px', fontSize: '11.5px', background: 'rgba(127,127,127,0.06)' });
			}
		}
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
		Object.assign(label.style, { flex: '1', minWidth: '0', fontSize: '12.5px', textDecoration: task.done ? 'line-through' : 'none', opacity: task.done ? '0.55' : '1' });
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

	private html(): string {
		const csp = webviewGenericCspSource;
		const jsUri = asWebviewUri(URI.joinPath(MEDIA_ROOT, 'notesEditor.js')).toString(true);
		const cssUri = asWebviewUri(URI.joinPath(MEDIA_ROOT, 'notesEditor.css')).toString(true);
		return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} https: data: blob:; media-src ${csp} https: blob: data:; font-src ${csp} data:; style-src ${csp} 'unsafe-inline'; style-src-elem ${csp} 'unsafe-inline'; script-src ${csp} 'unsafe-eval'; script-src-elem ${csp};">
<link rel="stylesheet" href="${cssUri}">
<style>html,body,#root{height:100%;margin:0;padding:0;background:var(--vscode-editor-background);}</style>
</head>
<body>
<div id="root"></div>
<script src="${jsUri}"></script>
</body>
</html>`;
	}
}
