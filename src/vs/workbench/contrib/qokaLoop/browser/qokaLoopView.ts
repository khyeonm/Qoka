/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';

interface LoopEntry { id: string; title: string; status: string; iteration: number; maxIter: number; createdAt: string; }

/**
 * Sidebar "Loops" view: lists this project's research loops (read from .qoka/loops/*.json). Clicking
 * a loop opens its DETAIL in the editor area (the qoka-loop extension's `qoka.loop.open` command),
 * so the rail behaves like the Manuscript tab (sidebar list -> editor detail), not a single
 * master-detail window. Refreshes automatically as the engine writes loop state.
 */
export class QokaLoopView extends ViewPane {

	static readonly ID = 'workbench.view.qoka.loop.list';

	private viewBody: HTMLElement | undefined;
	private refreshSeq = 0;

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => void this.refresh()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => void this.refresh()));
		this._register(this.fileService.onDidFilesChange(e => {
			const dir = this.loopsDir();
			if (dir && e.affects(dir)) { void this.refresh(); }
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.qoka-loop-view'));
		root.style.padding = '8px 10px';
		root.style.boxSizing = 'border-box';
		this.viewBody = root;
		void this.refresh();
	}

	private folderUri(): URI | undefined { return this.workspaceContextService.getWorkspace().folders[0]?.uri; }
	private loopsDir(): URI | undefined { const f = this.folderUri(); return f ? joinPath(f, '.qoka', 'loops') : undefined; }

	private async refresh(): Promise<void> {
		const root = this.viewBody;
		if (!root) { return; }
		const seq = ++this.refreshSeq;
		const isEmpty = this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY;
		const loops = isEmpty ? [] : await this.loadLoops();
		if (seq !== this.refreshSeq) { return; } // superseded by a newer refresh

		clearNode(root);
		if (isEmpty) {
			this.empty(root, localize('qoka.loop.noFolder', "Open a project folder to run research loops."));
			return;
		}
		if (loops.length === 0) {
			this.empty(root, localize('qoka.loop.none', "No loops yet. Ask the chat to run something as a loop."));
			return;
		}
		for (const l of loops) { this.loopRow(root, l); }
	}

	private loopRow(root: HTMLElement, l: LoopEntry): void {
		const row = append(root, $('div'));
		Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 6px', borderRadius: '4px', cursor: 'pointer' });
		row.onmouseenter = () => { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.12))'; };
		row.onmouseleave = () => { row.style.background = 'transparent'; };
		row.onclick = () => void this.commandService.executeCommand('qoka.loop.open', l.id);

		const badge = append(row, $('span'));
		badge.textContent = l.status === 'pending-approval' ? 'pending' : l.status;
		const colors: Record<string, string> = { running: '#4c8dff', success: '#4caf72', failed: '#e06666', paused: '#e0b050', stopped: '#9a9a9a' };
		const c = colors[l.status] ?? 'var(--vscode-badge-foreground)';
		Object.assign(badge.style, { flexShrink: '0', fontSize: '10px', fontWeight: '600', padding: '1px 7px', borderRadius: '9px', color: c, border: `1px solid ${c}66` });

		const col = append(row, $('div'));
		Object.assign(col.style, { flex: '1', overflow: 'hidden' });
		const title = append(col, $('div'));
		title.textContent = l.title;
		Object.assign(title.style, { fontSize: '13px', fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
		const sub = append(col, $('div'));
		sub.textContent = localize('qoka.loop.iter', "iteration {0} / {1}", l.iteration, l.maxIter);
		Object.assign(sub.style, { fontSize: '11px', opacity: '0.6' });
	}

	private async loadLoops(): Promise<LoopEntry[]> {
		const dir = this.loopsDir();
		if (!dir) { return []; }
		let files: URI[] = [];
		try {
			const stat = await this.fileService.resolve(dir);
			files = (stat.children ?? []).filter(c => !c.isDirectory && c.name.endsWith('.json') && !c.name.startsWith('.')).map(c => c.resource);
		} catch { return []; }
		const out: LoopEntry[] = [];
		for (const f of files) {
			try {
				const j = JSON.parse((await this.fileService.readFile(f)).value.toString());
				out.push({
					id: String(j.id ?? ''),
					title: (j.spec?.title && String(j.spec.title)) || String(j.id ?? 'loop'),
					status: String(j.status ?? 'pending-approval'),
					iteration: Number(j.iteration ?? 0) || 0,
					maxIter: Number(j.budget?.maxIter ?? 0) || 0,
					createdAt: String(j.createdAt ?? ''),
				});
			} catch { /* skip a corrupt loop file */ }
		}
		out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
		return out;
	}

	private empty(root: HTMLElement, text: string): void {
		const p = append(root, $('p'));
		Object.assign(p.style, { opacity: '0.7', fontSize: '12.5px', margin: '2px 6px' });
		p.textContent = text;
	}
}
