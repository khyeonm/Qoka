/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ARIA_MODE_SETTING, AriaMode, AriaModeContextKey } from '../common/ariaConfiguration.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { localize } from '../../../../nls.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';

// In easy mode the bottom panel (Terminal / Problems / Output …) is removed as
// developer tooling, so its toggle shortcut Ctrl+` should do nothing instead of
// popping an empty panel. A higher-weight no-op wins over the terminal toggle
// only while `aria.mode == easy`; advanced mode keeps the default behaviour.
KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: 'aria.easyMode.suppressTerminalToggle',
	weight: KeybindingWeight.WorkbenchContrib + 50,
	when: AriaModeContextKey.isEqualTo('easy'),
	primary: KeyMod.CtrlCmd | KeyCode.Backquote,
	mac: { primary: KeyMod.WinCtrl | KeyCode.Backquote },
	handler: () => { /* no-op: easy mode has no bottom panel */ },
});
// Note: ARIA_SWITCH_MODE_COMMAND keeps the original toggle-with-confirm semantics
// for legacy callers; the new segmented status bar uses ARIA_SET_MODE_COMMAND
// for instant, no-confirm switching.

/** The built-in light theme easy mode switches to for its white background. */
const ARIA_EASY_LIGHT_THEME = 'Light Modern';
/** Storage key holding the user's theme while easy mode overrides it. */
const PREV_COLOR_THEME_KEY = 'aria.prevColorTheme';

/** Storage key holding a `{ [folderKey]: mode }` map so each project reopens in
 *  the mode it was last used with (aria.mode itself is a single global value,
 *  so we remember per folder here and re-apply it when that folder opens). */
const PER_FOLDER_MODE_KEY = 'aria.mode.perFolder';

/** Stable key for the open project (the multi-root .code-workspace file, else
 *  the single folder URI). Undefined for an EMPTY workbench (no project). */
function folderModeKey(contextService: IWorkspaceContextService): string | undefined {
	if (contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
		return undefined;
	}
	const ws = contextService.getWorkspace();
	return ws.configuration?.toString() ?? ws.folders[0]?.uri.toString();
}

