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
import { FileChange, StatusInfo, basename, injectAriaVcsStyles, markerFor, onDidChangeSnapshots, notifySnapshotsChanged } from './ariaVcsCommon.js';

/**
 * Changes view — top half of the Versions container in Easy mode. Shows the
 * unsaved-change banner, the Save Snapshot button, and a checkbox list of
 * every changed file (filename only, full path in the diff title on click).
 */
export class AriaChangesView extends ViewPane {

	static readonly ID = 'workbench.view.aria.versions.changes';

	private viewBody: HTMLElement | undefined;
	private selectedPaths: Set<string> | undefined;

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
		// A restore in the Snapshots view rewrites the working tree, so keep the
		// unsaved-changes list here in sync via the shared snapshot signal.
		this._register(onDidChangeSnapshots(() => this.refresh()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.aria-vcs-scroll'));
		root.style.padding = '6px 8px';
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
			this.renderEmpty(root, localize('aria.vcs.openFolder', "Open a folder to start saving snapshots."));
			return;
		}

		let status: StatusInfo | undefined;
		try {
			status = await this.commandService.executeCommand<StatusInfo>('aria.vcs.getStatus');
		} catch {
			status = undefined;
		}

		const banner = append(root, $('div'));
		banner.style.padding = '8px 10px';
		banner.style.marginBottom = '6px';
		banner.style.borderRadius = '4px';
		banner.style.background = 'var(--vscode-editorWidget-background)';
		banner.style.border = '1px solid var(--vscode-widget-border, transparent)';

		const bannerText = append(banner, $('div'));
		bannerText.style.marginBottom = '6px';
		bannerText.style.fontSize = '12px';
		if (!status || !status.isRepo) {
			bannerText.textContent = localize('aria.vcs.notInitialized', "No snapshots yet — your first Save will set things up.");
		} else if (status.unsavedChanges > 0) {
			bannerText.textContent = localize('aria.vcs.unsavedCount', "{0} unsaved change{1}", status.unsavedChanges, status.unsavedChanges === 1 ? '' : 's');
		} else {
			bannerText.textContent = localize('aria.vcs.allSaved', "All changes saved.");
		}

		const saveBtn = append(banner, $('button')) as HTMLButtonElement;
		saveBtn.style.width = '100%';
		saveBtn.style.padding = '6px 10px';
		saveBtn.style.fontSize = '12px';
		saveBtn.style.cursor = 'pointer';
		saveBtn.style.background = 'var(--vscode-button-background)';
		saveBtn.style.color = 'var(--vscode-button-foreground)';
		saveBtn.style.border = 'none';
		saveBtn.style.borderRadius = '4px';
		saveBtn.style.fontWeight = '500';

		const updateSaveLabel = () => {
			if (this.selectedPaths === undefined) {
				saveBtn.textContent = localize('aria.vcs.save', "Save Snapshot");
				saveBtn.disabled = false;
				saveBtn.style.opacity = '1';
				saveBtn.style.cursor = 'pointer';
			} else {
				const n = this.selectedPaths.size;
				saveBtn.textContent = localize('aria.vcs.saveSelected', "Save Snapshot ({0} selected)", n);
				saveBtn.disabled = n === 0;
				saveBtn.style.opacity = n === 0 ? '0.5' : '1';
				saveBtn.style.cursor = n === 0 ? 'not-allowed' : 'pointer';
			}
		};
		updateSaveLabel();
		saveBtn.onclick = async () => {
			const paths = this.selectedPaths ? Array.from(this.selectedPaths) : undefined;
			if (paths && paths.length === 0) {
				return;
			}
			await this.commandService.executeCommand('aria.vcs.saveSnapshot', undefined, paths);
			this.selectedPaths = undefined;
			// Refresh both the Changes list and the Snapshots graph so the newly
			// saved snapshot appears immediately.
			notifySnapshotsChanged();
		};

		if (status && status.isRepo && status.unsavedChanges > 0) {
			await this.renderChanges(root, updateSaveLabel);
		}
	}

