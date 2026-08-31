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
		this.legend(root);
		for (const l of loops) { this.loopRow(root, l); }
	}

	/** Traffic-light status colors, shared by the legend and the per-loop dots. */
	private static readonly STATUS_COLORS: Record<string, string> = {
		running: '#4c8dff', success: '#4caf72', failed: '#e06666', paused: '#e0b050', 'pending-approval': '#c0a040', stopped: '#9a9a9a',
	};

	/** A one-line color key at the top of the list so the traffic-light dots are self-explanatory. */
	private legend(root: HTMLElement): void {
		const bar = append(root, $('div'));
		Object.assign(bar.style, { display: 'flex', flexWrap: 'wrap', gap: '10px', padding: '2px 6px 10px', marginBottom: '4px', borderBottom: '1px solid var(--vscode-widget-border, rgba(127,127,127,0.25))' });
		const items: [string, string][] = [['running', 'running'], ['success', 'success'], ['failed', 'failed'], ['paused', 'paused'], ['pending-approval', 'pending'], ['stopped', 'stopped']];
		for (const [key, label] of items) {
			const item = append(bar, $('div'));
			Object.assign(item.style, { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', opacity: '0.85' });
			const dot = append(item, $('span'));
			Object.assign(dot.style, { width: '8px', height: '8px', borderRadius: '50%', background: QokaLoopView.STATUS_COLORS[key], flexShrink: '0' });
			append(item, $('span')).textContent = label;
		}
	}

	private loopRow(root: HTMLElement, l: LoopEntry): void {
		const row = append(root, $('div'));
		Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 6px', borderRadius: '4px', cursor: 'pointer' });
		row.onmouseenter = () => { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.12))'; };
		row.onmouseleave = () => { row.style.background = 'transparent'; };
		row.onclick = () => void this.commandService.executeCommand('qoka.loop.open', l.id);

		// Traffic-light status DOT (filled circle in the status color), like the mockup.
		const c = QokaLoopView.STATUS_COLORS[l.status] ?? 'var(--vscode-descriptionForeground)';
		const dot = append(row, $('span'));
		Object.assign(dot.style, { flexShrink: '0', width: '9px', height: '9px', borderRadius: '50%', background: c, boxShadow: `0 0 0 2px ${c}33` });

		const col = append(row, $('div'));
		Object.assign(col.style, { flex: '1', overflow: 'hidden' });
		const title = append(col, $('div'));
		title.textContent = l.title;
		Object.assign(title.style, { fontSize: '13px', fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
		const sub = append(col, $('div'));
		const statusText = l.status === 'pending-approval' ? 'pending' : l.status;
		sub.textContent = `${statusText} - ${localize('qoka.loop.iter', "iteration {0} / {1}", l.iteration, l.maxIter)}`;
		Object.assign(sub.style, { fontSize: '11px', opacity: '0.65' });

		// Trash icon to delete the loop (same affordance as the Manuscript/Notes lists). The command
		// asks whether to also remove the loop's code+results; the list refreshes via the file watcher.
		const del = append(row, $('span.codicon.codicon-trash')) as HTMLElement;
		del.title = localize('qoka.loop.delete', "Delete loop");
		Object.assign(del.style, { flexShrink: '0', opacity: '0.6', cursor: 'pointer' });
		del.onmouseenter = () => { del.style.opacity = '1'; };
		del.onmouseleave = () => { del.style.opacity = '0.6'; };
		del.onclick = (e) => { e.stopPropagation(); void this.commandService.executeCommand('qoka.loop.delete', l.id); };
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