function readPerFolderModes(storageService: IStorageService): Record<string, AriaMode> {
	try {
		const raw = storageService.get(PER_FOLDER_MODE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed as Record<string, AriaMode> : {};
	} catch {
		return {};
	}
}

/** Remember `mode` for the currently-open project. No-op for an EMPTY workbench
 *  or an unset mode (we only record explicit easy/advanced choices). */
function savePerFolderMode(storageService: IStorageService, contextService: IWorkspaceContextService, mode: AriaMode): void {
	const key = folderModeKey(contextService);
	if (!key || (mode !== 'easy' && mode !== 'advanced')) {
		return;
	}
	const map = readPerFolderModes(storageService);
	map[key] = mode;
	try {
		storageService.store(PER_FOLDER_MODE_KEY, JSON.stringify(map), StorageScope.APPLICATION, StorageTarget.MACHINE);
	} catch {
		// Storage unavailable - per-folder memory just won't persist; harmless.
	}
}

/** Relative luminance (0..1) of a `#rrggbb` or `rgb()/rgba()` color, or undefined. */
function parseLuminance(color: string): number | undefined {
	let r: number, g: number, b: number;
	const rgb = color.match(/rgba?\(([^)]+)\)/);
	if (rgb) {
		const parts = rgb[1].split(',').map(s => parseFloat(s));
		[r, g, b] = parts;
	} else if (color.startsWith('#') && color.length >= 7) {
		r = parseInt(color.slice(1, 3), 16);
		g = parseInt(color.slice(3, 5), 16);
		b = parseInt(color.slice(5, 7), 16);
	} else {
		return undefined;
	}
	if ([r, g, b].some(v => typeof v !== 'number' || isNaN(v))) {
		return undefined;
	}
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Reads aria.mode from configuration, binds it to the `aria.mode` context key
 * so it can be used in `when` clauses across the workbench, and re-binds when
 * the setting changes.
 */
export class AriaModeManager extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.modeManager';

	private readonly modeKey: IContextKey<AriaMode>;
	private readonly transitionStore = this._register(new DisposableStore());

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		super();
		this.modeKey = AriaModeContextKey.bindTo(contextKeyService);
		// Re-apply this project's remembered mode (or adopt the current one for it)
		// BEFORE the first visual update, so the window opens in the right mode.
		this.restoreFolderMode();
		this.update(false);

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ARIA_MODE_SETTING)) {
				this.update(true);
				// A mode change while a project is open is (almost always) a user
				// action - remember it for this folder so reopening restores it.
				savePerFolderMode(this.storageService, this.contextService, this.configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '');
			}
		}));

		// New windows (auxiliary editor windows) get the class too, so their
		// dialogs / popups follow the mode.
		this._register(this.layoutService.onDidAddContainer(() => this.applyEasyClass()));
	}

	/**
	 * On opening a project window, make aria.mode reflect THIS folder:
	 *  - if we've remembered a mode for it, re-apply that (so a folder last used
	 *    in easy reopens in easy even if the global value drifted to advanced);
	 *  - otherwise, if a concrete mode is currently set, adopt it as this
	 *    folder's remembered mode (first open records the choice made at launch).
	 */
	private restoreFolderMode(): void {
		const key = folderModeKey(this.contextService);
		if (!key) {
			return; // EMPTY workbench - the Started overlay owns mode selection.
		}
		const stored = readPerFolderModes(this.storageService)[key];
		const current = this.configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '';
		if (stored === 'easy' || stored === 'advanced') {
			if (stored !== current) {
				// Applied live by update() via the config-change listener.
				// handleDirtyFile:'save' + donotNotifyError so this silent write
				// never pops the settings.json editor / a save dialog.
				void this.configurationService.updateValue(ARIA_MODE_SETTING, stored, {}, ConfigurationTarget.APPLICATION, { handleDirtyFile: 'save', donotNotifyError: true });
			}
		} else if (current === 'easy' || current === 'advanced') {
			savePerFolderMode(this.storageService, this.contextService, current);
		}
	}

	/**
	 * Mark every workbench container AND its document root (<html>/<body>) with
	 * `aria-mode-easy` in easy mode. Dialogs and some popups attach high in the
	 * document (outside `.monaco-workbench`), so tagging `<html>` guarantees the
	 * easy CSS reaches them wherever they mount.
	 */
	private applyEasyClass(): void {
		const easy = (this.configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '') === 'easy';
		const applyToDoc = (doc: Document) => {
			doc.documentElement.classList.toggle('aria-mode-easy', easy);
			doc.body.classList.toggle('aria-mode-easy', easy);
		};
		// Use the authoritative main-window document (matches the global `document`
		// the app + DevTools see), not mainContainer.ownerDocument which can differ.
		applyToDoc(mainWindow.document);
		this.layoutService.mainContainer.classList.toggle('aria-mode-easy', easy);
		// Auxiliary windows.
		for (const container of this.layoutService.containers) {
			container.classList.toggle('aria-mode-easy', easy);
			applyToDoc(container.ownerDocument);
		}
	}

	private update(animate: boolean): void {
		const mode = this.configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '';
		this.modeKey.set(mode); // context key only - no visual change.

		// Every visual change of a mode switch, grouped so the animated path can run
		// them ALL behind the cover:
		//  - applyEasyClass()   toggles the `.aria-mode-easy` root class, which flips a
		//                       batch of `--vscode-*` overrides instantly.
		//  - syncEasyChromeFor  hides/shows menu bar + command center (title re-layout).
		//  - syncEasyThemeFor   swaps the whole color theme (the slow, blocking part).
		// Applying the class/chrome changes BEFORE the theme swap - while visible -
		// paints a half-converted workbench (widgets already light, editor still dark)
		// for a frame or two: that inconsistent state WAS the switch "flash". So for an
		// animated switch we defer all of it until the opaque cover is up.
		//
		// The three sync* calls each write USER settings (settings.json). They MUST run
		// sequentially, not concurrently: overlapping writes race on the file model and
		// the later one fails with "Unable to write into user settings because the file
		// has unsaved changes". Theme goes first (it's the most visible change, so the
		// backdrop recolours soonest and the cover can lift earlier).
		const applyVisuals = async () => {
			this.applyEasyClass();
			try {
				await this.syncEasyThemeFor(mode);
				await this.syncEasyChromeFor(mode);
				await this.syncGitEnabledFor(mode);
			} catch {
				// Best-effort: a failed settings write (e.g. settings.json open & dirty)
				// shouldn't abort the rest of the switch.
			}
		};

		if (animate && (mode === 'easy' || mode === 'advanced')) {
			this.showTransitionOverlay(mode, applyVisuals);
		} else {
			applyVisuals();
		}
	}

	private showTransitionOverlay(mode: AriaMode, swapTheme: () => void): void {
		this.transitionStore.clear();

		const toDark = mode === 'advanced';
		const wantDark = toDark;
		const wb = this.layoutService.mainContainer;

		// The overlay is a solid TARGET-coloured panel that we fade IN over the
		// workbench, then fade back OUT once the new theme has painted. Crucially the
		// only animated property is `opacity`, which the compositor drives on its own
		// thread - so even when the FIRST (uncached) theme load blocks the main thread,
		// the cover can't freeze half-drawn. (The previous version animated
		// `background-color`, a main-thread property: a blocking load froze it mid-fade
		// and the old colour flashed through - the "white-then-black on the first
		// switch" bug.)
		const targetColor = toDark ? '#1e1e1e' : '#ffffff';

		const doc = wb.ownerDocument;
		const overlay = doc.createElement('div');
		Object.assign(overlay.style, {
			position: 'absolute', inset: '0', zIndex: '100000',
			display: 'flex', alignItems: 'center', justifyContent: 'center',
			background: targetColor, opacity: '0',
			transition: 'opacity 200ms ease',
		});
		const spinner = doc.createElement('div');
		Object.assign(spinner.style, {
			width: '28px', height: '28px', borderRadius: '50%',
			border: '3px solid rgba(127,127,127,0.25)',
			borderTopColor: 'var(--aria-accent, #2ba7c9)',
			animation: 'aria-spin 0.8s linear infinite',
		});
		overlay.appendChild(spinner);
		wb.appendChild(overlay);
		this.transitionStore.add({ dispose: () => overlay.remove() });

		// Fade the target-coloured cover IN on the next frame.
		mainWindow.requestAnimationFrame(() => { overlay.style.opacity = '1'; });

		// Apply the mode's visual changes (class + chrome + theme swap) only AFTER the
		// cover is fully opaque (fade-in is 200ms), so every repaint - including the
		// half-converted intermediate frames - happens entirely hidden behind it.
		let swapped = false;
		const doSwap = () => { if (!swapped) { swapped = true; swapTheme(); } };
		this.transitionStore.add(disposableTimeout(doSwap, 260, this.transitionStore));

		let finished = false;
		const finish = () => {
			if (finished) { return; }
			finished = true;
			// Reveal the freshly-painted theme by fading the cover back out (opacity,
			// compositor again). The workbench behind is already the real theme, so the
			// reveal is seamless regardless of our targetColor guess.
			overlay.style.opacity = '0';
			disposableTimeout(() => this.transitionStore.clear(), 240, this.transitionStore);
		};

		// Poll the live editor-background luminance (the theme-change EVENT fires
		// before the repaint, so it can't be trusted). Require two consecutive
		// matching frames so an intermediate paint doesn't lift the overlay early,
		// then settle briefly before revealing.
		let polls = 0;
		let matchStreak = 0;
		const poll = () => {
			if (finished) {
				return;
			}
			if (swapped && this.workbenchBgMatches(wantDark)) {
				if (++matchStreak >= 2) {
					disposableTimeout(finish, 120, this.transitionStore);
					return;
				}
			} else {
				matchStreak = 0;
			}
			if (polls++ > 300) { // ~5s hard cap
				finish();
				return;
			}
			mainWindow.requestAnimationFrame(poll);
		};
		mainWindow.requestAnimationFrame(poll);
	}

	/** True once the live workbench editor background is on the wanted side (dark/light). */
	private workbenchBgMatches(wantDark: boolean): boolean {
		const wb = mainWindow.document.querySelector('.monaco-workbench') as HTMLElement | null;
		if (!wb) {
			return false;
		}
		const lum = parseLuminance(mainWindow.getComputedStyle(wb).getPropertyValue('--vscode-editor-background').trim());
		if (lum === undefined) {
			return false;
		}
		return wantDark ? lum < 0.45 : lum > 0.55;
	}

	/**
	 * Easy mode uses a clean white (light) look; advanced keeps whatever theme the
	 * user had. We remember the user's theme when entering easy so advanced can
	 * restore it exactly (instead of just clearing to the default). The accent
	 * sky-blue is layered on top via CSS scoped to `.aria-mode-easy`
	 * (see media/ariaEasyMode.css), so only the background/text go light.
	 */
	private async syncEasyThemeFor(mode: AriaMode): Promise<void> {
		if (mode !== 'easy' && mode !== 'advanced') {
			return;
		}
		const currentTheme = this.configurationService.inspect<string>('workbench.colorTheme').value;
		if (mode === 'easy') {
			if (currentTheme === ARIA_EASY_LIGHT_THEME) {
				return; // already applied
			}
			// Remember the user's theme so advanced restores it precisely.
			this.storageService.store(PREV_COLOR_THEME_KEY, currentTheme ?? '', StorageScope.APPLICATION, StorageTarget.MACHINE);
			await this.setUserValue('workbench.colorTheme', ARIA_EASY_LIGHT_THEME);
		} else {
			const prev = this.storageService.get(PREV_COLOR_THEME_KEY, StorageScope.APPLICATION);
			this.storageService.remove(PREV_COLOR_THEME_KEY, StorageScope.APPLICATION);
			// Restore the saved theme, or clear the override if we never saved one.
			await this.setUserValue('workbench.colorTheme', prev ? prev : undefined);
		}
	}

	/**
	 * Strips the developer chrome in easy mode: hides the top menu bar
	 * (File/Edit/…) and the title-bar layout-control buttons. Both are driven by
	 * settings the title bar reads live (no reload). Advanced mode clears the
	 * overrides so the stock chrome returns.
	 */
	private async syncEasyChromeFor(mode: AriaMode): Promise<void> {
		if (mode !== 'easy' && mode !== 'advanced') {
			return;
		}
		const easy = mode === 'easy';
		await this.setUserValue('window.menuBarVisibility', easy ? 'hidden' : undefined);
		await this.setUserValue('workbench.layoutControl.enabled', easy ? false : undefined);
		// The title-bar command center (the center "search" box + its nav arrows)
		// is developer chrome - hide it in easy so only the "Aria" brand + title show.
		await this.setUserValue('window.commandCenter', easy ? false : undefined);
		// Dialogs default to the OS-native style, which the OS paints in ITS theme -
		// on a dark desktop a confirm ("Delete this review?") shows up dark even though
		// easy mode's workbench is white. Force the in-app custom dialog in easy mode so
		// it renders as `.monaco-dialog-box` DOM: it then follows the (light) easy theme
		// and picks up the `.aria-mode-easy .monaco-dialog-box` overrides. Read live per
		// dialog, so this takes effect with no reload. Advanced restores the OS default.
		await this.setUserValue('window.dialogStyle', easy ? 'custom' : undefined);
	}

	private async setUserValue(key: string, value: unknown): Promise<void> {
		try {
			if (this.configurationService.getValue(key) === value) {
				return;
			}
			// `handleDirtyFile: 'save'` - if settings.json is open with unsaved edits,
			// save it first and then write, instead of throwing "Unable to write into
			// user settings because the file has unsaved changes" (the config-editing
			// service shows that as a modal-ish notification we can't catch). This is
			// exactly what that notification's "Save and retry" action does.
			// `donotNotifyError: true` - suppress any remaining error popup; mode-switch
			// writes are best-effort.
			await this.configurationService.updateValue(key, value, {}, ConfigurationTarget.USER, { handleDirtyFile: 'save', donotNotifyError: true });
		} catch {
			// Best-effort: silent on failure (e.g. read-only settings).
		}
	}

	/**
	 * Aria's two modes drive the built-in Git extension's visibility:
	 *  - Easy mode    → `git.enabled = false` so the Source Control view
	 *                   and all git UI disappear. The on-disk `.git/` is
	 *                   untouched; Aria's own Versions view is what the
	 *                   user sees instead.
	 *  - Advanced mode → `git.enabled = true` so Source Control / Git
	 *                    commands behave exactly like upstream VS Code.
	 *  - Unset mode    → leave whatever the user has; we only flip the
	 *                    setting on an explicit choice.
	 */
	private async syncGitEnabledFor(mode: AriaMode): Promise<void> {
		if (mode !== 'easy' && mode !== 'advanced') {
			return;
		}
		const desired = mode === 'advanced';
		await this.setUserValue('git.enabled', desired);
	}
}

