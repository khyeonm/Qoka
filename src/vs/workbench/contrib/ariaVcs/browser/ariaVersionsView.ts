/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IAction } from '../../../../base/common/actions.js';
import { IActionViewItem } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IDropdownMenuActionViewItemOptions } from '../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { IViewPaneOptions, ViewPane, ViewPaneShowActions } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { applyAriaScrollbar } from '../../aria/browser/ariaScrollbar.js';
import { createAriaHelpTitleActionViewItem } from '../../aria/browser/ariaHelpEditor.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { FileChange, Snapshot, SnapshotDraft, StatusInfo, basename, injectAriaVcsStyles, markerFor, onDidChangeSnapshots, notifySnapshotsChanged } from './ariaVcsCommon.js';

interface SnapshotGroup {
	groupId: string | undefined;
	members: Snapshot[];
}

/**
 * Versions view - the single view in the Versions container (Easy mode). Merges
 * what were two sub-panels (Changes + Snapshots) into one body so the container
 * shows just the "Versions" title, with no collapsible sub-headers. Top: the
 * unsaved-change list + Save. Bottom: the snapshot timeline + Go back.
 */
export class AriaVersionsView extends ViewPane {

	static readonly ID = 'workbench.view.aria.versions.main';

	/** Which region(s) this instance renders: 'both' = the classic merged view;
	 *  'changes' / 'snapshots' = a single region, so the Analysis tab can show them
	 *  as two separate collapsible toggles. Subclasses set this. */
	protected mode: 'both' | 'changes' | 'snapshots' = 'both';

	private viewBody: HTMLElement | undefined;
	/** Top region (summary + changes), scrolls independently. */
	private changesRegion: HTMLElement | undefined;
	/** Bottom region (snapshots), pinned to the bottom, scrolls independently. */
	private snapshotsRegion: HTMLElement | undefined;
	/** Fraction of the body height given to the Changes region - dragged via the
	 *  divider between the two sections. */
	private changesRatio = 0.48;

	// --- Changes state ---
	private selectedPaths: Set<string> | undefined;
	/** Number of unsaved changes in the last refresh (gates the title-bar Save). */
	private unsavedCount = 0;

	// --- Snapshots state ---
	private readonly expandedSnapshots = new Set<string>();
	/** Hash of the newest snapshot (= current version / HEAD). Going back to it is
	 *  a no-op, so we tell the user instead of silently doing nothing. */
	private newestHash: string | undefined;

