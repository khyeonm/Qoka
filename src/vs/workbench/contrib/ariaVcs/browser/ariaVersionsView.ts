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
import { applyAriaScrollbar } from '../../aria/browser/ariaScrollbar.js';
import { renderAriaTabSummary } from '../../aria/browser/ariaHelpEditor.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { FileChange, Snapshot, SnapshotDraft, StatusInfo, basename, formatRelativeTime, injectAriaVcsStyles, markerFor, onDidChangeSnapshots, notifySnapshotsChanged } from './ariaVcsCommon.js';

interface SnapshotGroup {
	groupId: string | undefined;
	members: Snapshot[];
}

/**
 * Versions view — the single view in the Versions container (Easy mode). Merges
 * what were two sub-panels (Changes + Snapshots) into one body so the container
 * shows just the "Versions" title, with no collapsible sub-headers. Top: the
 * unsaved-change list + Save. Bottom: the snapshot timeline + Go back.
 */
export class AriaVersionsView extends ViewPane {

	static readonly ID = 'workbench.view.aria.versions.main';

	private viewBody: HTMLElement | undefined;
	/** Top region (summary + changes), scrolls independently. */
	private changesRegion: HTMLElement | undefined;
	/** Bottom region (snapshots), pinned to the bottom, scrolls independently. */
	private snapshotsRegion: HTMLElement | undefined;
	/** Fraction of the body height given to the Changes region — dragged via the
	 *  divider between the two sections. */
	private changesRatio = 0.48;

	// --- Changes state ---
	private selectedPaths: Set<string> | undefined;

	// --- Snapshots state ---
	private readonly expandedSnapshots = new Set<string>();
	private selectedHash: string | undefined;
	private checkboxes: { hash: string; el: HTMLInputElement }[] = [];
	private goBackBtn: HTMLButtonElement | undefined;
	private goingBack = false;
	/** Hash of the newest snapshot (= current version / HEAD). Going back to it is
	 *  a no-op, so we tell the user instead of silently doing nothing. */
	private newestHash: string | undefined;

