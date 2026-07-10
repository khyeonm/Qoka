/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
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
 * Sidebar "Paper Writer" view: lists the project's papers (`paper/<id>/`) with a
 * "New paper" button. Clicking a paper opens the setup-form editor pane.
 */
export class AriaPaperWriterView extends ViewPane {

	// Pinned, prefix-free id like the other working Aria views (Skills/Autopipe).
	static readonly ID = 'aria.paperWriter.main';

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
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => void this.refresh()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => void this.refresh()));
		this._register(this.fileService.onDidFilesChange(e => {
			const dir = this.papersDir();
			if (dir && e.affects(dir)) { void this.refresh(); }
		}));
	}

	override createActionViewItem(action: IAction, options?: IDropdownMenuActionViewItemOptions): IActionViewItem | undefined {
		return createAriaHelpTitleActionViewItem(action, 'paper-writer', options ?? {})
			?? super.createActionViewItem(action, options);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.aria-paper-writer-view'));
		root.style.padding = '8px 10px';
		root.style.boxSizing = 'border-box';
		this.viewBody = root;
		void this.refresh();
	}

	private papersDir(): URI | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		return folder ? joinPath(folder.uri, 'paper') : undefined;
	}

	private async refresh(): Promise<void> {
		const root = this.viewBody;
		if (!root) { return; }
		clearNode(root);

		// Full-width one-line summary at the top of the sidebar.
		renderAriaTabSummary(root, 'paper-writer');

		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			this.empty(root, localize('aria.paperWriter.noFolder', "Open a project folder to write papers."));
			return;
		}

		const newBtn = append(root, $('button')) as HTMLButtonElement;
		newBtn.textContent = localize('aria.paperWriter.new', "+ New paper");
		newBtn.style.width = '100%';
		newBtn.style.padding = '6px 10px';
		newBtn.style.marginBottom = '8px';
		newBtn.style.fontSize = '12px';
		newBtn.style.cursor = 'pointer';
		newBtn.style.borderRadius = '4px';
		newBtn.style.border = 'none';
		newBtn.style.background = 'var(--vscode-button-background)';
		newBtn.style.color = 'var(--vscode-button-foreground)';
		newBtn.onclick = () => void this.commandService.executeCommand('aria.paperWriter.new');

		const dir = this.papersDir();
		let folders: URI[] = [];
		if (dir) {
			try {
				const stat = await this.fileService.resolve(dir);
				folders = (stat.children ?? []).filter(c => c.isDirectory).map(c => c.resource);
			} catch {
				folders = [];
			}
		}

		if (folders.length === 0) {
			this.empty(root, localize('aria.paperWriter.empty', "No papers yet. Create one with New paper."));
			return;
		}

		for (const folder of folders) {
			const title = await this.readTitle(folder);
			const row = append(root, $('div'));
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.gap = '6px';
			row.style.padding = '5px 6px';
			row.style.borderRadius = '4px';
			row.style.cursor = 'pointer';
			row.onmouseenter = () => { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.12))'; };
			row.onmouseleave = () => { row.style.background = 'transparent'; };
			row.onclick = () => void this.commandService.executeCommand('aria.paperWriter.open', folder);

			const icon = append(row, $('span.codicon.codicon-output')) as HTMLElement;
			icon.style.flexShrink = '0';
			icon.style.opacity = '0.7';

			const label = append(row, $('span')) as HTMLElement;
			label.textContent = title;
			label.style.flex = '1';
			label.style.overflow = 'hidden';
			label.style.textOverflow = 'ellipsis';
			label.style.whiteSpace = 'nowrap';
			label.style.fontSize = '13px';

			const del = append(row, $('span.codicon.codicon-trash')) as HTMLElement;
			del.title = localize('aria.paperWriter.delete', "Delete paper");
			del.style.flexShrink = '0';
			del.style.opacity = '0.6';
			del.style.cursor = 'pointer';
			del.onclick = (e) => {
				e.stopPropagation();
				void this.commandService.executeCommand('aria.paperWriter.delete', folder);
			};
		}
	}

	private async readTitle(folder: URI): Promise<string> {
		try {
			const content = await this.fileService.readFile(joinPath(folder, 'meta.json'));
			const parsed = JSON.parse(content.value.toString());
			if (typeof parsed.title === 'string' && parsed.title.trim()) {
				return parsed.title.trim();
			}
		} catch {
			// fall through to folder name
		}
		return basename(folder);
	}

	private empty(root: HTMLElement, text: string): void {
		const p = append(root, $('p'));
		p.style.opacity = '0.7';
		p.style.fontSize = '13px';
		p.textContent = text;
	}
}
