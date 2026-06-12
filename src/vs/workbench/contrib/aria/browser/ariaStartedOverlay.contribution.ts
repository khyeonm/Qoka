/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspacesService, IRecentlyOpened, isRecentFolder, isRecentWorkspace } from '../../../../platform/workspaces/common/workspaces.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { ARIA_MODE_SETTING, AriaMode } from '../common/ariaConfiguration.js';
import { ARIA_SET_MODE_COMMAND } from './ariaModeManager.js';

// Pre-paint workbench hide. Installing the stylesheet at module-load
// — before any contribution constructor runs — guarantees the bare
// workbench can't flash even momentarily between the workbench's own
// paint and our overlay's appendChild. The contribution constructor
// removes this style if it ever decides NOT to show the overlay
// (e.g. one-shot just-picked path), so the workbench becomes
// visible again immediately in that case.
(function installEarlyHide(): void {
	if (typeof document === 'undefined') {
		return;
	}
	if (document.getElementById('aria-started-hide-workbench')) {
		return;
	}
	const installNow = () => {
		if (document.getElementById('aria-started-hide-workbench')) {
			return;
		}
		const style = document.createElement('style');
		style.id = 'aria-started-hide-workbench';
		style.textContent = `
			body > *:not(#aria-started-overlay):not(style):not(script):not(link) {
				visibility: hidden !important;
			}
		`;
		(document.head || document.documentElement).appendChild(style);
	};
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', installNow, { once: true });
	} else {
		installNow();
	}
})();

/** One-shot sessionStorage flag set right before vscode.openFolder
 *  reloads the workbench, and consumed on the next constructor run
 *  (cleared on first read). Because it self-clears, it can never go
 *  stale and silently skip Started on a future launch — even if the
 *  storage backend persists across the electron app close, the first
 *  load consumes the flag and every subsequent load sees nothing. */
const JUST_PICKED_FLAG = 'aria.started.justPicked';

/** Legacy key from a previous attempt; cleared on startup so old
 *  installations don't keep a stale timestamp around. */
const RECENT_PICK_KEY = 'aria.started.recentPickAt';

/**
 * Aria's "Started" overlay — a full-viewport surface that locks the
 * workbench until the user picks a project. Replaces the previous
 * editor-pane approach so the sidebar, menu bar, terminal, and editor
 * tabs underneath are all blocked from interaction.
 *
 * Behaviour summary
 *  - Shows on workbench restore ONLY when no folder is loaded (EMPTY
 *    workspace). If a project is already open (restored from a previous
 *    session or launched from a CLI), the workbench is shown directly.
 *  - Setup (MCP registration, skill install, etc.) runs in the
 *    background while the overlay is up. The "Setting up Aria" loading
 *    overlay (firstRunOverlay) is intentionally skipped here — the
 *    Started overlay is the user-facing surface during setup.
 *  - When the user picks Open Project / a recent project, VS Code
 *    reloads the window with the new folder. In the new window:
 *      • Started overlay does not show (a folder is loaded now).
 *      • firstRunOverlay shows if setup is still tracking, and fades
 *        out when tracking completes.
 *  - New Project is a placeholder for the upcoming chat-driven flow;
 *    it surfaces an info notification and hides the overlay so the
 *    user is not trapped.
 */
class AriaStartedOverlayContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.startedOverlay';

	private overlay: HTMLDivElement | undefined;
	private hideWorkbenchStyle: HTMLStyleElement | undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IHostService private readonly hostService: IHostService,
	) {
		super();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ARIA_MODE_SETTING) && this.overlay) {
				this.rerender();
			}
		}));

		// Wipe legacy / stale skip markers so this build can never be
		// silently skipped because of state left over from an earlier
		// build's storage backend.
		try { sessionStorage.removeItem('aria.started.picked'); } catch { /* ignore */ }
		try { localStorage.removeItem(RECENT_PICK_KEY); } catch { /* ignore */ }

		// During the openFolder reload, the very next workbench load
		// must NOT re-show Started. We hand that off to a sessionStorage
		// flag that's set just before reload and cleared on first read
		// — so it's a one-shot, can't go stale, doesn't leak across
		// genuine app restarts (sessionStorage is per-window-session).
		try {
			if (sessionStorage.getItem(JUST_PICKED_FLAG) === '1') {
				sessionStorage.removeItem(JUST_PICKED_FLAG);
				// Module-load installed an early hide stylesheet to
				// prevent the workbench flash; on the skip path we
				// must take it down or the user stares at a blank
				// page while setup runs.
				this.removeEarlyHideStyleByID();
				return;
			}
		} catch { /* ignore */ }

		// Hide the workbench shell behind a stylesheet rule the moment
		// we know the overlay is coming up. Without this, the editor /
		// sidebar / status bar briefly flash between the workbench's
		// own paint and our overlay's appendChild. The rule covers
		// every body child except our overlay (and inert nodes like
		// <style>/<script>/<link>).
		this.installHideWorkbenchStyle();
		this.show();
	}


	private installHideWorkbenchStyle(): void {
		// Module-load already installed the stylesheet. We just take a
		// reference so removeHideWorkbenchStyle() has something to
		// clean up when the overlay is dismissed.
		if (this.hideWorkbenchStyle) {
			return;
		}
		const existing = document.getElementById('aria-started-hide-workbench');
		if (existing instanceof HTMLStyleElement) {
			this.hideWorkbenchStyle = existing;
			return;
		}
		// Fallback if early install somehow didn't run (e.g. document
		// wasn't yet ready). Install now.
		const style = document.createElement('style');
		style.id = 'aria-started-hide-workbench';
		style.textContent = `
			body > *:not(#aria-started-overlay):not(style):not(script):not(link) {
				visibility: hidden !important;
			}
		`;
		document.head.appendChild(style);
		this.hideWorkbenchStyle = style;
	}

	private removeHideWorkbenchStyle(): void {
		if (this.hideWorkbenchStyle) {
			this.hideWorkbenchStyle.remove();
			this.hideWorkbenchStyle = undefined;
		}
	}

	private removeEarlyHideStyleByID(): void {
		const existing = document.getElementById('aria-started-hide-workbench');
		if (existing) {
			existing.remove();
		}
		this.hideWorkbenchStyle = undefined;
	}

	/** Set the one-shot just-picked flag so the next workbench load
	 *  (the one triggered by vscode.openFolder) skips Started. The
	 *  flag is consumed-and-cleared on first read in the constructor
	 *  of that next load, so it cannot leak across genuine restarts. */
	private pickAndDismiss(action: () => void): void {
		try {
			sessionStorage.setItem(JUST_PICKED_FLAG, '1');
		} catch {
			// Storage can throw in restricted contexts; the overlay
			// still hides and the action still runs.
		}
		this.hide();
		action();
	}

	private show(): void {
		if (this.overlay) {
			return;
		}

		const overlay = document.createElement('div');
		overlay.id = 'aria-started-overlay';
		overlay.style.position = 'fixed';
		overlay.style.inset = '0';
		overlay.style.background = 'var(--vscode-editor-background, #1e1e1e)';
		overlay.style.color = 'var(--vscode-foreground, #cccccc)';
		// Higher than firstRunOverlay (999999) so loading never leaks through.
		overlay.style.zIndex = '1000000';
		overlay.style.overflow = 'auto';
		overlay.style.fontFamily = 'var(--vscode-font-family, system-ui, sans-serif)';

		this.installFocusTrap(overlay);

		document.body.appendChild(overlay);
		this.overlay = overlay;

		this.render();
	}

	private hide(): void {
		if (!this.overlay) {
			return;
		}
		this.overlay.remove();
		this.overlay = undefined;
		this.removeHideWorkbenchStyle();
	}

	private rerender(): void {
		if (!this.overlay) {
			return;
		}
		while (this.overlay.firstChild) {
			this.overlay.removeChild(this.overlay.firstChild);
		}
		this.render();
	}

	private render(): void {
		if (!this.overlay) {
			return;
		}

		const content = document.createElement('div');
		content.style.maxWidth = '900px';
		content.style.margin = '0 auto';
		content.style.padding = '60px 40px';
		this.overlay.appendChild(content);

		const mode = this.configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '';

		const title = document.createElement('h1');
		title.textContent = mode === 'easy'
			? 'Aria — Easy Mode'
			: mode === 'advanced'
				? 'Aria — Advanced Mode'
				: 'Welcome to Aria';
		title.style.fontSize = '32px';
		title.style.fontWeight = '300';
		title.style.margin = '0 0 8px 0';
		content.appendChild(title);

		const subtitle = document.createElement('p');
		subtitle.textContent = mode === ''
			? 'Choose a mode below, then pick or create a project to begin.'
			: 'Pick or create a project to begin.';
		subtitle.style.fontSize = '14px';
		subtitle.style.opacity = '0.7';
		subtitle.style.margin = '0 0 32px 0';
		content.appendChild(subtitle);

		this.renderModeSection(content, mode);
		this.renderStartSection(content);
		void this.renderRecentProjects(content);
	}

	private renderModeSection(parent: HTMLElement, currentMode: AriaMode): void {
		const heading = document.createElement('h2');
		heading.textContent = 'Mode';
		heading.style.fontSize = '16px';
		heading.style.fontWeight = '600';
		heading.style.margin = '0 0 12px 0';
		heading.style.opacity = '0.85';
		parent.appendChild(heading);

		const grid = document.createElement('div');
		grid.style.display = 'grid';
		grid.style.gridTemplateColumns = '1fr 1fr';
		grid.style.gap = '12px';
		grid.style.marginBottom = '12px';
		parent.appendChild(grid);

		const makeCard = (mode: 'easy' | 'advanced', icon: string, label: string, detail: string): void => {
			const card = document.createElement('button');
			card.style.display = 'flex';
			card.style.flexDirection = 'column';
			card.style.gap = '8px';
			card.style.padding = '16px 18px';
			card.style.border = '1px solid rgba(127, 127, 127, 0.2)';
			card.style.borderRadius = '6px';
			card.style.background = currentMode === mode
				? 'var(--vscode-button-background, rgba(0, 122, 204, 0.9))'
				: 'rgba(127, 127, 127, 0.06)';
			card.style.color = currentMode === mode
				? 'var(--vscode-button-foreground, #fff)'
				: 'var(--vscode-foreground, #cccccc)';
			card.style.cursor = 'pointer';
			card.style.fontFamily = 'inherit';
			card.style.textAlign = 'left';

			const head = document.createElement('div');
			head.style.display = 'flex';
			head.style.alignItems = 'center';
			head.style.gap = '8px';

			const iconEl = document.createElement('span');
			iconEl.textContent = icon;
			iconEl.style.fontSize = '20px';
			head.appendChild(iconEl);

			const titleEl = document.createElement('span');
			titleEl.textContent = label;
			titleEl.style.fontSize = '16px';
			titleEl.style.fontWeight = '600';
			titleEl.style.flex = '1';
			head.appendChild(titleEl);

			if (currentMode === mode) {
				const check = document.createElement('span');
				check.textContent = '✓';
				check.style.fontWeight = '700';
				head.appendChild(check);
			}

			card.appendChild(head);

			const detailEl = document.createElement('span');
			detailEl.textContent = detail;
			detailEl.style.fontSize = '13px';
			detailEl.style.opacity = '0.85';
			card.appendChild(detailEl);

			card.onclick = (e) => {
				e.stopPropagation();
				void this.commandService.executeCommand(ARIA_SET_MODE_COMMAND, mode);
			};

			grid.appendChild(card);
		};

		makeCard(
			'easy',
			'🌱',
			'Easy',
			'Simplified UI focused on chat and the research side panels.',
		);
		makeCard(
			'advanced',
			'⚙️',
			'Advanced',
			'Full IDE layout with drag-and-resize panels and every VS Code feature.',
		);
	}

	private renderStartSection(parent: HTMLElement): void {
		const heading = document.createElement('h2');
		heading.textContent = 'Start';
		heading.style.fontSize = '16px';
		heading.style.fontWeight = '600';
		heading.style.margin = '32px 0 12px 0';
		heading.style.opacity = '0.85';
		parent.appendChild(heading);

		const row = document.createElement('div');
		row.style.display = 'grid';
		row.style.gridTemplateColumns = '1fr 1fr';
		row.style.gap = '12px';
		row.style.marginBottom = '24px';
		parent.appendChild(row);

		const makeCard = (icon: string, label: string, detail: string, onclick: () => void): void => {
			const card = document.createElement('button');
			card.style.display = 'flex';
			card.style.flexDirection = 'column';
			card.style.gap = '6px';
			card.style.padding = '16px 18px';
			card.style.border = '1px solid rgba(127, 127, 127, 0.2)';
			card.style.borderRadius = '6px';
			card.style.background = 'rgba(127, 127, 127, 0.06)';
			card.style.color = 'var(--vscode-foreground, #cccccc)';
			card.style.cursor = 'pointer';
			card.style.fontFamily = 'inherit';
			card.style.textAlign = 'left';

			const iconEl = document.createElement('span');
			iconEl.textContent = icon;
			iconEl.style.fontSize = '22px';
			card.appendChild(iconEl);

			const titleEl = document.createElement('span');
			titleEl.textContent = label;
			titleEl.style.fontSize = '15px';
			titleEl.style.fontWeight = '600';
			card.appendChild(titleEl);

			const detailEl = document.createElement('span');
			detailEl.textContent = detail;
			detailEl.style.fontSize = '12.5px';
			detailEl.style.opacity = '0.75';
			card.appendChild(detailEl);

			card.onclick = (e) => {
				e.stopPropagation();
				onclick();
			};
			row.appendChild(card);
		};

		makeCard(
			'⊕',
			'New Project',
			'Start a fresh research project with AI guidance.',
			() => {
				// Chat-driven new-project flow not yet implemented. Surface
				// a note and dismiss the overlay so the user is not trapped.
				this.notificationService.notify({
					severity: Severity.Info,
					message: 'New Project flow is coming soon. For now, use Open Project to load an existing folder.',
				});
				this.pickAndDismiss(() => { /* no folder change */ });
			},
		);

		makeCard(
			'📁',
			'Open Project...',
			'Browse for a folder on your machine.',
			() => {
				// Use the file dialog service directly so the user always
				// sees the OS folder picker, not the recent-folder quick
				// pick that the `workbench.action.files.openFolder`
				// command opens in some VS Code variants.
				void this.openFolderPicker();
			},
		);
	}

	private async openFolderPicker(): Promise<void> {
		const result = await this.fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: 'Open Project',
			openLabel: 'Open',
		});
		if (!result || result.length === 0) {
			// User cancelled — keep the overlay up.
			return;
		}
		const folderUri = result[0];
		this.pickAndDismiss(() => {
			void this.hostService.openWindow([{ folderUri }], { forceReuseWindow: true });
		});
	}

	private async renderRecentProjects(parent: HTMLElement): Promise<void> {
		const heading = document.createElement('h3');
		heading.textContent = 'Recent projects';
		heading.style.fontSize = '14px';
		heading.style.fontWeight = '600';
		heading.style.margin = '0 0 8px 0';
		heading.style.opacity = '0.8';
		parent.appendChild(heading);

		let recents: IRecentlyOpened;
		try {
			recents = await this.workspacesService.getRecentlyOpened();
		} catch {
			return;
		}

		const all = recents.workspaces;
		if (all.length === 0) {
			const empty = document.createElement('p');
			empty.textContent = 'No recent projects yet.';
			empty.style.opacity = '0.5';
			empty.style.fontSize = '13px';
			empty.style.padding = '6px 12px';
			parent.appendChild(empty);
			return;
		}

		const VISIBLE_LIMIT = 5;
		const items = all.slice(0, VISIBLE_LIMIT);

		const list = document.createElement('div');
		list.style.display = 'flex';
		list.style.flexDirection = 'column';
		list.style.gap = '2px';
		parent.appendChild(list);

		for (const item of items) {
			const uri: URI | undefined = isRecentFolder(item)
				? item.folderUri
				: isRecentWorkspace(item)
					? item.workspace.configPath
					: undefined;
			if (!uri) {
				continue;
			}
			const name = basename(uri) || uri.fsPath;
			const path = uri.fsPath;

			const btn = document.createElement('button');
			btn.style.display = 'flex';
			btn.style.alignItems = 'center';
			btn.style.gap = '10px';
			btn.style.padding = '8px 12px';
			btn.style.background = 'transparent';
			btn.style.border = 'none';
			btn.style.color = 'var(--vscode-foreground, #cccccc)';
			btn.style.cursor = 'pointer';
			btn.style.fontFamily = 'inherit';
			btn.style.fontSize = '13px';
			btn.style.textAlign = 'left';
			btn.style.borderRadius = '4px';

			const folder = document.createElement('span');
			folder.textContent = '📁';
			btn.appendChild(folder);

			const nameEl = document.createElement('span');
			nameEl.textContent = name;
			nameEl.style.fontWeight = '500';
			btn.appendChild(nameEl);

			const pathEl = document.createElement('span');
			pathEl.textContent = path;
			pathEl.style.opacity = '0.55';
			pathEl.style.fontSize = '12px';
			pathEl.style.marginLeft = '6px';
			pathEl.style.overflow = 'hidden';
			pathEl.style.textOverflow = 'ellipsis';
			pathEl.style.whiteSpace = 'nowrap';
			btn.appendChild(pathEl);

			btn.title = path;
			btn.onclick = (e) => {
				e.stopPropagation();
				this.pickAndDismiss(() => {
					void this.hostService.openWindow([{ folderUri: uri }], { forceReuseWindow: true });
				});
			};

			list.appendChild(btn);
		}

		if (all.length > VISIBLE_LIMIT) {
			const more = document.createElement('button');
			more.textContent = 'Show more...';
			more.style.background = 'transparent';
			more.style.border = 'none';
			more.style.color = 'var(--vscode-textLink-foreground, #3794ff)';
			more.style.cursor = 'pointer';
			more.style.fontFamily = 'inherit';
			more.style.fontSize = '12.5px';
			more.style.textAlign = 'left';
			more.style.padding = '8px 12px';
			more.style.marginTop = '4px';
			more.style.borderRadius = '4px';
			more.onclick = (e) => {
				e.stopPropagation();
				this.pickAndDismiss(() => {
					void this.commandService.executeCommand('workbench.action.openRecent');
				});
			};
			list.appendChild(more);
		}
	}

	private installFocusTrap(overlay: HTMLDivElement): void {
		const swallow = (e: Event) => {
			// Inside the overlay → normal click/key handling.
			if (overlay.contains(e.target as Node)) {
				return;
			}
			// Block anything that leaks past the overlay.
			e.stopPropagation();
			e.preventDefault();
		};
		overlay.addEventListener('keydown', swallow, true);
		overlay.addEventListener('click', swallow, true);
	}
}

// Register at `Restored` — the same phase firstRunOverlay uses and
// is known to fully resolve every service we inject. Earlier phases
// (`Starting`, `Ready`) silently dropped the contribution because
// IWorkspacesService / IFileDialogService were not yet instantiated.
// The flash that previously made Restored unusable is now prevented
// by the early hide-workbench stylesheet installed at module-load
// time above — so we get late-but-reliable construction without the
// bare-workbench flicker.
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaStartedOverlayContribution, LifecyclePhase.Restored);