	/** Guards against concurrent refreshes appending duplicate content. */
	private refreshToken = 0;

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
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		injectAriaVcsStyles();
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.refresh()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.refresh()));
		this._register(onDidChangeSnapshots(() => this.refresh()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		// Flex column: Changes on top (scrolls, capped height), Snapshots pinned to
		// the bottom (fills the rest, scrolls). Left padding 8px matches the
		// "VERSIONS" pane-title (.not-collapsible .title { margin-left: 8px }).
		const root = append(container, $('div'));
		Object.assign(root.style, { display: 'flex', flexDirection: 'column', height: '100%', width: '100%', boxSizing: 'border-box', overflow: 'hidden' });
		this.viewBody = root;

		const changesRegion = append(root, $('.aria-vcs-scroll'));
		applyAriaScrollbar(changesRegion);
		// Fixed height (set from `changesRatio` in layoutBody); the user drags the
		// divider below to change the split.
		Object.assign(changesRegion.style, { padding: '10px 8px', overflowY: 'auto', boxSizing: 'border-box', flex: '0 0 auto' });
		this.changesRegion = changesRegion;

		// Draggable divider between Changes (top) and Snapshots (bottom).
		const divider = append(root, $('.aria-vcs-divider'));
		Object.assign(divider.style, {
			flex: '0 0 auto', height: '7px', cursor: 'ns-resize', boxSizing: 'border-box',
			borderTop: '1px solid rgba(127,127,127,0.25)',
		});
		this.installDividerDrag(divider);

		const snapshotsRegion = append(root, $('.aria-vcs-scroll'));
		applyAriaScrollbar(snapshotsRegion);
		Object.assign(snapshotsRegion.style, { padding: '6px 8px 10px', overflowY: 'auto', boxSizing: 'border-box', flex: '1 1 auto' });
		this.snapshotsRegion = snapshotsRegion;

		this.applyChangesHeight();
		this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.viewBody) {
			this.viewBody.style.height = `${height}px`;
			this.viewBody.style.width = `${width}px`;
		}
		this.applyChangesHeight();
	}

	/** Apply the current Changes/Snapshots split ratio to the Changes region. */
	private applyChangesHeight(): void {
		const body = this.viewBody;
		const region = this.changesRegion;
		if (!body || !region) {
			return;
		}
		const h = body.clientHeight;
		if (h > 0) {
			region.style.height = `${Math.round(this.changesRatio * h)}px`;
		}
	}

	/** Let the user drag the divider to resize the Changes vs Snapshots split. */
	private installDividerDrag(divider: HTMLElement): void {
		divider.addEventListener('mousedown', (e: MouseEvent) => {
			e.preventDefault();
			const body = this.viewBody;
			if (!body) {
				return;
			}
			const doc = divider.ownerDocument;
			const prevUserSelect = body.style.userSelect;
			body.style.userSelect = 'none';
			const onMove = (ev: MouseEvent): void => {
				const rect = body.getBoundingClientRect();
				if (rect.height <= 0) {
					return;
				}
				const ratio = (ev.clientY - rect.top) / rect.height;
				this.changesRatio = Math.min(0.85, Math.max(0.15, ratio));
				this.applyChangesHeight();
			};
			const onUp = (): void => {
				body.style.userSelect = prevUserSelect;
				doc.removeEventListener('mousemove', onMove);
				doc.removeEventListener('mouseup', onUp);
			};
			doc.addEventListener('mousemove', onMove);
			doc.addEventListener('mouseup', onUp);
		});
	}

	/** Fetch everything, then (only for the latest call) clear + render both
	 *  areas. Selection changes update in place and do NOT call this. */
	private async refresh(): Promise<void> {
		const cReg = this.changesRegion;
		const sReg = this.snapshotsRegion;
		if (!cReg || !sReg) {
			return;
		}
		const token = ++this.refreshToken;

		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			clearNode(cReg);
			clearNode(sReg);
			this.checkboxes = [];
			renderAriaTabSummary(cReg, 'versions');
			this.renderInfo(cReg, localize('aria.vcs.openFolder', "Open a folder to start saving snapshots."));
			return;
		}

		let status: StatusInfo | undefined;
		let changes: FileChange[] = [];
		let snapshots: Snapshot[] = [];
		try {
			[status, changes, snapshots] = await Promise.all([
				this.commandService.executeCommand<StatusInfo>('aria.vcs.getStatus'),
				this.commandService.executeCommand<FileChange[]>('aria.vcs.getChanges').then(c => c ?? []),
				this.commandService.executeCommand<Snapshot[]>('aria.vcs.getRecent', 50).then(s => s ?? []),
			]);
		} catch {
			// leave defaults
		}
		if (token !== this.refreshToken) {
			return; // a newer refresh owns the render
		}

		clearNode(cReg);
		clearNode(sReg);
		this.checkboxes = [];
		renderAriaTabSummary(cReg, 'versions');
		this.renderChangesArea(cReg, status, changes);
		this.renderSnapshotsArea(sReg, snapshots);
	}

	// --- Changes area --------------------------------------------------------

	private renderChangesArea(root: HTMLElement, status: StatusInfo | undefined, changes: FileChange[]): void {
		const banner = append(root, $('div'));
		Object.assign(banner.style, {
			padding: '8px 10px', marginBottom: '6px', borderRadius: '4px',
			background: 'var(--vscode-editorWidget-background)',
			border: '1px solid var(--vscode-widget-border, transparent)',
		});

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
		Object.assign(saveBtn.style, {
			width: '100%', padding: '6px 10px', fontSize: '12px', cursor: 'pointer',
			background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
			border: 'none', borderRadius: '4px', fontWeight: '500',
		});

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
			const savedLabel = saveBtn.textContent;
			const savedBanner = bannerText.textContent;
			saveBtn.disabled = true;
			saveBtn.style.opacity = '0.7';
			saveBtn.style.cursor = 'progress';
			saveBtn.textContent = localize('aria.vcs.preparing', "Preparing snapshot…");
			bannerText.textContent = localize('aria.vcs.preparingHint', "This can take a moment — keep working. The naming box opens when it's ready.");
			let draft: SnapshotDraft | undefined;
			try {
				draft = await this.commandService.executeCommand<SnapshotDraft>('aria.vcs.prepareSnapshot', paths);
			} catch {
				draft = undefined;
			}
			saveBtn.disabled = false;
			saveBtn.style.opacity = '1';
			saveBtn.style.cursor = 'pointer';
			saveBtn.textContent = savedLabel;
			bannerText.textContent = savedBanner;

			const result = await this.showSaveDialog(draft?.suggestedTitle ?? '', draft?.previousTitle, draft?.continuation === true);
			if (!result) {
				return;
			}
			await this.commandService.executeCommand('aria.vcs.saveSnapshot', result.title, paths, result.group);
			this.selectedPaths = undefined;
			notifySnapshotsChanged();
		};

		if (status && status.isRepo && status.unsavedChanges > 0) {
			this.renderChangesList(root, changes, updateSaveLabel);
		}
	}

	private renderChangesList(parent: HTMLElement, changes: FileChange[], onSelectionChanged: () => void): void {
		if (changes.length === 0) {
			return;
		}
		if (this.selectedPaths) {
			const visible = new Set(changes.map(c => c.path));
			for (const p of Array.from(this.selectedPaths)) {
				if (!visible.has(p)) { this.selectedPaths.delete(p); }
			}
		}

		const list = append(parent, $('div'));
		list.style.marginTop = '4px';

		const totalSelected = (): number => this.selectedPaths === undefined ? changes.length : this.selectedPaths.size;
		const fileCheckboxes: { path: string; checkbox: HTMLInputElement }[] = [];

		const masterRow = append(list, $('.aria-vcs-row')) as HTMLElement;
		const masterCheckbox = append(masterRow, $('input')) as HTMLInputElement;
		masterCheckbox.type = 'checkbox';
		masterCheckbox.style.cursor = 'pointer';
		masterCheckbox.style.flexShrink = '0';
		const masterLabel = append(masterRow, $('span')) as HTMLElement;
		Object.assign(masterLabel.style, { fontSize: '12px', opacity: '0.75', cursor: 'pointer', userSelect: 'none' });
		const spacer = append(masterRow, $('div'));
		spacer.style.flex = '1';
		const refreshBtn = append(masterRow, $('button')) as HTMLButtonElement;
		refreshBtn.title = localize('aria.vcs.refreshTooltip', "Refresh");
		Object.assign(refreshBtn.style, { padding: '2px 4px', background: 'transparent', color: 'var(--vscode-foreground)', border: 'none', borderRadius: '3px', cursor: 'pointer', flexShrink: '0', display: 'inline-flex', alignItems: 'center' });
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
				for (const { checkbox } of fileCheckboxes) { checkbox.checked = false; }
			} else {
				this.selectedPaths = undefined;
				for (const { checkbox } of fileCheckboxes) { checkbox.checked = true; }
			}
			updateMasterState();
			onSelectionChanged();
		};
		masterCheckbox.onclick = (e) => { e.stopPropagation(); toggleAll(); };
		masterLabel.onclick = (e) => { e.stopPropagation(); toggleAll(); };

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
				if (this.selectedPaths === undefined) { this.selectedPaths = new Set(changes.map(c => c.path)); }
				if (checkbox.checked) { this.selectedPaths.add(change.path); } else { this.selectedPaths.delete(change.path); }
				onSelectionChanged();
				updateMasterState();
			};

			const { label, color } = markerFor(change.kind);
			const marker = append(row, $('span.aria-vcs-marker')) as HTMLElement;
			marker.textContent = label;
			marker.style.color = color;

			const fileNameSpan = append(row, $('span.aria-vcs-filename')) as HTMLElement;
			fileNameSpan.textContent = basename(change.path);
			fileNameSpan.title = change.path;
			fileNameSpan.onclick = () => { void this.commandService.executeCommand('aria.vcs.openDiff', change.path); };

			if (change.additions !== undefined && change.deletions !== undefined) {
				const stats = append(row, $('span.aria-vcs-stats'));
				stats.textContent = `+${change.additions} −${change.deletions}`;
			}
		}
	}

	/** Custom "name this snapshot" modal — a growing textarea so a long title is
	 *  fully visible, plus a "merge with previous" checkbox. */
	private showSaveDialog(suggested: string, previousTitle: string | undefined, groupDefault: boolean): Promise<{ title: string; group: boolean } | undefined> {
		return new Promise(resolve => {
			const backdrop = document.createElement('div');
			Object.assign(backdrop.style, {
				position: 'fixed', inset: '0', zIndex: '100000',
				display: 'flex', alignItems: 'center', justifyContent: 'center',
				background: 'rgba(0, 0, 0, 0.45)',
			});

			const panel = document.createElement('div');
			Object.assign(panel.style, {
				width: '380px', maxWidth: '90vw', boxSizing: 'border-box',
				background: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))',
				color: 'var(--vscode-foreground)',
				border: '1px solid var(--vscode-widget-border, rgba(127,127,127,0.35))',
				borderRadius: '8px', padding: '18px', boxShadow: '0 4px 18px rgba(0,0,0,0.4)',
				fontFamily: 'var(--vscode-font-family, sans-serif)', fontSize: '13px',
			});
			backdrop.appendChild(panel);

			const heading = append(panel, $('div'));
			heading.textContent = localize('aria.vcs.saveDialogMessage', "Name this snapshot");
			Object.assign(heading.style, { fontSize: '14px', fontWeight: '600', marginBottom: '10px' });

			const ta = append(panel, $('textarea')) as HTMLTextAreaElement;
			ta.value = suggested;
			ta.rows = 1;
			ta.placeholder = localize('aria.vcs.saveDialogPlaceholder', "What changed?");
			Object.assign(ta.style, {
				width: '100%', boxSizing: 'border-box', resize: 'none', overflow: 'hidden',
				padding: '7px 9px', fontSize: '13px', lineHeight: '1.4', fontFamily: 'inherit',
				background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
				border: '1px solid var(--vscode-input-border, transparent)', borderRadius: '5px',
			});
			const autoGrow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; };
			ta.oninput = autoGrow;

			let group = groupDefault;
			if (previousTitle) {
				const row = append(panel, $('label')) as HTMLElement;
				Object.assign(row.style, { display: 'flex', alignItems: 'flex-start', gap: '8px', marginTop: '12px', fontSize: '12.5px', cursor: 'pointer' });
				const cb = append(row, $('input')) as HTMLInputElement;
				cb.type = 'checkbox';
				cb.checked = groupDefault;
				cb.style.marginTop = '2px';
				cb.style.flexShrink = '0';
				cb.onchange = () => { group = cb.checked; };
				const lbl = append(row, $('span'));
				lbl.style.whiteSpace = 'pre-line';
				lbl.textContent = localize('aria.vcs.mergePrevious', "Merge with the previous snapshot\n({0})", previousTitle);
			}

			const btns = append(panel, $('div'));
			Object.assign(btns.style, { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' });

			const finish = (result: { title: string; group: boolean } | undefined) => {
				document.removeEventListener('keydown', onKey, true);
				backdrop.remove();
				resolve(result);
			};
			const doSave = () => finish({ title: ta.value.trim() || suggested.trim() || 'Snapshot', group });
			const onKey = (e: KeyboardEvent) => {
				if (e.key === 'Escape') { e.preventDefault(); finish(undefined); }
				else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSave(); }
			};

			btns.appendChild(this.dialogButton(localize('aria.vcs.cancel', "Cancel"), false, () => finish(undefined)));
			btns.appendChild(this.dialogButton(localize('aria.vcs.saveDialogPrimary', "Save"), true, doSave));

			document.body.appendChild(backdrop);
			document.addEventListener('keydown', onKey, true);
			autoGrow();
			ta.focus();
			ta.select();
		});
	}

	private dialogButton(text: string, primary: boolean, onclick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.textContent = text;
		Object.assign(btn.style, { padding: '6px 14px', fontSize: '12.5px', borderRadius: '4px', cursor: 'pointer', font: 'inherit' });
		if (primary) {
			Object.assign(btn.style, { background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: '1px solid transparent' });
		} else {
			Object.assign(btn.style, { background: 'transparent', color: 'var(--vscode-foreground)', border: '1px solid rgba(127,127,127,0.5)' });
		}
		btn.onclick = onclick;
		return btn;
	}

	// --- Snapshots area ------------------------------------------------------

	private renderSnapshotsArea(root: HTMLElement, snapshots: Snapshot[]): void {
		const divider = append(root, $('div'));
		// Down-arrow marks the bottom-pinned Snapshots section. Uppercase, small,
		// non-bold, muted — matching the "VERSIONS" pane title's treatment.
		divider.textContent = '▾ ' + localize('aria.vcs.snapshotsHeading', "Snapshots");
		Object.assign(divider.style, {
			margin: '2px 0 8px', fontSize: '11px', fontWeight: 'normal',
			textTransform: 'uppercase', letterSpacing: '0.6px', opacity: '0.6',
		});

		const btn = append(root, $('button')) as HTMLButtonElement;
		btn.textContent = localize('aria.vcs.goBack', "Go back to this version");
		Object.assign(btn.style, { width: '100%', padding: '6px 10px', marginBottom: '10px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--vscode-button-border, transparent)' });
		btn.onclick = () => void this.goBackToSelected();
		this.goBackBtn = btn;

		// getRecent is newest-first, so snapshots[0] is the current version (HEAD).
		this.newestHash = snapshots[0]?.hash;

		// Drop a selection whose snapshot vanished (e.g. after a go-back).
		if (this.selectedHash && !snapshots.some(s => s.hash === this.selectedHash)) {
			this.selectedHash = undefined;
		}

		const list = append(root, $('div'));
		if (snapshots.length === 0) {
			this.renderInfo(list, localize('aria.vcs.noSnapshots', "No snapshots yet — save your first one above."));
		} else {
			for (const group of this.groupSnapshots(snapshots)) {
				this.renderGroup(list, group);
			}
		}
		this.updateGoBackButton();
	}

	private updateGoBackButton(): void {
		const btn = this.goBackBtn;
		if (!btn || this.goingBack) {
			return;
		}
		const on = !!this.selectedHash;
		btn.textContent = localize('aria.vcs.goBack', "Go back to this version");
		btn.disabled = !on;
		btn.style.cursor = on ? 'pointer' : 'not-allowed';
		btn.style.opacity = on ? '1' : '0.5';
		btn.style.background = on ? 'var(--vscode-button-background)' : 'transparent';
		btn.style.color = on ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)';
	}

	async goBackToSelected(): Promise<void> {
		const hash = this.selectedHash;
		if (!hash || this.goingBack) {
			return;
		}
		// Going back to the newest snapshot (= current version) does nothing —
		// there's nothing after it to undo. Tell the user instead of a silent no-op.
		if (hash === this.newestHash) {
			this.notificationService.info(localize('aria.vcs.alreadyLatest', "You're already at this version — pick an older snapshot to go back to."));
			return;
		}
		this.goingBack = true;
		const btn = this.goBackBtn;
		if (btn) {
			btn.disabled = true;
			btn.style.cursor = 'progress';
			btn.style.opacity = '1';
			btn.textContent = localize('aria.vcs.goingBack', "Going back…");
		}
		try {
			await this.commandService.executeCommand('aria.vcs.restoreSnapshot', hash);
		} finally {
			this.goingBack = false;
			this.updateGoBackButton();
		}
		// A restore rewrites the working tree — refresh so the Changes list shows
		// the undone changes and the timeline updates.
		notifySnapshotsChanged();
	}

	private setSelected(hash: string | undefined): void {
		this.selectedHash = hash;
		for (const { hash: h, el } of this.checkboxes) {
			el.checked = h === hash;
		}
		this.updateGoBackButton();
	}

	private groupSnapshots(snapshots: Snapshot[]): SnapshotGroup[] {
		const groups: SnapshotGroup[] = [];
		for (const s of snapshots) {
			const last = groups[groups.length - 1];
			if (last && s.groupId && last.groupId === s.groupId) {
				last.members.push(s);
			} else {
				groups.push({ groupId: s.groupId, members: [s] });
			}
		}
		return groups;
	}

	private renderGroup(parent: HTMLElement, group: SnapshotGroup): void {
		if (group.members.length === 1) {
			this.renderSnapshotRow(parent, group.members[0], false);
			return;
		}
		const latest = group.members[0];
		const heading = append(parent, $('.aria-vcs-row')) as HTMLElement;
		heading.style.cursor = 'default';
		const title = append(heading, $('span'));
		Object.assign(title.style, { flex: '1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
		title.textContent = latest.message;
		title.title = latest.message;
		const count = append(heading, $('span'));
		Object.assign(count.style, { opacity: '0.6', fontSize: '11px', flexShrink: '0' });
		count.textContent = localize('aria.vcs.groupCount', "{0} saves", group.members.length);

		for (const m of group.members) {
			this.renderSnapshotRow(parent, m, true);
		}
	}

	private renderSnapshotRow(parent: HTMLElement, snapshot: Snapshot, indent: boolean): void {
		const container = append(parent, $('div'));
		const row = append(container, $('.aria-vcs-row')) as HTMLElement;
		if (indent) { row.style.paddingLeft = '24px'; }

		// The newest snapshot IS the current version — going back to it is a no-op,
		// so its checkbox is disabled and greyed (not selectable).
		const isNewest = snapshot.hash === this.newestHash;
		const cb = append(row, $('input')) as HTMLInputElement;
		cb.type = 'checkbox';
		cb.style.flexShrink = '0';
		if (isNewest) {
			cb.disabled = true;
			cb.checked = false;
			cb.style.opacity = '0.45';
			cb.style.cursor = 'not-allowed';
			cb.title = localize('aria.vcs.currentVersion', "Current version");
		} else {
			cb.checked = this.selectedHash === snapshot.hash;
			cb.onclick = (e) => {
				e.stopPropagation();
				this.setSelected(this.selectedHash === snapshot.hash ? undefined : snapshot.hash);
			};
			this.checkboxes.push({ hash: snapshot.hash, el: cb });
		}

		const time = append(row, $('span'));
		Object.assign(time.style, { opacity: '0.6', fontSize: '11px', minWidth: '62px', flexShrink: '0' });
		time.textContent = formatRelativeTime(snapshot.timestamp);

		const message = append(row, $('span'));
		Object.assign(message.style, { flex: '1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer' });
		message.textContent = snapshot.message;
		message.title = snapshot.message;

		let details: HTMLElement | undefined;
		let loaded = false;
		const applyExpanded = (expanded: boolean): void => {
			if (expanded) {
				this.expandedSnapshots.add(snapshot.hash);
				if (!details) {
					details = append(container, $('div'));
					details.style.padding = '2px 8px 6px ' + (indent ? '46px' : '28px');
					details.style.fontSize = '12px';
				}
				details.style.display = 'block';
				if (!loaded) {
					loaded = true;
					void this.renderSnapshotFiles(details, snapshot);
				}
			} else {
				this.expandedSnapshots.delete(snapshot.hash);
				if (details) { details.style.display = 'none'; }
			}
		};
		applyExpanded(this.expandedSnapshots.has(snapshot.hash));
		message.onclick = () => applyExpanded(!this.expandedSnapshots.has(snapshot.hash));
	}

	private async renderSnapshotFiles(details: HTMLElement, snapshot: Snapshot): Promise<void> {
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
			nameSpan.onclick = () => { void this.commandService.executeCommand('aria.vcs.openSnapshotDiff', snapshot.hash, file.path); };
			if (file.additions !== undefined && file.deletions !== undefined) {
				const stats = append(row, $('span.aria-vcs-stats'));
				stats.textContent = `+${file.additions} −${file.deletions}`;
			}
		}
	}

	private renderInfo(root: HTMLElement, text: string): void {
		const p = append(root, $('p'));
		p.style.opacity = '0.7';
		p.style.fontSize = '13px';
		p.textContent = text;
	}
}