// Command - switch mode (used by status bar entry and other UI)
export const ARIA_SWITCH_MODE_COMMAND = 'aria.switchMode';
export const ARIA_SET_MODE_COMMAND = 'aria.setMode';

CommandsRegistry.registerCommand(ARIA_SWITCH_MODE_COMMAND, async (accessor: ServicesAccessor) => {
	const configurationService = accessor.get(IConfigurationService);
	const dialogService = accessor.get(IDialogService);
	const hostService = accessor.get(IHostService);

	const current = configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '';
	const next: AriaMode = current === 'easy' ? 'advanced' : 'easy';

	const result = await dialogService.confirm({
		message: localize('aria.switchMode.confirm', "Switch to {0} mode? The window will reload to apply.", next),
		primaryButton: localize('aria.switchMode.reload', "Reload"),
	});
	if (!result.confirmed) {
		return;
	}

	await configurationService.updateValue(ARIA_MODE_SETTING, next, {}, ConfigurationTarget.APPLICATION, { handleDirtyFile: 'save', donotNotifyError: true });
	await hostService.reload();
});

CommandsRegistry.registerCommand(ARIA_SET_MODE_COMMAND, async (accessor: ServicesAccessor, mode: AriaMode) => {
	if (mode !== 'easy' && mode !== 'advanced') {
		return;
	}
	const configurationService = accessor.get(IConfigurationService);

	const current = configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '';
	if (current === mode) {
		return;
	}

	// Instant switch - no confirmation, no reload. The aria.mode context key
	// updates immediately, which is enough for `when` clauses and view filters.
	// (If later we add settings that are only read at startup, we can reload
	// selectively from those code paths.)
	await configurationService.updateValue(ARIA_MODE_SETTING, mode, {}, ConfigurationTarget.APPLICATION, { handleDirtyFile: 'save', donotNotifyError: true });
});
