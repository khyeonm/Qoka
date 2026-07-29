/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { applyAriaScrollbar } from '../../aria/browser/ariaScrollbar.js';
import { NotebookModel, NotebookPage, PageKind, OVERVIEW_PAGE_ID } from './ariaNotebookModel.js';
import { NotebookHistorySection } from './ariaNotebookHistoryView.js';

/** How often changed pages are auto-snapshotted. Snapshots are otherwise taken only
 *  when the user clicks History's "Save", so a version marks a meaningful checkpoint
 *  rather than every keystroke. */
const AUTO_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

const KIND_ICON: Record<PageKind, string> = {
	overview: 'codicon-book',
	roadmap: 'codicon-map',
	note: 'codicon-note',
	folder: 'codicon-folder',
};

/** Background of the page whose editor is currently focused, so the tree shows
 *  which page you are looking at (mirrors the editor selection). */
const ACTIVE_ROW_BG = 'var(--vscode-list-inactiveSelectionBackground, rgba(90,120,180,0.22))';

/** Map the active editor's resource back to a Notebook page id, so the tree can
 *  highlight it. Each page kind opens an editor with a distinctive URI scheme. */
function pageIdForResource(resource: URI | undefined): string | undefined {
	if (!resource) { return undefined; }
	switch (resource.scheme) {
		case 'aria-overview': return OVERVIEW_PAGE_ID;
		case 'aria-roadmap': return resource.path.split('/').pop() || undefined;
		case 'aria-note': return (resource.path.split('/').pop() || '').replace(/\.json$/, '') || undefined;
		default: return undefined;
	}
}

/**
 * The Notebook sidebar: one tree of pages for the whole project. The Overview is
 * the fixed root; Roadmaps and Notes hang beneath it. Clicking a page opens its
 * existing editor (overview pane, roadmap canvas, or the note's markdown file);
 * "+" adds a Note, Roadmap or Overview-child. Re-reads on any change under the
 * notebook / roadmaps dirs so external (MCP) edits show up.
 */
export class AriaNotebookView extends ViewPane {

	static readonly ID = 'workbench.view.aria.notebook.tree';