	/** Guards against concurrent refreshes appending duplicate content. */
	private refreshToken = 0;
	/** Debounces the file-watcher so a burst of edits triggers one refresh. */
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => void this.refresh(), 400));
	/** Holds the workspace file watcher (re-created when the folder changes). */
	private readonly watcherStore = this._register(new DisposableStore());

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
		@IFileService private readonly fileService: IFileService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		// Keep the header actions (Changes: Save + Refresh, Snapshots: Refresh)
		// always visible instead of only on hover/focus, so the buttons are always
		// reachable in the Analysis tab.
		super({ ...options, showActions: ViewPaneShowActions.Always }, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		injectAriaVcsStyles();
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.refresh()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => { this.setupFileWatcher(); this.refresh(); }));
		this._register(onDidChangeSnapshots(() => this.refresh()));
		// Re-query when the tab becomes visible again (fixes the change list showing
		// up late, e.g. on macOS, and after switching away and back).
		this._register(this.onDidChangeBodyVisibility(visible => { if (visible) { void this.refresh(); } }));
		// Re-query (debounced) when files in the workspace change, so the unsaved
		// change list stays current without a manual refresh.
		this.setupFileWatcher();
	}

	override createActionViewItem(action: IAction, options?: IDropdownMenuActionViewItemOptions): IActionViewItem | undefined {
		return createAriaHelpTitleActionViewItem(action, 'versions', options ?? {})
			?? super.createActionViewItem(action, options);
	}

	/** Watch the workspace folder (minus noisy dirs) and refresh on file changes. */
	private setupFileWatcher(): void {
		this.watcherStore.clear();
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) { return; }
		try {
			this.watcherStore.add(this.fileService.watch(folder.uri, {
				recursive: true,
				excludes: ['**/.git/**', '**/node_modules/**', '**/.aria/**'],
			}));
			this.watcherStore.add(this.fileService.onDidFilesChange(e => {
				if (e.affects(folder.uri)) { this.refreshScheduler.schedule(); }
			}));
		} catch { /* best-effort - manual refresh still works */ }
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		// Flex column: Changes on top (scrolls, capped height), Snapshots pinned to
		// the bottom (fills the rest, scrolls). Left padding 8px matches the
		// "VERSIONS" pane-title (.not-collapsible .title { margin-left: 8px }).
		const root = append(container, $('div'));
		Object.assign(root.style, { display: 'flex', flexDirection: 'column', height: '100%', width: '100%', boxSizing: 'border-box', overflow: 'hidden' });
		this.viewBody = root;

		if (this.mode !== 'snapshots') {
			const changesRegion = append(root, $('.aria-vcs-scroll'));
			applyAriaScrollbar(changesRegion);
			// In 'both' mode the height is fixed (from `changesRatio`, dragged via the
			// divider); as its own toggle it just fills the view. Minimal top padding so
			// the change list sits right under the "CHANGES" title.
			Object.assign(changesRegion.style, { padding: '2px 8px 10px', overflowY: 'auto', boxSizing: 'border-box', flex: this.mode === 'both' ? '0 0 auto' : '1 1 auto' });
			this.changesRegion = changesRegion;
		}

		// Draggable divider between Changes (top) and Snapshots (bottom) - only in the
		// classic merged view.
		if (this.mode === 'both') {
			const divider = append(root, $('.aria-vcs-divider'));
			Object.assign(divider.style, {
				flex: '0 0 auto', height: '7px', cursor: 'ns-resize', boxSizing: 'border-box',
				borderTop: '1px solid rgba(127,127,127,0.25)',
			});
			this.installDividerDrag(divider);
		}

		if (this.mode !== 'changes') {
			const snapshotsRegion = append(root, $('.aria-vcs-scroll'));
			applyAriaScrollbar(snapshotsRegion);
			Object.assign(snapshotsRegion.style, { padding: '6px 8px 10px', overflowY: 'auto', boxSizing: 'border-box', flex: '1 1 auto' });
			this.snapshotsRegion = snapshotsRegion;
		}

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
		// Only the merged view splits the height between two regions; a single-region
		// toggle just fills its view.
		if (this.mode !== 'both') {
			return;
		}
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
		const primary = cReg ?? sReg;
		if (!primary) {
			return;
		}
		const token = ++this.refreshToken;

		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			if (cReg) { clearNode(cReg); }
			if (sReg) { clearNode(sReg); }
			this.renderInfo(primary, localize('aria.vcs.openFolder', "Open a folder to start saving snapshots."));
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

		if (cReg) { clearNode(cReg); }
		if (sReg) { clearNode(sReg); }
		if (cReg) {
			this.renderChangesArea(cReg, status, changes);
		}
		if (sReg) {
			this.renderSnapshotsArea(sReg, snapshots);
		}
	}

	// --- Changes area --------------------------------------------------------

	private renderChangesArea(root: HTMLElement, status: StatusInfo | undefined, changes: FileChange[]): void {
		// Save + Refresh live on the view's TITLE bar (next to "CHANGES"), so the body
		// is just the change list, pulled to the very top - no toolbar row, no blank.
		this.unsavedCount = (status && status.isRepo) ? status.unsavedChanges : 0;
		if (this.unsavedCount > 0) {
			this.renderChangesList(root, changes, () => { /* save is a title action; nothing to sync */ });
		}
	}

	/** Run the Save-snapshot flow (title-bar action): prepare, name it, save. */
	async saveSnapshotFlow(): Promise<void> {
		if (this.unsavedCount === 0) {
			this.notificationService.info(localize('aria.vcs.nothingToSave', "No changes to snapshot - everything is already saved."));
			return;
		}
		const paths = this.selectedPaths ? Array.from(this.selectedPaths) : undefined;
		if (paths && paths.length === 0) {
			this.notificationService.info(localize('aria.vcs.nothingSelected', "Select at least one changed file to snapshot."));
			return;
		}
		// Naming a snapshot asks the AI to read the diff, which can take a few
		// seconds. Kick it off immediately, then show a CENTER dialog (not a corner
		// toast) so the wait doesn't look like a hang - the user can keep working and
		// the Save dialog opens here once the name is ready.
		const draftPromise = Promise.resolve(this.commandService.executeCommand<SnapshotDraft>('aria.vcs.prepareSnapshot', paths))
			.then(d => d, () => undefined);
		await this.dialogService.info(
			localize('aria.vcs.namingTitle', "Qoka is reviewing your changes"),
			localize('aria.vcs.namingDetail', "It's suggesting a snapshot name from your code. This can take a moment - you can keep working, and the Save dialog will open here when it's ready."),
		);
		const draft = await draftPromise;
		const result = await this.showSaveDialog(draft?.suggestedTitle ?? '', draft?.previousTitle, draft?.continuation === true);
		if (!result) { return; }
		await this.commandService.executeCommand('aria.vcs.saveSnapshot', result.title, paths, result.group);
		this.selectedPaths = undefined;
		notifySnapshotsChanged();
	}

	/** Re-query the working tree (title-bar Refresh action). */
	refreshNow(): void {
		void this.refresh();
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

		const totalSelected = (): number => this.selectedPaths === undefined ? changes.length : this.selectedPaths.size;
		const fileCheckboxes: { path: string; checkbox: HTMLInputElement }[] = [];

		const masterRow = append(list, $('.aria-vcs-row')) as HTMLElement;
		const masterCheckbox = append(masterRow, $('input')) as HTMLInputElement;
		masterCheckbox.type = 'checkbox';
		masterCheckbox.style.cursor = 'pointer';
		masterCheckbox.style.flexShrink = '0';
		const masterLabel = append(masterRow, $('span')) as HTMLElement;
		Object.assign(masterLabel.style, { fontSize: '12px', opacity: '0.75', cursor: 'pointer', userSelect: 'none' });
		// Refresh now lives in the always-visible banner header (see renderChangesArea).

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

	/** Custom "name this snapshot" modal - a growing textarea so a long title is
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
		// No in-body heading: the "SNAPSHOTS" pane title already labels this section.
		// getRecent is newest-first, so snapshots[0] is the current version (HEAD).
		this.newestHash = snapshots[0]?.hash;

		if (snapshots.length === 0) {
			this.renderInfo(root, localize('aria.vcs.noSnapshots', "No snapshots yet - save your first one from Changes above."));
			return;
		}
		for (const group of this.groupSnapshots(snapshots)) {
			this.renderGroup(root, group);
		}
	}

	/** Roll the whole project back to a snapshot, after a confirm. The current state
	 *  is kept in history first, so it can be undone. */
	private async restoreToSnapshot(snapshot: Snapshot): Promise<void> {
		if (snapshot.hash === this.newestHash) {
			this.notificationService.info(localize('aria.vcs.alreadyLatest', "You're already at this version - pick an older snapshot to go back to."));
			return;
		}
		const when = new Date(snapshot.timestamp).toLocaleString();
		const { confirmed } = await this.dialogService.confirm({
			type: 'question',
			message: localize('aria.vcs.restoreConfirm', "Go back to \"{0}\"?", snapshot.message),
			detail: localize('aria.vcs.restoreDetail', "This restores every file to how it was in this snapshot ({0}). Your current state is saved to history first, so you can undo it.", when),
			primaryButton: localize('aria.vcs.goBackBtn', "Go back"),
		});
		if (!confirmed) { return; }
		try {
			await this.commandService.executeCommand('aria.vcs.restoreSnapshot', snapshot.hash);
		} finally {
			// A restore rewrites the working tree - refresh so Changes and the timeline update.
			notifySnapshotsChanged();
		}
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
		const isNewest = snapshot.hash === this.newestHash;
		const container = append(parent, $('div'));

		// Notebook-History-style row: a chevron (expands the changed files), the title
		// with the date/time beneath it, and a restore action at the right (on hover).
		const row = append(container, $('div'));
		Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 2px', borderRadius: '4px', cursor: 'pointer' });
		if (indent) { row.style.paddingLeft = '24px'; }
		row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.12))'; });
		row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });

		const chevron = append(row, $('span.codicon.codicon-chevron-right')) as HTMLElement;
		Object.assign(chevron.style, { fontSize: '13px', flexShrink: '0', opacity: '0.7' });

		const text = append(row, $('div'));
		Object.assign(text.style, { flex: '1', minWidth: '0' });
		const t1 = append(text, $('div'));
		t1.textContent = snapshot.message;
		t1.title = snapshot.message;
		Object.assign(t1.style, { fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
		const t2 = append(text, $('div'));
		t2.textContent = new Date(snapshot.timestamp).toLocaleString();
		Object.assign(t2.style, { fontSize: '10px', opacity: '0.6' });

		// The newest snapshot IS the current version - nothing to go back to. Every
		// other row shows an always-visible "go back" arrow pinned to the right, with
		// its own background so a long (ellipsised) title never runs under it.
		if (!isNewest) {
			const restore = append(row, $('span.codicon.codicon-discard')) as HTMLElement;
			restore.title = localize('aria.vcs.restoreThis', "Go back to this version");
			Object.assign(restore.style, {
				cursor: 'pointer', flexShrink: '0', fontSize: '13px', padding: '3px 5px', borderRadius: '4px',
				background: 'var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.2))',
				color: 'var(--vscode-foreground)',
			});
			restore.onmouseenter = () => { restore.style.background = 'var(--vscode-toolbar-activeBackground, rgba(127,127,127,0.35))'; };
			restore.onmouseleave = () => { restore.style.background = 'var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.2))'; };
			restore.onclick = (e) => { e.stopPropagation(); void this.restoreToSnapshot(snapshot); };
		}

		let details: HTMLElement | undefined;
		let loaded = false;
		const applyExpanded = (expanded: boolean): void => {
			chevron.classList.toggle('codicon-chevron-down', expanded);
			chevron.classList.toggle('codicon-chevron-right', !expanded);
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
		row.onclick = () => applyExpanded(!this.expandedSnapshots.has(snapshot.hash));
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

/** The "Changes" toggle in the Analysis tab: pending changes + Save snapshot. */
export class AriaChangesView extends AriaVersionsView {
	static override readonly ID = 'workbench.view.aria.changes.main';
	protected override mode: 'both' | 'changes' | 'snapshots' = 'changes';
}

/** The "Snapshots" toggle in the Analysis tab: the saved-version timeline + restore. */
export class AriaSnapshotsView extends AriaVersionsView {
	static override readonly ID = 'workbench.view.aria.snapshots.main';
	protected override mode: 'both' | 'changes' | 'snapshots' = 'snapshots';
}
