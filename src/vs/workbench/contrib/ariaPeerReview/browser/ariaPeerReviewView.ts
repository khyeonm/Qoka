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
 * Sidebar "AI Peer Review" view: "My Reviews" list of past runs
 * (`<workspace>/reviews/<execId>/`) shown as `title · date`, plus a New Review
 * button. Clicking a run opens the review pane; two same-titled papers stay
 * distinct by their execId.
 */
export class AriaPeerReviewView extends ViewPane {

	static readonly ID = 'aria.peerReview.main';

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
			const dir = this.reviewsDir();
			if (dir && e.affects(dir)) { void this.refresh(); }
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.aria-peer-review-view'));
		root.style.padding = '8px 10px';
		root.style.boxSizing = 'border-box';
		this.viewBody = root;
		void this.refresh();
	}

	private reviewsDir(): URI | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		return folder ? joinPath(folder.uri, 'reviews') : undefined;
	}

	private async refresh(): Promise<void> {
		const root = this.viewBody;
		if (!root) { return; }
		clearNode(root);

		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			this.empty(root, localize('aria.peerReview.noFolder', "Open a project folder to review papers."));
			return;
		}

		const newBtn = append(root, $('button')) as HTMLButtonElement;
		newBtn.textContent = localize('aria.peerReview.new', "+ New review");
		Object.assign(newBtn.style, { width: '100%', padding: '6px 10px', marginBottom: '8px', fontSize: '12px', cursor: 'pointer', borderRadius: '4px', border: 'none', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)' });
		newBtn.onclick = () => void this.commandService.executeCommand('aria.peerReview.new');

		const dir = this.reviewsDir();
		let entries: { execId: string; title: string; when: number; whenStr: string }[] = [];
		if (dir) {
			try {
				const stat = await this.fileService.resolve(dir);
				for (const c of (stat.children ?? []).filter(x => x.isDirectory)) {
					const meta = await this.readMeta(c.resource);
					const when = meta?.createdAt ? Date.parse(meta.createdAt) : 0;
					entries.push({ execId: basename(c.resource), title: meta?.title || basename(c.resource), when, whenStr: meta?.createdAt ? new Date(meta.createdAt).toLocaleString() : '' });
				}
			} catch { entries = []; }
		}
		entries.sort((a, b) => b.when - a.when);

		if (entries.length === 0) {
			this.empty(root, localize('aria.peerReview.empty', "No reviews yet. Start one with New review."));
			return;
		}

		for (const e of entries) {
			const row = append(root, $('div'));
			Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px', borderRadius: '4px', cursor: 'pointer' });
			row.onmouseenter = () => { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.12))'; };
			row.onmouseleave = () => { row.style.background = 'transparent'; };
			row.onclick = () => void this.commandService.executeCommand('aria.peerReview.open', e.execId);

			const icon = append(row, $('span.codicon.codicon-checklist')) as HTMLElement;
			icon.style.flexShrink = '0'; icon.style.opacity = '0.7';

			const col = append(row, $('div'));
			Object.assign(col.style, { flex: '1', overflow: 'hidden' });
			const title = append(col, $('div')); title.textContent = e.title;
			Object.assign(title.style, { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
			const when = append(col, $('div')); when.textContent = `${e.whenStr} · ${e.execId}`;
			Object.assign(when.style, { fontSize: '11px', opacity: '0.55', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

			const del = append(row, $('span.codicon.codicon-trash')) as HTMLElement;
			del.title = localize('aria.peerReview.delete', "Delete review");
			Object.assign(del.style, { flexShrink: '0', opacity: '0.6', cursor: 'pointer' });
			del.onclick = (ev) => { ev.stopPropagation(); void this.commandService.executeCommand('aria.peerReview.delete', e.execId); };
		}
	}

	private async readMeta(folder: URI): Promise<{ title?: string; createdAt?: string } | undefined> {
		try { return JSON.parse((await this.fileService.readFile(joinPath(folder, 'meta.json'))).value.toString()); } catch { return undefined; }
	}

	private empty(root: HTMLElement, text: string): void {
		const p = append(root, $('p'));
		p.style.opacity = '0.7'; p.style.fontSize = '13px'; p.textContent = text;
	}
}
