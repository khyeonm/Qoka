/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
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
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { FileChange, Snapshot, basename, formatRelativeTime, injectAriaVcsStyles, markerFor } from './ariaVcsCommon.js';

/**
 * Snapshots view — bottom half of the Versions container. Lists recent
 * snapshots as one-line rows that expand to reveal their per-file changes;
 * each file inside an expanded snapshot opens a diff against its parent.
 */
export class AriaSnapshotsView extends ViewPane {

	static readonly ID = 'workbench.view.aria.versions.snapshots';

	private viewBody: HTMLElement | undefined;
	private readonly expandedSnapshots = new Set<string>();

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
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		injectAriaVcsStyles();
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.refresh()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.refresh()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.aria-vcs-scroll'));
		root.style.padding = '12px';
		root.style.overflow = 'auto';
		root.style.boxSizing = 'border-box';
		root.style.width = '100%';
		this.viewBody = root;
		this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.viewBody) {
			this.viewBody.style.height = `${height}px`;
			this.viewBody.style.width = `${width}px`;
		}
	}

	private async refresh(): Promise<void> {
		const root = this.viewBody;
		if (!root) {
			return;
		}
		clearNode(root);

		const hasFolder = this.workspaceContextService.getWorkbenchState() !== WorkbenchState.EMPTY;
		if (!hasFolder) {
			return;
		}

		let snapshots: Snapshot[] = [];
		try {
			snapshots = await this.commandService.executeCommand<Snapshot[]>('aria.vcs.getRecent', 50) ?? [];
		} catch {
			snapshots = [];
		}

		if (snapshots.length === 0) {
			const empty = append(root, $('p'));
			empty.style.opacity = '0.6';
			empty.style.fontSize = '13px';
			empty.textContent = localize('aria.vcs.noSnapshots', "No snapshots yet — save your first one in Changes.");
			return;
		}

		for (const s of snapshots) {
			this.renderSnapshot(root, s);
		}
	}

	private renderSnapshot(parent: HTMLElement, snapshot: Snapshot): void {
		const container = append(parent, $('div'));

		const row = append(container, $('.aria-vcs-row')) as HTMLElement;
		row.style.cursor = 'pointer';

		const arrow = append(row, $('span'));
		arrow.style.width = '12px';
		arrow.style.fontSize = '10px';
		arrow.style.opacity = '0.6';
		arrow.style.flexShrink = '0';

		const time = append(row, $('span'));
		time.style.opacity = '0.6';
		time.style.fontSize = '11px';
		time.style.minWidth = '70px';
		time.style.flexShrink = '0';
		time.textContent = formatRelativeTime(snapshot.timestamp);

		const message = append(row, $('span'));
		message.style.flex = '1';
		message.style.whiteSpace = 'nowrap';
		message.style.overflow = 'hidden';
		message.style.textOverflow = 'ellipsis';
		message.textContent = snapshot.message;
		message.title = snapshot.message;

		let details: HTMLElement | undefined;
		let loaded = false;

		const applyExpanded = (expanded: boolean): void => {
			arrow.textContent = expanded ? '▼' : '▶';
			if (expanded) {
				this.expandedSnapshots.add(snapshot.hash);
				if (!details) {
					details = append(container, $('div'));
					details.style.padding = '4px 8px 8px 26px';
					details.style.fontSize = '12px';
				}
				details.style.display = 'block';
				if (!loaded) {
					loaded = true;
					void this.renderSnapshotDetails(details, snapshot);
				}
			} else {
				this.expandedSnapshots.delete(snapshot.hash);
				if (details) {
					details.style.display = 'none';
				}
			}
		};

		applyExpanded(this.expandedSnapshots.has(snapshot.hash));

		row.onclick = () => {
			applyExpanded(arrow.textContent !== '▼');
		};
	}

	private async renderSnapshotDetails(details: HTMLElement, snapshot: Snapshot): Promise<void> {
		const restoreBtn = append(details, $('button')) as HTMLButtonElement;
		restoreBtn.textContent = localize('aria.vcs.goBack', "↶ Go back to this version");
		restoreBtn.style.padding = '4px 10px';
		restoreBtn.style.fontSize = '12px';
		restoreBtn.style.cursor = 'pointer';
		restoreBtn.style.border = '1px solid var(--vscode-widget-border, transparent)';
		restoreBtn.style.background = 'transparent';
		restoreBtn.style.color = 'var(--vscode-foreground)';
		restoreBtn.style.borderRadius = '3px';
		restoreBtn.style.marginBottom = '8px';
		restoreBtn.onclick = async (e) => {
			e.stopPropagation();
			await this.commandService.executeCommand('aria.vcs.restoreSnapshot', snapshot.hash);
			this.refresh();
		};

		let files: FileChange[] = [];
		try {
			files = await this.commandService.executeCommand<FileChange[]>('aria.vcs.getSnapshotChanges', snapshot.hash) ?? [];
		} catch {
			files = [];
		}

		if (files.length === 0) {
			const empty = append(details, $('div'));
			empty.style.opacity = '0.6';
			empty.textContent = localize('aria.vcs.noFilesInSnapshot', "(no file changes recorded)");
			return;
		}

		for (const file of files) {
			const row = append(details, $('.aria-vcs-row')) as HTMLElement;
			row.style.padding = '2px 6px';
			row.style.fontSize = '12px';

			const { label, color } = markerFor(file.kind);
			const marker = append(row, $('span.aria-vcs-marker')) as HTMLElement;
			marker.textContent = label;
			marker.style.color = color;

			const nameSpan = append(row, $('span.aria-vcs-filename'));
			nameSpan.textContent = basename(file.path);
			nameSpan.title = file.path;
			nameSpan.onclick = () => {
				void this.commandService.executeCommand('aria.vcs.openSnapshotDiff', snapshot.hash, file.path);
			};

			if (file.additions !== undefined && file.deletions !== undefined) {
				const stats = append(row, $('span.aria-vcs-stats'));
				stats.textContent = `+${file.additions} −${file.deletions}`;
			}
		}
	}
}