	private async renderChanges(parent: HTMLElement, onSelectionChanged: () => void): Promise<void> {
		let changes: FileChange[] = [];
		try {
			changes = await this.commandService.executeCommand<FileChange[]>('aria.vcs.getChanges') ?? [];
		} catch {
			changes = [];
		}
		if (changes.length === 0) {
			return;
		}

		// Drop stale selections.
		if (this.selectedPaths) {
			const visible = new Set(changes.map(c => c.path));
			for (const p of Array.from(this.selectedPaths)) {
				if (!visible.has(p)) {
					this.selectedPaths.delete(p);
				}
			}
		}

		const list = append(parent, $('div'));
		list.style.marginTop = '4px';

		// Helper — total selected (treats `undefined` as "all selected").
		const totalSelected = (): number =>
			this.selectedPaths === undefined ? changes.length : this.selectedPaths.size;

		// Track each per-file checkbox so Select all / Deselect all can flip
		// them in place rather than re-rendering the whole list (a full
		// refresh causes a visible flicker when there are many rows).
		const fileCheckboxes: { path: string; checkbox: HTMLInputElement }[] = [];

		// Master row: checkbox + label + (right-aligned) refresh button.
		// Putting Refresh here keeps it on the same horizontal line as the
		// Select all / Deselect all toggle, instead of in a separate header
		// row that wasted vertical space.
		const masterRow = append(list, $('.aria-vcs-row')) as HTMLElement;

		const masterCheckbox = append(masterRow, $('input')) as HTMLInputElement;
		masterCheckbox.type = 'checkbox';
		masterCheckbox.style.cursor = 'pointer';
		masterCheckbox.style.flexShrink = '0';

		const masterLabel = append(masterRow, $('span')) as HTMLElement;
		masterLabel.style.fontSize = '12px';
		masterLabel.style.opacity = '0.75';
		masterLabel.style.cursor = 'pointer';
		masterLabel.style.userSelect = 'none';

		// Spacer pushes the refresh button to the right edge of the row.
		const spacer = append(masterRow, $('div'));
		spacer.style.flex = '1';

		const refreshBtn = append(masterRow, $('button')) as HTMLButtonElement;
		refreshBtn.title = localize('aria.vcs.refreshTooltip', "Refresh");
		refreshBtn.style.padding = '2px 4px';
		refreshBtn.style.background = 'transparent';
		refreshBtn.style.color = 'var(--vscode-foreground)';
		refreshBtn.style.border = 'none';
		refreshBtn.style.borderRadius = '3px';
		refreshBtn.style.cursor = 'pointer';
		refreshBtn.style.flexShrink = '0';
		refreshBtn.style.display = 'inline-flex';
		refreshBtn.style.alignItems = 'center';
		// VS Code's standard refresh icon (codicon font ships with the workbench).
		const refreshIcon = append(refreshBtn, $('span.codicon.codicon-refresh'));
		refreshIcon.style.fontSize = '14px';
		refreshBtn.onclick = () => this.refresh();

		const updateMasterState = () => {
			const n = totalSelected();
			const allSelected = n === changes.length;
			masterCheckbox.checked = allSelected;
			masterCheckbox.indeterminate = n > 0 && n < changes.length;
			masterLabel.textContent = allSelected
				? localize('aria.vcs.deselectAll', "Deselect all")
				: localize('aria.vcs.selectAll', "Select all");
		};
		updateMasterState();

		const toggleAll = () => {
			const allSelected = totalSelected() === changes.length;
			if (allSelected) {
				this.selectedPaths = new Set();
				for (const { checkbox } of fileCheckboxes) {
					checkbox.checked = false;
				}
			} else {
				this.selectedPaths = undefined;
				for (const { checkbox } of fileCheckboxes) {
					checkbox.checked = true;
				}
			}
			updateMasterState();
			onSelectionChanged();
		};

		masterCheckbox.onclick = (e) => {
			e.stopPropagation();
			toggleAll();
		};
		masterLabel.onclick = (e) => {
			e.stopPropagation();
			toggleAll();
		};

		for (const change of changes) {
			const row = append(list, $('.aria-vcs-row')) as HTMLElement;

			const checkbox = append(row, $('input')) as HTMLInputElement;
			checkbox.type = 'checkbox';
			checkbox.checked = this.selectedPaths === undefined ? true : this.selectedPaths.has(change.path);
			checkbox.style.cursor = 'pointer';
			checkbox.style.flexShrink = '0';
			fileCheckboxes.push({ path: change.path, checkbox });
			checkbox.onclick = (e) => {
				e.stopPropagation();
				if (this.selectedPaths === undefined) {
					this.selectedPaths = new Set(changes.map(c => c.path));
				}
				if (checkbox.checked) {
					this.selectedPaths.add(change.path);
				} else {
					this.selectedPaths.delete(change.path);
				}
				onSelectionChanged();
				updateMasterState();
			};

			const { label, color } = markerFor(change.kind);
			const marker = append(row, $('span.aria-vcs-marker')) as HTMLElement;
			marker.textContent = label;
			marker.style.color = color;

			const fileNameSpan = append(row, $('span.aria-vcs-filename')) as HTMLElement;
			fileNameSpan.textContent = basename(change.path);
			fileNameSpan.title = change.path;  // full path on hover
			fileNameSpan.onclick = () => {
				void this.commandService.executeCommand('aria.vcs.openDiff', change.path);
			};

			if (change.additions !== undefined && change.deletions !== undefined) {
				const stats = append(row, $('span.aria-vcs-stats'));
				stats.textContent = `+${change.additions} −${change.deletions}`;
			}
		}
	}

	private renderEmpty(root: HTMLElement, text: string): void {
		const empty = append(root, $('p'));
		empty.style.opacity = '0.7';
		empty.style.fontSize = '13px';
		empty.textContent = text;
	}

}
