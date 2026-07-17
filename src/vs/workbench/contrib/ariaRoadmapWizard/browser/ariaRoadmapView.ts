/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAction } from '../../../../base/common/actions.js';
import { IActionViewItem } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IDropdownMenuActionViewItemOptions } from '../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { renderAriaTabSummary, createAriaHelpTitleActionViewItem } from '../../aria/browser/ariaHelpEditor.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { applyAriaScrollbar } from '../../aria/browser/ariaScrollbar.js';

interface PersistedNode {
	id: string;
	column: number;
	parent: string | null;
	label: string;
	description?: string;
	status?: 'todo' | 'in_progress' | 'done';
}

interface PersistedRoadmap {
	version: number;
	columnLabels: string[];
	nodes: PersistedNode[];
	updatedAt?: number;
	name?: string;
}

/** One roadmap in the project, summarized for the sidebar list. */
interface RoadmapListItem {
	id: string;
	/** Custom name if set, else the hypothesis sentence (first Goal node), else a placeholder. */
	name: string;
	nodeCount: number;
	/** Last-modified time (ms) for the row's date stamp. */
	updatedAt: number;
}

const UNTITLED = 'Untitled roadmap';

/**
 * Sidebar view for the project's roadmaps (`<workspace>/.aria/roadmaps/*.json`).
 *
 * A project holds MANY roadmaps - one per hypothesis. This lists them by their
 * hypothesis sentence (each roadmap's first Goal node); clicking one opens its
 * full pan/zoom/editable canvas in the editor, each row has a Delete button, and
 * "+ New roadmap" starts a fresh one. Re-reads whenever a roadmap file changes.
 */
export class AriaRoadmapView extends ViewPane {

	static readonly ID = 'workbench.view.aria.roadmap.tree';