	private viewBody: HTMLElement | undefined;
	/** Scroll region holding the page tree (above the History section). */
	private treeScroll: HTMLElement | undefined;
	/** The History section rendered below the tree, inside this same view. */
	private historySection: NotebookHistorySection | undefined;
	private historyWrap: HTMLElement | undefined;
	private historyScroll: HTMLElement | undefined;
	private historySplitter: HTMLElement | undefined;
	private historyChevron: HTMLElement | undefined;
	/** History section: expanded by default, with a user-draggable height. */
	private historyExpanded = true;
	private historyHeight = 220;
	/** Latest tree, kept so drag handlers can reason about ancestry without re-reading. */
	private allPages: NotebookPage[] = [];
	/** Signature of the last rendered tree (structure + labels + collapse state). A
	 *  refresh whose signature matches skips the DOM rebuild, so typing into a note or
	 *  roadmap (which autosaves its file and fires a change) no longer flickers the list. */
	private lastTreeSignature: string | undefined;
	/** Folder page ids that are collapsed (their children hidden). Default expanded. */
	private readonly collapsedFolders = new Set<string>();
	/** Periodic auto-snapshot timer (every AUTO_SNAPSHOT_INTERVAL_MS). */
	private autoSnapshotTimer: ReturnType<typeof setInterval> | undefined;
	/** The page whose editor is currently active, highlighted in the tree. */
	private activePageId: string | undefined;

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
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ICommandService private readonly commandService: ICommandService,
		@IDialogService private readonly dialogService: IDialogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => void this.refresh()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => void this.refresh()));
		// Refresh on any change to the index OR the stores we discover from, so a
		// roadmap/note created by the MCP tools appears without any manual reveal.
		this._register(this.fileService.onDidFilesChange(e => {
			const folder = this.folderUri();
			if (!folder) { return; }
			const roadmapsChanged = e.affects(NotebookModel.roadmapsDir(folder));
			const notesChanged = e.affects(NotebookModel.notesDir(folder));
			if (e.affects(NotebookModel.indexUri(folder)) || roadmapsChanged || notesChanged) {
				void this.refresh();
			}
			// A new snapshot (or a rename) appears in History without a manual reveal.
			if (e.affects(NotebookModel.snapshotsDir(folder)) || e.affects(NotebookModel.indexUri(folder))) {
				void this.historySection?.refresh();
			}
		}));
		// Snapshots are taken on a 10-minute cadence (plus the manual Save button), not
		// on every edit, so History stays a short list of meaningful checkpoints.
		this.autoSnapshotTimer = setInterval(() => void this.snapshotAllNow(), AUTO_SNAPSHOT_INTERVAL_MS);
		this._register({ dispose: () => { if (this.autoSnapshotTimer) { clearInterval(this.autoSnapshotTimer); } } });
		// Highlight the page whose editor is focused, and keep it in sync as the user
		// switches tabs. Restyling rows in place avoids a full re-render (and scroll reset).
		this.activePageId = pageIdForResource(this.editorService.activeEditor?.resource);
		this._register(this.editorService.onDidActiveEditorChange(() => {
			this.activePageId = pageIdForResource(this.editorService.activeEditor?.resource);
			this.updateActiveHighlight();
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		// A vertical stack: the page tree (scrolls, takes the free space) on top, then
		// a draggable splitter, then the collapsible History section at the bottom.
		const root = append(container, $('.aria-notebook-view'));
		Object.assign(root.style, { display: 'flex', flexDirection: 'column', overflow: 'hidden', boxSizing: 'border-box', width: '100%' });
		this.viewBody = root;

		const treeScroll = append(root, $('.aria-notebook-tree-scroll'));
		applyAriaScrollbar(treeScroll);
		Object.assign(treeScroll.style, { flex: '1 1 auto', minHeight: '0', overflow: 'auto', padding: '8px', boxSizing: 'border-box' });
		this.treeScroll = treeScroll;

		this.buildHistorySection(root);

		void this.refresh();
		void this.historySection?.refresh();
	}

	/** The History section: a drag-to-resize splitter, a collapsible header, and the
	 *  list itself. Rendered once; its list is (re)filled by NotebookHistorySection. */
	private buildHistorySection(root: HTMLElement): void {
		const splitter = append(root, $('.aria-notebook-splitter'));
		Object.assign(splitter.style, { height: '5px', flex: '0 0 auto', cursor: 'row-resize', background: 'transparent', borderTop: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.25))' });
		splitter.addEventListener('mouseenter', () => { splitter.style.background = 'var(--vscode-focusBorder, #4a9eff)'; });
		splitter.addEventListener('mouseleave', () => { splitter.style.background = 'transparent'; });
		splitter.addEventListener('mousedown', (e) => this.beginHistoryResize(e));
		this.historySplitter = splitter;

		const wrap = append(root, $('.aria-notebook-history'));
		Object.assign(wrap.style, { flex: '0 0 auto', display: 'flex', flexDirection: 'column', minHeight: '0' });
		this.historyWrap = wrap;

		const header = append(wrap, $('.aria-notebook-history-header'));
		Object.assign(header.style, { display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', cursor: 'pointer', flex: '0 0 auto', userSelect: 'none' });
		header.addEventListener('mouseenter', () => { header.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.12))'; });
		header.addEventListener('mouseleave', () => { header.style.background = 'transparent'; });
		const chevron = append(header, $('span.codicon.codicon-chevron-down')) as HTMLElement;
		Object.assign(chevron.style, { fontSize: '14px', opacity: '0.8' });
		this.historyChevron = chevron;
		const title = append(header, $('span'));
		title.textContent = 'History';
		Object.assign(title.style, { flex: '1', fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.04em', opacity: '0.75' });
		// Manual "Save" - records a version of every changed page right now. (Auto-save
		// otherwise runs every 10 minutes.) stopPropagation so it doesn't toggle the
		// section collapse.
		const save = append(header, $('span.codicon.codicon-save')) as HTMLElement;
		save.title = 'Save a version now';
		Object.assign(save.style, { flexShrink: '0', cursor: 'pointer', padding: '2px', opacity: '0.8' });
		save.onclick = (e) => { e.stopPropagation(); void this.saveHistoryNow(save); };
		header.onclick = () => this.toggleHistory();

		const list = append(wrap, $('.aria-notebook-history-list'));
		applyAriaScrollbar(list);
		Object.assign(list.style, { flex: '1 1 auto', minHeight: '0', overflow: 'auto', padding: '2px 8px 8px' });
		this.historyScroll = list;

		this.historySection = new NotebookHistorySection(list, () => this.model(), this.dialogService, this.commandService);
		this.applyHistoryLayout();
	}

	/** Manual Save: snapshot changed pages now and briefly confirm on the button. */
	private async saveHistoryNow(button: HTMLElement): Promise<void> {
		if (!this.historyExpanded) { this.toggleHistory(); }
		const created = await this.historySection?.saveNow();
		// A quick check-mark flash so the click feels acknowledged.
		button.classList.remove('codicon-save');
		button.classList.add(created ? 'codicon-check' : 'codicon-check-all');
		setTimeout(() => { button.classList.remove('codicon-check', 'codicon-check-all'); button.classList.add('codicon-save'); }, 1200);
	}

	/** Reflect the current expand/height state onto the DOM. */
	private applyHistoryLayout(): void {
		if (this.historyChevron) {
			this.historyChevron.classList.toggle('codicon-chevron-down', this.historyExpanded);
			this.historyChevron.classList.toggle('codicon-chevron-right', !this.historyExpanded);
		}
		if (this.historySplitter) { this.historySplitter.style.display = this.historyExpanded ? '' : 'none'; }
		if (this.historyScroll) { this.historyScroll.style.display = this.historyExpanded ? '' : 'none'; }
		if (this.historyWrap) { this.historyWrap.style.height = this.historyExpanded ? `${this.historyHeight}px` : ''; }
	}

	private toggleHistory(): void {
		this.historyExpanded = !this.historyExpanded;
		this.applyHistoryLayout();
	}

	/** Drag the splitter to resize the History section (taller = drag up). */
	private beginHistoryResize(e: MouseEvent): void {
		if (!this.historyExpanded) { return; }
		e.preventDefault();
		const doc = (this.viewBody ?? document.body).ownerDocument;
		const startY = e.clientY;
		const startHeight = this.historyHeight;
		const totalH = this.viewBody?.clientHeight ?? 600;
		const onMove = (ev: MouseEvent) => {
			const next = startHeight - (ev.clientY - startY);
			this.historyHeight = Math.max(80, Math.min(next, totalH - 120));
			if (this.historyWrap) { this.historyWrap.style.height = `${this.historyHeight}px`; }
		};
		const onUp = () => { doc.removeEventListener('mousemove', onMove, true); doc.removeEventListener('mouseup', onUp, true); };
		doc.addEventListener('mousemove', onMove, true);
		doc.addEventListener('mouseup', onUp, true);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.viewBody) {
			this.viewBody.style.height = `${height}px`;
			this.viewBody.style.width = `${width}px`;
		}
		// Keep History from eating the whole view when it shrinks.
		if (this.historyExpanded && this.historyHeight > height - 120) {
			this.historyHeight = Math.max(80, height - 120);
			this.applyHistoryLayout();
		}
	}

	private folderUri(): URI | undefined {
		return this.workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	private model(): NotebookModel | undefined {
		const folder = this.folderUri();
		return folder ? new NotebookModel(folder, this.fileService) : undefined;
	}

	private async refresh(): Promise<void> {
		const body = this.treeScroll;
		if (!body) { return; }

		const model = this.model();
		if (!model) {
			this.lastTreeSignature = undefined;
			clearNode(body);
			const empty = append(body, $('div'));
			empty.textContent = 'Open a project folder to use the notebook.';
			Object.assign(empty.style, { opacity: '0.7', fontSize: '12px', padding: '6px' });
			return;
		}

		const pages = await model.read();
		this.allPages = pages;   // keep drag handlers current even when the rebuild is skipped

		// Skip the DOM rebuild when nothing that affects the tree changed. A content
		// autosave (typing in a note/roadmap) fires a file change but leaves the tree
		// identical; rebuilding it then would flicker the list.
		const signature = this.treeSignature(pages);
		if (signature === this.lastTreeSignature && body.childElementCount > 0) { return; }
		this.lastTreeSignature = signature;

		clearNode(body);
		// Header row: a one-line hint + the "New page" action.
		const header = append(body, $('div'));
		Object.assign(header.style, { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' });
		const hint = append(header, $('div'));
		hint.textContent = 'Write notes, draw a research roadmap, or fill in the overview.';
		Object.assign(hint.style, { flex: '1', minWidth: '0', fontSize: '11px', opacity: '0.65', lineHeight: '1.35' });
		const add = append(header, $('span.codicon.codicon-add')) as HTMLElement;
		add.title = 'New page';
		Object.assign(add.style, { flexShrink: '0', cursor: 'pointer', padding: '3px', opacity: '0.8' });
		// Nest new pages under the Overview root by default, so the tree grows
		// inside itself rather than sprouting siblings next to the root.
		add.onclick = () => void this.promptNewPage(OVERVIEW_PAGE_ID);

		const tree = append(body, $('div'));
		tree.style.position = 'relative'; // so the drag insertion line can be absolutely placed
		this.renderChildren(tree, pages, null, 0);
	}

	/** A string that changes only when something visible in the tree changes (page
	 *  set, nesting, order, titles, or which folders are collapsed). */
	private treeSignature(pages: NotebookPage[]): string {
		const rows = pages.map(p => `${p.id}${p.kind}${p.parent}${p.order}${p.title}`).sort();
		return rows.join('') + '' + [...this.collapsedFolders].sort().join(',');
	}

	/** Repaint each row's background to reflect the active page, without a full
	 *  re-render (which would reset scroll). Rows being hovered keep their hover
	 *  colour until the pointer leaves. */
	private updateActiveHighlight(): void {
		const body = this.treeScroll;
		if (!body) { return; }
		for (const el of Array.from(body.querySelectorAll('[data-page-id]')) as HTMLElement[]) {
			if (el.classList.contains('aria-nb-dragging') || el.matches(':hover')) { continue; }
			el.style.background = el.dataset.pageId === this.activePageId ? ACTIVE_ROW_BG : 'transparent';
		}
	}

	/** Snapshot every page whose content changed since its last version. Called on the
	 *  10-minute timer; identical content is skipped, so History only grows when there
	 *  is a real change. The History view watches the snapshots dir and refreshes. */
	private async snapshotAllNow(): Promise<void> {
		const model = this.model();
		if (!model) { return; }
		for (const page of await model.read()) {
			await model.snapshotIfChanged(page);
		}
	}

	/** Left inset (px) of a row / the insertion line at a given depth - kept in one
	 *  place so the line lands exactly under where a child row would sit. */
	private static indentPx(depth: number): number {
		return 4 + depth * 14;
	}

	private depthOf(pageId: string): number {
		const byId = new Map(this.allPages.map(p => [p.id, p]));
		let depth = 0;
		let cur = byId.get(pageId)?.parent ?? null;
		while (cur) { depth++; cur = byId.get(cur)?.parent ?? null; }
		return depth;
	}

	/** Render the pages whose parent is `parent`, ordered, recursing into children. */
	private renderChildren(container: HTMLElement, pages: NotebookPage[], parent: string | null, depth: number): void {
		const children = pages.filter(p => p.parent === parent).sort((a, b) => a.order - b.order);
		for (const page of children) {
			this.renderRow(container, page, depth);
			// A collapsed folder hides its whole subtree.
			if (page.kind === 'folder' && this.collapsedFolders.has(page.id)) { continue; }
			this.renderChildren(container, pages, page.id, depth + 1);
		}
	}

	private renderRow(container: HTMLElement, page: NotebookPage, depth: number): void {
		const row = append(container, $('div'));
		row.dataset.pageId = page.id;
		row.dataset.pageKind = page.kind;
		const restBg = () => page.id === this.activePageId ? ACTIVE_ROW_BG : 'transparent';
		Object.assign(row.style, {
			display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 4px',
			paddingLeft: `${AriaNotebookView.indentPx(depth)}px`, borderRadius: '4px', cursor: 'pointer',
			background: restBg(),
		});
		row.addEventListener('mouseenter', () => { if (!row.classList.contains('aria-nb-dragging')) { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.12))'; actions.style.visibility = 'visible'; } });
		row.addEventListener('mouseleave', () => { if (!row.classList.contains('aria-nb-dragging')) { row.style.background = restBg(); actions.style.visibility = 'hidden'; } });

		// Twistie: folders get a chevron (down = open, right = collapsed); other rows
		// get an equal-width spacer so their icons line up with folders at the same depth.
		const collapsed = page.kind === 'folder' && this.collapsedFolders.has(page.id);
		const twistie = append(row, $('span')) as HTMLElement;
		Object.assign(twistie.style, { width: '14px', height: '16px', flexShrink: '0', display: 'inline-flex', justifyContent: 'center', alignItems: 'center', opacity: '0.8' });
		if (page.kind === 'folder') {
			twistie.classList.add('codicon', collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down');
			twistie.style.fontSize = '14px';
		}

		// Folders show an open/closed book-folder to reinforce the collapsed state.
		const iconClass = page.kind === 'folder' ? (collapsed ? 'codicon-folder' : 'codicon-folder-opened') : KIND_ICON[page.kind];
		const icon = append(row, $(`span.codicon.${iconClass}`)) as HTMLElement;
		// Flex-centre the glyph and match the label's line box so the icon sits on the
		// text's vertical centre rather than floating high or low.
		Object.assign(icon.style, { fontSize: '14px', flexShrink: '0', opacity: '0.75', display: 'inline-flex', alignItems: 'center', lineHeight: '16px', height: '16px' });

		const label = append(row, $('span'));
		label.textContent = page.title;
		Object.assign(label.style, { flex: '1', minWidth: '0', fontSize: '13px', lineHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });

		// The whole row is both a click target (open) and a drag source (reparent).
		// A movement threshold tells them apart: a plain click opens the page; a drag
		// past a few pixels moves it. The Overview root is fixed - click only.
		row.addEventListener('mousedown', (e) => {
			if (e.button !== 0) { return; }
			// Let the row action icons (+, edit, trash) handle their own clicks.
			if ((e.target as HTMLElement)?.closest('[data-nb-action]')) { return; }
			this.beginRowInteraction(e, page, container);
		});

		const actions = append(row, $('div'));
		Object.assign(actions.style, { display: 'flex', gap: '2px', flexShrink: '0', visibility: 'hidden' });

		// Folders and pages can hold children: offer "+" on the row too.
		if (page.kind === 'overview' || page.kind === 'folder') {
			const addChild = append(actions, $('span.codicon.codicon-add')) as HTMLElement;
			addChild.title = 'New page here';
			addChild.setAttribute('data-nb-action', '');
			Object.assign(addChild.style, { cursor: 'pointer', opacity: '0.6', padding: '2px' });
			addChild.onclick = (e) => { e.stopPropagation(); void this.promptNewPage(page.id); };
		}

		if (page.id !== OVERVIEW_PAGE_ID) {
			const rename = append(actions, $('span.codicon.codicon-edit')) as HTMLElement;
			rename.title = 'Rename';
			rename.setAttribute('data-nb-action', '');
			Object.assign(rename.style, { cursor: 'pointer', opacity: '0.6', padding: '2px' });
			rename.onclick = (e) => { e.stopPropagation(); void this.promptRename(page); };

			const del = append(actions, $('span.codicon.codicon-trash')) as HTMLElement;
			del.title = 'Delete';
			del.setAttribute('data-nb-action', '');
			Object.assign(del.style, { cursor: 'pointer', opacity: '0.6', padding: '2px' });
			del.onclick = (e) => { e.stopPropagation(); void this.promptDelete(page); };
		}
	}

	// --- click vs drag ------------------------------------------------------

	/** True if `pageId` is `maybeDescendantId` itself or one of its ancestors -
	 *  used to forbid dropping a page inside its own subtree (which would orphan it). */
	private isSelfOrAncestor(pageId: string, maybeDescendantId: string): boolean {
		let cur: string | null | undefined = maybeDescendantId;
		const byId = new Map(this.allPages.map(p => [p.id, p]));
		while (cur) {
			if (cur === pageId) { return true; }
			cur = byId.get(cur)?.parent ?? null;
		}
		return false;
	}

	/**
	 * Handle a mousedown on a row. A movement threshold decides intent:
	 *  - released without moving  -> a click, so open the page.
	 *  - dragged past the threshold -> a reparent drag:
	 *      dropped on Overview/Folder -> child of it; on a Note/Roadmap -> sibling.
	 * Dropping onto itself or a descendant is refused (would orphan the subtree).
	 */
	private beginRowInteraction(e: MouseEvent, page: NotebookPage, treeContainer: HTMLElement): void {
		const doc = treeContainer.ownerDocument;
		const startX = e.clientX;
		const startY = e.clientY;
		const canDrag = page.id !== OVERVIEW_PAGE_ID;
		const self = (Array.from(treeContainer.children) as HTMLElement[]).find(r => r.dataset.pageId === page.id);
		let dragging = false;
		let chip: HTMLElement | undefined;
		let line: HTMLElement | undefined;
		// The pending drop, recomputed on every move: place the page under `parent`,
		// before `beforeId` (undefined = append to the end of that parent).
		let drop: { parent: string | null; beforeId?: string } | undefined;

		const startDrag = () => {
			dragging = true;
			self?.classList.add('aria-nb-dragging');
			if (self) { self.style.opacity = '0.4'; self.style.pointerEvents = 'none'; }
			// A floating "chip" of the row, so the page visibly rides the cursor.
			chip = doc.createElement('div');
			chip.textContent = page.title;
			Object.assign(chip.style, {
				position: 'fixed', zIndex: '3000', pointerEvents: 'none', maxWidth: '220px',
				padding: '3px 10px', borderRadius: '5px', fontSize: '12px', whiteSpace: 'nowrap',
				fontFamily: 'var(--vscode-font-family)',
				overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--vscode-foreground)',
				background: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))',
				border: '1px solid var(--vscode-focusBorder, #4a9eff)', boxShadow: '0 3px 10px rgba(0,0,0,0.35)',
			});
			doc.body.appendChild(chip);
			// The blue insertion line, positioned inside the (relative) tree.
			line = doc.createElement('div');
			Object.assign(line.style, {
				position: 'absolute', height: '2px', background: 'var(--vscode-focusBorder, #4a9eff)',
				borderRadius: '2px', pointerEvents: 'none', display: 'none', right: '4px',
			});
			treeContainer.appendChild(line);
		};

		const onMove = (ev: MouseEvent) => {
			if (!dragging) {
				if (!canDrag) { return; }
				if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) { return; }
				startDrag();
			}
			if (chip) { chip.style.left = `${ev.clientX + 12}px`; chip.style.top = `${ev.clientY + 8}px`; }

			drop = undefined;
			if (line) { line.style.display = 'none'; }
			const r = (doc.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('[data-page-id]') as HTMLElement | null;
			if (!r || r === self) { return; }
			const targetId = r.dataset.pageId!;
			const targetKind = r.dataset.pageKind as PageKind;
			if (this.isSelfOrAncestor(page.id, targetId)) { return; } // no dropping into own subtree
			const targetPage = this.allPages.find(p => p.id === targetId);
			if (!targetPage) { return; }

			const rect = r.getBoundingClientRect();
			const treeRect = treeContainer.getBoundingClientRect();
			const frac = (ev.clientY - rect.top) / rect.height;
			const targetDepth = this.depthOf(targetId);
			const canContain = targetKind === 'overview' || targetKind === 'folder';

			let depth: number;
			let top: number;
			if (canContain && frac >= 0.3 && frac <= 0.7) {
				// INTO the container: nested one level, appended as its first child.
				drop = { parent: targetId };
				depth = targetDepth + 1;
				top = rect.bottom - treeRect.top;
			} else if (frac < 0.5) {
				// BEFORE the row, as a sibling at the row's own depth.
				drop = { parent: targetPage.parent, beforeId: targetId };
				depth = targetDepth;
				top = rect.top - treeRect.top;
			} else {
				// AFTER the row (i.e. before the NEXT sibling), same depth.
				const next = this.nextSiblingId(targetId);
				drop = { parent: targetPage.parent, beforeId: next };
				depth = targetDepth;
				top = rect.bottom - treeRect.top;
			}
			if (line) {
				// Left inset communicates nesting: flush-left = top level, indented = child.
				line.style.left = `${AriaNotebookView.indentPx(depth)}px`;
				line.style.top = `${top - 1}px`;
				line.style.display = 'block';
			}
		};
		const onUp = () => {
			doc.removeEventListener('mousemove', onMove, true);
			doc.removeEventListener('mouseup', onUp, true);
			if (self) { self.style.pointerEvents = ''; }
			chip?.remove();
			line?.remove();
			if (!dragging) {
				// A plain click: folders toggle open/closed; other pages open in the editor.
				if (page.kind === 'folder') { this.toggleFolder(page.id); }
				else { void this.openPage(page); }
			} else if (drop) {
				void this.applyMove(page, drop);
			} else {
				void this.refresh();               // dropped nowhere valid
			}
		};
		doc.addEventListener('mousemove', onMove, true);
		doc.addEventListener('mouseup', onUp, true);
	}

	/** The id of the sibling that follows `pageId` among pages with the same parent,
	 *  or undefined when it is the last child (so a drop lands at the end). */
	private nextSiblingId(pageId: string): string | undefined {
		const page = this.allPages.find(p => p.id === pageId);
		if (!page) { return undefined; }
		const siblings = this.allPages.filter(p => p.parent === page.parent).sort((a, b) => a.order - b.order);
		const i = siblings.findIndex(p => p.id === pageId);
		return siblings[i + 1]?.id;
	}

	private async applyMove(page: NotebookPage, drop: { parent: string | null; beforeId?: string }): Promise<void> {
		const model = this.model();
		if (!model) { return; }
		await model.movePage(page.id, drop.parent, drop.beforeId);
		await this.refresh();
	}

	/** Collapse or expand a folder, hiding or showing its subtree. */
	private toggleFolder(folderId: string): void {
		if (this.collapsedFolders.has(folderId)) { this.collapsedFolders.delete(folderId); }
		else { this.collapsedFolders.add(folderId); }
		void this.refresh();
	}

	// --- open ---------------------------------------------------------------

	private async openPage(page: NotebookPage): Promise<void> {
		const folder = this.folderUri();
		if (!folder) { return; }
		switch (page.kind) {
			case 'overview':
				await this.commandService.executeCommand('aria.overview.open');
				break;
			case 'roadmap':
				await this.commandService.executeCommand('aria.roadmap.openWizard', { id: page.id, name: page.title });
				break;
			case 'note': {
				const model = this.model();
				if (!model) { return; }
				const uri = await model.ensureNoteFile(page.id, page.title);
				// Open through the Research Note command so it uses the BlockNote
				// editor pane, not the raw JSON text editor.
				await this.commandService.executeCommand('aria.notes.open', uri);
				break;
			}
			case 'folder':
				break; // folders just group; nothing to open
		}
	}

	// --- create / rename / delete ------------------------------------------

	private async promptNewPage(parent: string | null): Promise<void> {
		const model = this.model();
		if (!model) { return; }
		// Overview is the project's single fixed root (its content is one file), so it
		// is not offered here - only the pages that hang beneath it.
		const choice = await this.showKindPopup();
		if (!choice) { return; }

		if (choice === 'roadmap') {
			// Create the roadmap in the existing store and use its id as the page id
			// so the page and the roadmap file stay linked.
			const roadmapId = await this.commandService.executeCommand<string>('aria.roadmap.createRoadmap');
			if (!roadmapId) { return; }
			const page = await model.addPageWithId(roadmapId, 'roadmap', 'Untitled roadmap', parent);
			await this.refresh();
			await this.openPage(page);
			return;
		}

		const kind: Exclude<PageKind, 'overview' | 'roadmap'> = choice === 'note' ? 'note' : 'folder';
		const defaultTitle = kind === 'note' ? 'Untitled note' : 'New folder';
		const page = await model.addPage(kind, defaultTitle, parent);
		if (kind === 'note') { await model.ensureNoteFile(page.id, defaultTitle); }
		await this.refresh();
		if (kind !== 'folder') { await this.openPage(page); }
	}

	/** A small centered modal offering the page kinds. Returns the chosen kind, or
	 *  undefined on cancel (backdrop click / Escape). */
	private showKindPopup(): Promise<'note' | 'roadmap' | 'folder' | undefined> {
		const doc = this.viewBody?.ownerDocument ?? document;
		return new Promise(resolve => {
			const backdrop = doc.createElement('div');
			Object.assign(backdrop.style, {
				position: 'fixed', inset: '0', zIndex: '2000', display: 'flex',
				alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)',
			});
			const card = doc.createElement('div');
			Object.assign(card.style, {
				minWidth: '300px', background: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))',
				border: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.35))', borderRadius: '8px',
				boxShadow: '0 6px 24px rgba(0,0,0,0.4)', padding: '14px', color: 'var(--vscode-foreground)',
				fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)', fontSize: '13px',
			});
			const title = append(card, $('div'));
			title.textContent = 'New page';
			Object.assign(title.style, { fontWeight: '600', marginBottom: '10px' });

			const finish = (v: 'note' | 'roadmap' | 'folder' | undefined) => {
				doc.removeEventListener('keydown', onKey, true);
				backdrop.remove();
				resolve(v);
			};
			const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { finish(undefined); } };

			const option = (icon: string, label: string, desc: string, value: 'note' | 'roadmap' | 'folder') => {
				const row = append(card, $('div'));
				Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 10px', borderRadius: '6px', cursor: 'pointer' });
				row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.15))'; });
				row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
				const ic = append(row, $(`span.codicon.${icon}`)) as HTMLElement;
				Object.assign(ic.style, { fontSize: '16px', opacity: '0.8' });
				const text = append(row, $('div'));
				const l = append(text, $('div')); l.textContent = label; l.style.fontWeight = '600';
				const d = append(text, $('div')); d.textContent = desc; Object.assign(d.style, { fontSize: '11px', opacity: '0.7' });
				row.onclick = () => finish(value);
			};
			option('codicon-note', 'Note', 'A free-form note', 'note');
			option('codicon-map', 'Roadmap', 'A research plan you build with the AI', 'roadmap');
			option('codicon-folder', 'Folder', 'Group other pages', 'folder');

			backdrop.onclick = (e) => { if (e.target === backdrop) { finish(undefined); } };
			backdrop.appendChild(card);
			doc.body.appendChild(backdrop);
			doc.addEventListener('keydown', onKey, true);
		});
	}

	private async promptRename(page: NotebookPage): Promise<void> {
		const model = this.model();
		if (!model) { return; }
		const value = await this.quickInputService.input({ value: page.title, prompt: 'Rename page' });
		if (value === undefined) { return; }
		const title = value.trim();
		if (!title) { return; }
		await model.renamePage(page.id, title);
		if (page.kind === 'roadmap') {
			try { await this.commandService.executeCommand('aria.roadmap.rename', page.id, title); } catch { /* best-effort */ }
		}
		await this.refresh();
	}

	private async promptDelete(page: NotebookPage): Promise<void> {
		const model = this.model();
		if (!model) { return; }
		const { confirmed } = await this.dialogService.confirm({
			message: `Delete "${page.title}"?`,
			detail: 'This also removes any pages inside it.',
			primaryButton: 'Delete',
		});
		if (!confirmed) { return; }
		// Look up the full page objects before removal, so a Deleted event can capture
		// each page's last content for History.
		const byId = new Map((await model.read()).map(p => [p.id, p]));
		const removed = await model.removePage(page.id);
		const folder = this.folderUri();
		for (const id of removed) {
			const removedPage = byId.get(id);
			// Record the deletion (reads the content file, still present) BEFORE deleting it.
			if (removedPage && removedPage.kind !== 'folder') { await model.recordDelete(removedPage); }
			try { await this.commandService.executeCommand('aria.roadmap.deleteRoadmap', id); } catch { /* not a roadmap */ }
			if (folder) { try { await this.fileService.del(NotebookModel.noteUri(folder, id)); } catch { /* not a note */ } }
		}
		await this.refresh();
	}
}
