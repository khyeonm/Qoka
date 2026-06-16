/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
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

/**
 * Sidebar "Research Note" view: lists the project's notes (`notes/*.json`) by
 * title with a "New note" button. Clicking a title opens the BlockNote editor
 * in the editor area. Deleting is available per row.
 */
export class AriaNotesView extends ViewPane {

	static readonly ID = 'workbench.view.aria.notes.list';

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.refresh()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.refresh()));
		this._register(this.fileService.onDidFilesChange(e => {
			const dir = this.notesDirUri();
			if (dir && e.affects(dir)) {
				void this.refresh();
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.aria-notes-view'));
		root.style.padding = '8px 10px';
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

	private notesDirUri(): URI | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		return folder ? joinPath(folder.uri, 'notes') : undefined;
	}

	private async refresh(): Promise<void> {
		const root = this.viewBody;
		if (!root) {
			return;
		}
		clearNode(root);

		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			this.renderEmpty(root, localize('aria.notes.noFolder', "Open a project to keep research notes."));
			return;
		}

		const newBtn = append(root, $('button')) as HTMLButtonElement;
		newBtn.textContent = localize('aria.notes.new', "+ New note");
		newBtn.style.width = '100%';
		newBtn.style.padding = '6px 10px';
		newBtn.style.marginBottom = '8px';
		newBtn.style.fontSize = '12px';
		newBtn.style.cursor = 'pointer';
		newBtn.style.borderRadius = '4px';
		newBtn.style.border = 'none';
		newBtn.style.background = 'var(--vscode-button-background)';
		newBtn.style.color = 'var(--vscode-button-foreground)';
		newBtn.onclick = () => void this.commandService.executeCommand('aria.notes.new');

		const dir = this.notesDirUri();
		let entries: URI[] = [];
		if (dir) {
			try {
				const stat = await this.fileService.resolve(dir);
				entries = (stat.children ?? [])
					.filter(c => !c.isDirectory && c.name.endsWith('.json'))
					.map(c => c.resource);
			} catch {
				entries = [];
			}
		}

		if (entries.length === 0) {
			this.renderEmpty(root, localize('aria.notes.empty', "No notes yet. Create one with New note."));
			return;
		}

		for (const uri of entries) {
			const meta = await this.readMeta(uri);
			const title = meta.title;
			const row = append(root, $('div'));
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.gap = '6px';
			row.style.padding = '5px 6px';
			row.style.borderRadius = '4px';
			row.style.cursor = 'pointer';
			row.onmouseenter = () => { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.12))'; };
			row.onmouseleave = () => { row.style.background = 'transparent'; };

			const icon = append(row, $('span.codicon.codicon-note')) as HTMLElement;
			icon.style.flexShrink = '0';
			icon.style.opacity = '0.7';

			const label = append(row, $('span')) as HTMLElement;
			label.textContent = title;
			label.style.flex = '1';
			label.style.overflow = 'hidden';
			label.style.textOverflow = 'ellipsis';
			label.style.whiteSpace = 'nowrap';
			label.style.fontSize = '13px';
			row.onclick = () => void this.commandService.executeCommand('aria.notes.open', uri);

			// Last-modified stamp, left of the rename button. Fixed width + the
			// label's flex/ellipsis keep the title from overlapping it.
			const stamp = formatStamp(meta.updatedAt);
			if (stamp) {
				const date = append(row, $('span')) as HTMLElement;
				date.textContent = stamp;
				date.title = meta.updatedAt ? new Date(meta.updatedAt).toLocaleString() : '';
				date.style.flexShrink = '0';
				date.style.fontSize = '11px';
				date.style.opacity = '0.55';
				date.style.fontVariantNumeric = 'tabular-nums';
				date.style.marginRight = '2px';
			}

			const rename = append(row, $('span.codicon.codicon-edit')) as HTMLElement;
			rename.title = localize('aria.notes.rename', "Rename note");
			rename.style.flexShrink = '0';
			rename.style.opacity = '0.6';
			rename.style.cursor = 'pointer';
			rename.onclick = (e) => {
				e.stopPropagation();
				void this.commandService.executeCommand('aria.notes.rename', uri);
			};

			const del = append(row, $('span.codicon.codicon-trash')) as HTMLElement;
			del.title = localize('aria.notes.delete', "Delete note");
			del.style.flexShrink = '0';
			del.style.opacity = '0.6';
			del.style.cursor = 'pointer';
			del.onclick = (e) => {
				e.stopPropagation();
				void this.commandService.executeCommand('aria.notes.delete', uri);
			};
		}
	}

	private async readMeta(uri: URI): Promise<{ title: string; updatedAt?: string }> {
		let title = basename(uri).replace(/\.json$/, '');
		let updatedAt: string | undefined;
		try {
			const content = await this.fileService.readFile(uri);
			const parsed = JSON.parse(content.value.toString());
			if (typeof parsed.title === 'string' && parsed.title.trim()) {
				title = parsed.title.trim();
			}
			if (typeof parsed.updatedAt === 'string') {
				updatedAt = parsed.updatedAt;
			}
		} catch {
			// fall through to filename / no stamp
		}
		return { title, updatedAt };
	}

	private renderEmpty(root: HTMLElement, text: string): void {
		const empty = append(root, $('p'));
		empty.style.opacity = '0.7';
		empty.style.fontSize = '13px';
		empty.textContent = text;
	}
}

/** Compact last-modified stamp, e.g. "26/5/23 19:30" (YY/M/D). Empty if invalid. */
function formatStamp(iso?: string): string {
	if (!iso) {
		return '';
	}
	const d = new Date(iso);
	if (isNaN(d.getTime())) {
		return '';
	}
	const yy = String(d.getFullYear()).slice(-2);
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	return `${yy}/${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}
