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

/**
 * Sidebar "Slides" view: lists this project's decks (`.qoka/slides/<slug>/`) by
 * title with a "New slides" button. Clicking a deck opens the render editor
 * (qoka.slides.openDeck, from the qoka-slides extension); the trash deletes it.
 */
export class QokaSlidesView extends ViewPane {

	static readonly ID = 'workbench.view.qoka.slides.list';

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
			const dir = this.slidesDirUri();
			if (dir && e.affects(dir)) { void this.refresh(); }
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.qoka-slides-view'));
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

	private slidesDirUri(): URI | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		return folder ? joinPath(folder.uri, '.qoka', 'slides') : undefined;
	}

	private async refresh(): Promise<void> {
		const root = this.viewBody;
		if (!root) { return; }
		clearNode(root);

		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			this.renderEmpty(root, localize('qoka.slides.noFolder', "Open a project to build slide decks."));
			return;
		}

		const newBtn = append(root, $('button')) as HTMLButtonElement;
		newBtn.textContent = localize('qoka.slides.new', "+ New slides");
		newBtn.style.width = '100%';
		newBtn.style.padding = '6px 10px';
		newBtn.style.marginBottom = '8px';
		newBtn.style.fontSize = '12px';
		newBtn.style.cursor = 'pointer';
		newBtn.style.borderRadius = '4px';
		newBtn.style.border = 'none';
		newBtn.style.background = 'var(--vscode-button-background)';
		newBtn.style.color = 'var(--vscode-button-foreground)';
		newBtn.onclick = () => void this.commandService.executeCommand('qoka.slides.new');

		const dir = this.slidesDirUri();
		let decks: { slug: string; title: string }[] = [];
		if (dir) {
			try {
				const stat = await this.fileService.resolve(dir);
				for (const child of stat.children ?? []) {
					if (child.isDirectory) {
						decks.push({ slug: child.name, title: await this.readTitle(joinPath(child.resource, 'meta.json'), child.name) });
					}
				}
			} catch {
				decks = [];
			}
		}

		if (decks.length === 0) {
			this.renderEmpty(root, localize('qoka.slides.empty', "No slides yet. Create one with New slides, or ask the AI."));
			return;
		}

		for (const deck of decks) {
			const row = append(root, $('div'));
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.gap = '6px';
			row.style.padding = '5px 6px';
			row.style.borderRadius = '4px';
			row.style.cursor = 'pointer';
			row.onmouseenter = () => { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.12))'; };
			row.onmouseleave = () => { row.style.background = 'transparent'; };

			const icon = append(row, $('span.codicon.codicon-window')) as HTMLElement;
			icon.style.flexShrink = '0';
			icon.style.opacity = '0.7';

			const label = append(row, $('span')) as HTMLElement;
			label.textContent = deck.title;
			label.style.flex = '1';
			label.style.overflow = 'hidden';
			label.style.textOverflow = 'ellipsis';
			label.style.whiteSpace = 'nowrap';
			label.style.fontSize = '13px';
			row.onclick = () => void this.commandService.executeCommand('qoka.slides.openDeck', deck.slug);

			const rename = append(row, $('span.codicon.codicon-edit')) as HTMLElement;
			rename.title = localize('qoka.slides.rename', "Rename slides");
			rename.style.flexShrink = '0';
			rename.style.opacity = '0.6';
			rename.style.cursor = 'pointer';
			rename.onclick = (e) => {
				e.stopPropagation();
				void this.commandService.executeCommand('qoka.slides.rename', deck.slug);
			};

			const del = append(row, $('span.codicon.codicon-trash')) as HTMLElement;
			del.title = localize('qoka.slides.delete', "Delete slides");
			del.style.flexShrink = '0';
			del.style.opacity = '0.6';
			del.style.cursor = 'pointer';
			del.onclick = (e) => {
				e.stopPropagation();
				void this.commandService.executeCommand('qoka.slides.delete', deck.slug);
			};
		}
	}

	private async readTitle(metaUri: URI, fallback: string): Promise<string> {
		try {
			const content = await this.fileService.readFile(metaUri);
			const parsed = JSON.parse(content.value.toString());
			if (typeof parsed.title === 'string' && parsed.title.trim()) { return parsed.title.trim(); }
		} catch {
			// fall through to the slug
		}
		return fallback;
	}

	private renderEmpty(root: HTMLElement, text: string): void {
		const empty = append(root, $('p'));
		empty.style.opacity = '0.7';
		empty.style.fontSize = '13px';
		empty.textContent = text;
	}
}