	private viewBody: HTMLElement | undefined;

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.refresh()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.refresh()));
		// Re-read whenever any roadmap file changes (create/delete, the wizard
		// auto-saving, manual edits) - the whole roadmaps dir is watched.
		this._register(this.fileService.onDidFilesChange(e => {
			const dir = this.roadmapsDirUri();
			if (dir && e.affects(dir)) {
				void this.refresh();
			}
		}));
	}

	override createActionViewItem(action: IAction, options?: IDropdownMenuActionViewItemOptions): IActionViewItem | undefined {
		return createAriaHelpTitleActionViewItem(action, 'roadmap', options ?? {})
			?? super.createActionViewItem(action, options);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.aria-roadmap-view'));
		applyAriaScrollbar(root);
		root.style.padding = '10px';
		root.style.overflow = 'auto';
		root.style.boxSizing = 'border-box';
		root.style.width = '100%';
		this.viewBody = root;
		void this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.viewBody) {
			this.viewBody.style.height = `${height}px`;
			this.viewBody.style.width = `${width}px`;
		}
	}

	private roadmapsDirUri(): URI | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return undefined;
		}
		return joinPath(folder.uri, '.aria', 'roadmaps');
	}

	/** Read every `<workspace>/.aria/roadmaps/*.json`, newest first, summarizing
	 *  each by its hypothesis sentence (first Goal node). */
	private async listRoadmaps(): Promise<RoadmapListItem[]> {
		const dir = this.roadmapsDirUri();
		if (!dir) {
			return [];
		}
		let stat;
		try {
			stat = await this.fileService.resolve(dir);
		} catch {
			return []; // no roadmaps dir yet
		}
		const items: RoadmapListItem[] = [];
		for (const child of stat.children ?? []) {
			if (child.isDirectory || !child.name.endsWith('.json')) {
				continue;
			}
			try {
				const content = await this.fileService.readFile(child.resource);
				const roadmap = JSON.parse(content.value.toString()) as PersistedRoadmap;
				const nodes = Array.isArray(roadmap.nodes) ? roadmap.nodes : [];
				items.push({
					id: child.name.slice(0, -'.json'.length),
					name: this.displayName(roadmap.name, nodes),
					nodeCount: nodes.length,
					updatedAt: typeof roadmap.updatedAt === 'number' ? roadmap.updatedAt : (child.mtime ?? 0),
				});
			} catch {
				// Skip an unreadable roadmap rather than failing the whole list.
			}
		}
		items.sort((a, b) => b.updatedAt - a.updatedAt);
		return items;
	}

	/** Custom name wins, else the hypothesis (first Goal), else a placeholder. */
	private displayName(explicit: string | undefined, nodes: PersistedNode[]): string {
		const trimmed = explicit?.trim();
		if (trimmed) {
			return trimmed;
		}
		const goal = nodes.find(n => n.column === 0 && (n.parent === null || n.parent === undefined));
		const label = goal?.label?.trim();
		return label ? label : UNTITLED;
	}

	/** Format a timestamp as "YY/M/D HH:MM" to match the compact row stamp. */
	private formatDate(ms: number): string {
		if (!ms) {
			return '';
		}
		const d = new Date(ms);
		const yy = String(d.getFullYear()).slice(-2);
		const hh = String(d.getHours()).padStart(2, '0');
		const mm = String(d.getMinutes()).padStart(2, '0');
		return `${yy}/${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
	}

	private refreshSeq = 0;

	/**
	 * Re-render the roadmap list. Reads the roadmaps BEFORE touching the DOM, so
	 * every mutation below is synchronous and atomic.
	 *
	 * This ordering matters: refresh() is re-entrant (renderBody fires one, and
	 * every file change fires another - open_roadmap alone writes the active
	 * roadmap several times in a row). With the await placed AFTER clearNode, two
	 * in-flight refreshes would each clear, then each append their own list once
	 * their read resolved - rendering the SAME roadmap twice until some later
	 * single write re-rendered it. The generation counter drops superseded runs.
	 */
	private async refresh(): Promise<void> {
		const seq = ++this.refreshSeq;
		const root = this.viewBody;
		if (!root) {
			return;
		}

		const isEmptyWorkspace = this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY;
		const roadmaps = isEmptyWorkspace ? [] : await this.listRoadmaps();

		// A newer refresh started (or the body was swapped) while we were reading -
		// let that one render instead of double-appending on top of it.
		if (seq !== this.refreshSeq || root !== this.viewBody) {
			return;
		}

		clearNode(root);

		// Full-width one-line summary at the top of the sidebar.
		renderAriaTabSummary(root, 'roadmap');

		// "+ New roadmap" is always available under the summary.
		this.renderNewRoadmapButton(root);

		if (isEmptyWorkspace) {
			this.renderEmpty(root, localize('aria.roadmap.noFolder', "Open a project to see its roadmaps."));
			return;
		}

		if (roadmaps.length === 0) {
			this.renderEmpty(root, localize('aria.roadmap.empty', "No roadmaps yet. Click “+ New roadmap” (or use New Project) to draft one with your AI assistant."));
			return;
		}

		const list = append(root, $('div'));
		list.style.marginTop = '4px';
		for (const item of roadmaps) {
			this.renderRoadmapRow(list, item);
		}
	}

	/** One roadmap in the list: its hypothesis sentence (full, truncated with an
	 *  ellipsis when it overflows) plus a Delete button. Clicking opens it. */
	private renderRoadmapRow(list: HTMLElement, item: RoadmapListItem): void {
		const row = append(list, $('div'));
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '6px';
		row.style.padding = '8px 6px';
		row.style.borderBottom = '1px solid rgba(127,127,127,0.15)';
		row.style.cursor = 'pointer';
		row.style.borderRadius = '4px';
		row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.1))'; });
		row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
		row.onclick = () => void this.commandService.executeCommand('aria.roadmap.openWizard', {
			id: item.id,
			name: item.name === UNTITLED ? undefined : item.name,
		});
		row.title = localize('aria.roadmap.openHint', "Open this roadmap");

		// The hypothesis sentence - full text, single line, ellipsis on overflow.
		const label = append(row, $('span'));
		label.textContent = item.name;
		label.style.flex = '1 1 auto';
		label.style.minWidth = '0';
		label.style.overflow = 'hidden';
		label.style.textOverflow = 'ellipsis';
		label.style.whiteSpace = 'nowrap';
		label.style.fontSize = '13px';
		if (item.name === UNTITLED) {
			label.style.opacity = '0.6';
		}
		label.title = item.name; // full sentence on hover

		// Compact date stamp (YY/M/D HH:MM), styled like the Research Note list.
		const stamp = this.formatDate(item.updatedAt);
		if (stamp) {
			const date = append(row, $('span'));
			date.textContent = stamp;
			date.title = item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '';
			date.style.flexShrink = '0';
			date.style.fontSize = '11px';
			date.style.opacity = '0.55';
			date.style.fontVariantNumeric = 'tabular-nums';
			date.style.marginRight = '2px';
		}

		// Pencil (rename) + trash (delete) - the same codicons the Research Note
		// list uses. Both stop propagation so the row's open-on-click doesn't fire.
		const rename = append(row, $('span.codicon.codicon-edit')) as HTMLElement;
		rename.title = localize('aria.roadmap.rename', "Rename this roadmap");
		rename.style.flexShrink = '0';
		rename.style.opacity = '0.6';
		rename.style.cursor = 'pointer';
		rename.onclick = (e) => { e.stopPropagation(); void this.promptRename(item); };

		const del = append(row, $('span.codicon.codicon-trash')) as HTMLElement;
		del.title = localize('aria.roadmap.deleteRoadmap', "Delete this roadmap");
		del.style.flexShrink = '0';
		del.style.opacity = '0.6';
		del.style.cursor = 'pointer';
		del.onclick = (e) => { e.stopPropagation(); void this.confirmDelete(item); };
	}

	private async promptRename(item: RoadmapListItem): Promise<void> {
		const next = await this.quickInputService.input({
			title: localize('aria.roadmap.renameTitle', "Rename roadmap"),
			prompt: localize('aria.roadmap.renamePrompt', "New name. Leave blank to use the hypothesis sentence."),
			value: item.name === UNTITLED ? '' : item.name,
		});
		if (next === undefined) {
			return; // cancelled
		}
		await this.commandService.executeCommand('aria.roadmap.rename', item.id, next.trim());
		void this.refresh();
	}

	private async confirmDelete(item: RoadmapListItem): Promise<void> {
		const label = item.name === UNTITLED ? 'this untitled roadmap' : `"${item.name}"`;
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: localize('aria.roadmap.deleteConfirm', "Delete {0}?", label),
			detail: localize('aria.roadmap.deleteDetail', "This removes the entire roadmap. This cannot be undone."),
			primaryButton: localize('aria.roadmap.deleteButton', "Delete"),
		});
		if (!confirmed) {
			return;
		}
		await this.commandService.executeCommand('aria.roadmap.deleteRoadmap', item.id);
		void this.refresh();
	}

	/** "+ New roadmap" - create a fresh roadmap and open its canvas so the AI can
	 *  draft it. Each roadmap is one hypothesis. */
	private renderNewRoadmapButton(root: HTMLElement): void {
		const button = append(root, $('button')) as HTMLButtonElement;
		button.textContent = localize('aria.roadmap.newRoadmap', "+ New roadmap");
		button.style.display = 'block';
		button.style.width = '100%';
		button.style.margin = '10px 0';
		button.style.padding = '8px 10px';
		button.style.fontSize = '13px';
		button.style.cursor = 'pointer';
		button.style.borderRadius = '4px';
		button.style.border = 'none';
		button.style.background = 'var(--vscode-button-background)';
		button.style.color = 'var(--vscode-button-foreground)';
		button.onclick = async () => {
			const id = await this.commandService.executeCommand<string | undefined>('aria.roadmap.createRoadmap');
			await this.commandService.executeCommand('aria.roadmap.openWizard', id ? { id } : undefined);
		};
	}

	private renderEmpty(root: HTMLElement, text: string): void {
		const empty = append(root, $('p'));
		empty.style.opacity = '0.7';
		empty.style.fontSize = '13px';
		empty.textContent = text;
	}
}
