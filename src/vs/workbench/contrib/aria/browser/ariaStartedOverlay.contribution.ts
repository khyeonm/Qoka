/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { timeout } from '../../../../base/common/async.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkspacesService, IRecentlyOpened, isRecentFolder, isRecentWorkspace } from '../../../../platform/workspaces/common/workspaces.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IAuthenticationService, AuthenticationSession } from '../../../services/authentication/common/authentication.js';
import { ROADMAP_SCHEME } from '../../ariaRoadmapWizard/browser/ariaRoadmapWizardCommon.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { basename } from '../../../../base/common/resources.js';
import { ARIA_MODE_SETTING, ARIA_AI_PROVIDER_SETTING, AriaMode } from '../common/ariaConfiguration.js';
import { ARIA_SET_MODE_COMMAND } from './ariaModeManager.js';
import { ConcreteProvider, PROVIDER_EXTENSION_ID, PROVIDER_LABEL, hasPickedAiProvider, markPickedAiProvider, clearPickedAiProvider, providerSettingFor, setPendingInstall } from './ariaAiProviderChoice.js';

// Pre-paint workbench hide. Installing the stylesheet at module-load
// - before any contribution constructor runs - guarantees the bare
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
			body > *:not(#aria-started-overlay):not(#aria-login-gate-overlay):not(style):not(script):not(link) {
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

/** Qoka authentication provider id (see the aria-authentication extension). */
const AUTH_ID = 'aria';

/** Friendly, generic lines cycled under the spinner while a sign-in step runs,
 *  so the wait doesn't feel dead. Not real status - just reassurance. */
const LOADING_MESSAGES: readonly string[] = [
	'Getting Qoka ready…',
	'One moment…',
	'Almost there…',
];
/** Shown only while an active sign-in is in progress (authLoading). These mention
 *  the browser / authorization, which would be misleading during a plain reload
 *  such as switching projects while already signed in. */
const SIGNIN_MESSAGES: readonly string[] = [
	'Preparing sign-in…',
	'Opening your browser…',
	'Waiting for authorization…',
	'Almost there…',
];

/** One-shot sessionStorage flag set right before vscode.openFolder
 *  reloads the workbench, and consumed on the next constructor run
 *  (cleared on first read). Because it self-clears, it can never go
 *  stale and silently skip Started on a future launch - even if the
 *  storage backend persists across the electron app close, the first
 *  load consumes the flag and every subsequent load sees nothing. */
const JUST_PICKED_FLAG = 'aria.started.justPicked';

/** One-shot localStorage flag set by "Change project" (see ariaAccountStatus).
 *  When the user explicitly asks to change projects we must land on the PICKER,
 *  not silently auto-reopen the project they just left. localStorage (not
 *  sessionStorage) so it survives the closeFolder reload; consumed on first read. */
const WANT_PICKER_FLAG = 'aria.started.wantPicker';

/** Per-window-session guard so an auto-reopen that somehow lands back on an EMPTY
 *  workbench (e.g. the recent folder was deleted) can't spin in a reopen loop.
 *  sessionStorage resets on a genuine relaunch, which is exactly when we want to
 *  try again. */
const AUTO_REOPEN_TRIED_FLAG = 'aria.started.autoReopenTried';

/** One-shot localStorage flag telling the folder-window login gate to skip its
 *  session poll. Set by pickAndDismiss (the overlay just validated a session
 *  before opening the folder); consumed by ariaLoginGate. Mirrors the literal in
 *  ariaLoginGate.contribution.ts. */
const LOGIN_GATE_SKIP_FLAG = 'aria.loginGate.skipOnce';

/** Legacy key from a previous attempt; cleared on startup so old
 *  installations don't keep a stale timestamp around. */
const RECENT_PICK_KEY = 'aria.started.recentPickAt';

/** README dropped into a new project folder to explain the default layout.
 *  Plain, non-developer-friendly wording; no emojis. */
const PROJECT_TEMPLATE_README = `# Qoka project

This folder was created by Qoka. Here is what each folder is for:

- notes/       Your research notes.
- references/  Papers you save or download to read (PDFs).
- data/        Datasets and analysis inputs.
- downloads/   Other downloaded files.
- paper/       Manuscripts you write in the Paper Writing tab.
- reviews/     Results from the Peer Review tab.
- .aria/       Qoka's internal files (roadmap, project settings).

You can rename or delete any folder you do not need.
`;

/** Persistent (localStorage) breadcrumb trail for the New Project / picker
 *  flow. openWindow reloads (or recreates) the window, wiping the DevTools
 *  console, so the moment a bounce happens is unobservable in the live console.
 *  We append milestones here - localStorage survives a reload AND a full window
 *  recreation (unlike sessionStorage) - and dump+clear them on the next overlay
 *  construction, so the post-bounce console prints exactly what happened before
 *  the reload. Capped so it can never grow without bound. */
const TRAIL_KEY = 'aria.started.trail';
function pushTrail(msg: string): void {
	try {
		const raw = localStorage.getItem(TRAIL_KEY);
		const arr: string[] = raw ? JSON.parse(raw) : [];
		arr.push(`${new Date().toISOString()} ${msg}`);
		// Keep the last 40 entries only.
		localStorage.setItem(TRAIL_KEY, JSON.stringify(arr.slice(-40)));
	} catch { /* storage unavailable - diagnostics are best-effort */ }
}
function dumpTrail(): void {
	try {
		const raw = localStorage.getItem(TRAIL_KEY);
		if (!raw) { return; }
		const arr: string[] = JSON.parse(raw);
		if (arr.length) {
			console.log(`[aria][trail] --- New Project / picker breadcrumb from before this load (${arr.length} entries) ---`);
			for (const line of arr) { console.log(`[aria][trail] ${line}`); }
			console.log('[aria][trail] --- end ---');
		}
		localStorage.removeItem(TRAIL_KEY);
	} catch { /* ignore */ }
}

/**
 * Qoka's "Started" overlay - a full-viewport surface that locks the
 * workbench until the user picks a project. Replaces the previous
 * editor-pane approach so the sidebar, menu bar, terminal, and editor
 * tabs underneath are all blocked from interaction.
 *
 * Behaviour summary
 *  - Shows on workbench restore ONLY when no folder is loaded (EMPTY
 *    workspace). If a project is already open (restored from a previous
 *    session or launched from a CLI), the workbench is shown directly.
 *  - Setup (MCP registration, skill install, etc.) runs in the
 *    background while the overlay is up. The "Setting up Qoka" loading
 *    overlay (firstRunOverlay) is intentionally skipped here - the
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
	/** True while the overlay is stood down because the roadmap wizard editor
	 *  is open. We only auto-return the picker when WE hid it for that reason. */
	private suppressedForRoadmap = false;

	// Auth state - the overlay is also the sign-in gate. Until the first check
	// resolves we show the loading spinner; then login (no session) or the
	// signed-in banner + picker (session present).
	private ariaSession: AuthenticationSession | undefined;
	private ariaProvider: string | undefined;
	private authChecked = false;
	private authLoading = false;
	private cycleTimer: ReturnType<typeof setInterval> | undefined;

	// AI-provider picker step (shown after sign-in, before the mode/project
	// picker, on first run only). `aiInstalled` is filled asynchronously from
	// IExtensionService; `aiChecked` is the user's multi-select state.
	private aiInstalled: Record<ConcreteProvider, boolean> | undefined;
	private aiChecked: Record<ConcreteProvider, boolean> = { claude: false, codex: false };
	private aiCheckedInit = false;
	private aiFetching = false;
	// True while, right after the user clicks Continue on the AI picker, we install
	// the chosen provider's CLI and register the MCP servers. The overlay shows a
	// loading page during this so the user can't proceed until the tools are ready.
	private setupInProgress = false;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@IHostService private readonly hostService: IHostService,
		@IEditorService private readonly editorService: IEditorService,
		@IAuthenticationService private readonly authService: IAuthenticationService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IExtensionService private readonly extensionService: IExtensionService,
	) {
		super();

		// Print (and clear) any breadcrumb the pre-reload window left behind, then
		// record where THIS load landed - so a New Project bounce shows up as
		// "createNewProject ... openWindow" followed by "constructor: state=EMPTY".
		dumpTrail();
		try {
			const state = this.contextService.getWorkbenchState();
			const stateName = state === WorkbenchState.EMPTY ? 'EMPTY' : state === WorkbenchState.FOLDER ? 'FOLDER' : 'WORKSPACE';
			const justPicked = (() => { try { return sessionStorage.getItem(JUST_PICKED_FLAG); } catch { return '?'; } })();
			pushTrail(`constructor: workbenchState=${stateName}, justPickedFlag=${justPicked}`);
			console.log(`[aria][trail] constructor: workbenchState=${stateName}, justPickedFlag=${justPicked}`);
		} catch { /* ignore */ }

		// Re-check which provider extensions are installed when the set changes
		// (e.g. the user installs one from the picker), so the step updates.
		this._register(this.extensionService.onDidChangeExtensions(() => {
			if (this.overlay && !hasPickedAiProvider()) {
				void this.refreshAiInstalled();
			}
		}));

		// The New Project wizard opens as a real editor. When it appears we
		// step the picker aside so the wizard + Claude Code's aux-bar chat own
		// the window; when it closes we bring the picker back (unless a project
		// was just picked and a reload is imminent).
		this._register(this.editorService.onDidEditorsChange(() => this.syncRoadmapEditor()));

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

		// This overlay (sign-in + picker) is only for an EMPTY workbench. A folder
		// window - a just-picked reload or a restored project - shows the workbench
		// directly; the login guard (ariaLoginGate) handles sign-in there.
		if (this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
			pushTrail('startup: workbenchState != EMPTY (folder attached) -> showing workbench, overlay suppressed (GOOD - no bounce)');
			try { sessionStorage.removeItem(JUST_PICKED_FLAG); } catch { /* ignore */ }
			this.removeEarlyHideStyleByID();
			return;
		}

		// During the openFolder reload, the very next workbench load
		// must NOT re-show Started. We hand that off to a sessionStorage
		// flag that's set just before reload and cleared on first read
		// - so it's a one-shot, can't go stale, doesn't leak across
		// genuine app restarts (sessionStorage is per-window-session).
		try {
			if (sessionStorage.getItem(JUST_PICKED_FLAG) === '1') {
				pushTrail('startup: workbenchState EMPTY but justPicked flag SET -> suppressing overlay for the reload (folder did not attach yet)');
				sessionStorage.removeItem(JUST_PICKED_FLAG);
				// Module-load installed an early hide stylesheet to
				// prevent the workbench flash; on the skip path we
				// must take it down or the user stares at a blank
				// page while setup runs.
				this.removeEarlyHideStyleByID();
				return;
			}
		} catch { /* ignore */ }

		// EMPTY workbench, not a just-picked reload. Hide the workbench shell right
		// away (avoids a flash) while we decide asynchronously whether to auto-reopen
		// the last project or bring up the sign-in / picker overlay.
		this.installHideWorkbenchStyle();
		void this.decideEmptyWorkbench();
	}

	/**
	 * Reached on an EMPTY workbench that isn't a just-picked reload - i.e. a plain
	 * app launch (Cmd+Q relaunch) or a Dock reactivation into a fresh empty window.
	 * Intent-based routing:
	 *   - "Change project" was clicked  → show the PICKER (WANT_PICKER_FLAG).
	 *   - Signed out (no session)        → show SIGN-IN.
	 *   - Otherwise (signed in, past onboarding, a recent project exists)
	 *                                    → AUTO-REOPEN the most recent project.
	 * Only an explicit action lands on the picker/sign-in; everything else returns
	 * the user straight to where they were working.
	 */
	private async decideEmptyWorkbench(): Promise<void> {
		// Explicit "Change project" always wins - consume the one-shot flag and show
		// the picker.
		let wantPicker = false;
		try { wantPicker = localStorage.getItem(WANT_PICKER_FLAG) === '1'; } catch { /* ignore */ }
		if (wantPicker) {
			try { localStorage.removeItem(WANT_PICKER_FLAG); } catch { /* ignore */ }
			pushTrail('decideEmptyWorkbench: WANT_PICKER flag set -> showing picker');
			this.showOverlayAndWireAuth();
			return;
		}

		// Loop guard: if we already tried to auto-reopen in THIS window session and
		// still landed empty, the target was unopenable - fall back to the picker.
		let alreadyTried = false;
		try { alreadyTried = sessionStorage.getItem(AUTO_REOPEN_TRIED_FLAG) === '1'; } catch { /* ignore */ }
		if (alreadyTried) {
			pushTrail('decideEmptyWorkbench: auto-reopen already tried this session -> showing picker');
			this.showOverlayAndWireAuth();
			return;
		}

		// Need a signed-in session AND a completed onboarding (AI provider chosen) to
		// auto-reopen; otherwise the first-run sign-in / AI-picker flow must run.
		let hasSession = false;
		try {
			const sessions = await this.authService.getSessions(AUTH_ID, undefined, undefined, true);
			hasSession = sessions.length > 0;
		} catch { /* treat as no session */ }
		// "Onboarding done" = the localStorage picked flag OR an explicit
		// aria.aiProvider setting (claude/codex). The setting persists reliably even
		// if the localStorage flag was lost, so a returning user isn't wrongly sent
		// back through the AI picker.
		const providerSetting = this.configurationService.getValue<string>('aria.aiProvider');
		const pickedAi = hasPickedAiProvider() || providerSetting === 'claude' || providerSetting === 'codex';
		if (!hasSession || !pickedAi) {
			pushTrail(`decideEmptyWorkbench: hasSession=${hasSession}, pickedAi=${pickedAi} -> showing sign-in/picker`);
			this.showOverlayAndWireAuth();
			return;
		}

		// Find the most recent project folder that still exists on disk.
		const recentUri = await this.mostRecentExistingProject();
		if (!recentUri) {
			pushTrail('decideEmptyWorkbench: no reopenable recent project -> showing picker');
			this.showOverlayAndWireAuth();
			return;
		}

		try { sessionStorage.setItem(AUTO_REOPEN_TRIED_FLAG, '1'); } catch { /* ignore */ }
		pushTrail(`decideEmptyWorkbench: auto-reopening most recent project ${recentUri.fsPath}`);
		// Reuse the just-picked machinery so the reloaded window suppresses the
		// overlay and lands directly on the project.
		this.pickAndDismiss(() => {
			void this.hostService.openWindow([{ folderUri: recentUri }], { forceReuseWindow: true });
		});
	}

	/** The most recent recently-opened folder whose directory still exists, or
	 *  undefined when there is none to reopen. */
	private async mostRecentExistingProject(): Promise<URI | undefined> {
		let recents: IRecentlyOpened;
		try {
			recents = await this.workspacesService.getRecentlyOpened();
		} catch {
			return undefined;
		}
		for (const item of recents.workspaces) {
			const uri: URI | undefined = isRecentFolder(item)
				? item.folderUri
				: isRecentWorkspace(item)
					? item.workspace.configPath
					: undefined;
			if (!uri) {
				continue;
			}
			try {
				if (await this.fileService.exists(uri)) {
					return uri;
				}
			} catch {
				// Unreadable - skip and try the next most recent.
			}
		}
		return undefined;
	}

	/** Bring up the sign-in / picker overlay and keep it in sync with the session.
	 *  Split out of the constructor so decideEmptyWorkbench can defer to it on every
	 *  non-auto-reopen path. */
	private showOverlayAndWireAuth(): void {
		this.show();

		// The overlay doubles as the sign-in gate: re-check and re-render on every
		// session change (login success dismisses login → banner + picker; sign
		// out from the banner returns to the login view).
		this._register(this.authService.onDidChangeSessions(e => {
			if (e.providerId === AUTH_ID) {
				this.authLoading = false;
				void this.refreshAuth();
			}
		}));
		void this.refreshAuth();
	}

	/** Read the current Qoka session and re-render the overlay to match. */
	private async refreshAuth(): Promise<void> {
		try {
			// activateImmediate=true wakes the aria-authentication extension so its
			// provider is registered before we read sessions.
			const sessions = await this.authService.getSessions(AUTH_ID, undefined, undefined, true);
			this.ariaSession = sessions.length > 0 ? sessions[0] : undefined;
		} catch {
			this.ariaSession = undefined;
		}
		// The session has no provider (scopes are []); the extension exposes it.
		try {
			const info = await this.commandService.executeCommand<{ provider?: string } | undefined>('aria.auth.getSession');
			this.ariaProvider = info?.provider;
		} catch {
			this.ariaProvider = undefined;
		}
		this.authChecked = true;
		this.authLoading = false;
		this.rerender();
	}

	private async signIn(provider: 'orcid' | 'google'): Promise<void> {
		// Going through the login screen re-arms the AI picker: once this sign-in
		// completes, the AI-assistant step shows again. Reopening later with an
		// already-restored session skips signIn (and the picker), as intended.
		clearPickedAiProvider();
		this.authLoading = true;
		this.rerender();
		try {
			console.log(`[aria] sign-in started via ${provider}`);
			// The provider hint is passed as the scope; the aria-authentication
			// extension reads it to skip its own provider QuickPick.
			await this.authService.createSession(AUTH_ID, [provider]);
			// Success fires onDidChangeSessions → refreshAuth → banner + picker.
			console.log(`[aria] sign-in via ${provider} succeeded`);
		} catch (e) {
			// Cancelled (user closed the browser / clicked Cancel) or failed:
			// drop the loading state and re-render the sign-in screen.
			console.log(`[aria] sign-in via ${provider} cancelled/failed, returning to sign-in screen:`, (e as Error)?.message);
			this.authLoading = false;
			void this.refreshAuth();
		}
	}

	private async signOut(): Promise<void> {
		if (!this.ariaSession) {
			return;
		}
		try {
			await this.authService.removeSession(AUTH_ID, this.ariaSession.id);
		} catch { /* ignore */ }
		// onDidChangeSessions → refreshAuth → login view. Already in the picker
		// (empty workspace), so no folder needs closing here.
		void this.refreshAuth();
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
			body > *:not(#aria-started-overlay):not(#aria-login-gate-overlay):not(style):not(script):not(link) {
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
			// The overlay only reaches a folder-opening action when the user is
			// signed in (the picker sits behind the auth gate). Tell the folder
			// window's login gate to TRUST that and skip its own session poll -
			// otherwise, while a fresh window is busy (e.g. installing the CLI), the
			// gate's getSessions can race the auth restore, wrongly conclude "signed
			// out", and closeFolder - the New Project bounce. We store a TIMESTAMP
			// (not just '1'): the gate honours it only if fresh (seconds old), so a
			// flag that somehow lingers can never suppress the gate on a later,
			// genuinely-signed-out folder window. localStorage survives the reload.
			localStorage.setItem(LOGIN_GATE_SKIP_FLAG, String(Date.now()));
			pushTrail('pickAndDismiss: set justPicked + loginGateSkip flags, hiding overlay, running action');
		} catch {
			// Storage can throw in restricted contexts; the overlay
			// still hides and the action still runs.
			pushTrail('pickAndDismiss: storage.setItem THREW - flags NOT set');
		}
		this.hide();
		action();
	}

	private show(): void {
		if (this.overlay) {
			return;
		}

		// Never show the sign-in / mode-and-project picker once a project folder
		// is open. The picker is for the empty-workbench start only; a folder
		// window must stay on the project - even if a provider extension failed
		// to load or wasn't detected - instead of bouncing back to the picker.
		if (this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
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
		// Center the content box on screen. `display:flex` + `margin:auto` on the
		// content (see render) centers it both axes and still scrolls when the
		// content is taller than the viewport.
		overlay.style.display = 'flex';
		overlay.style.fontFamily = 'var(--vscode-font-family, system-ui, sans-serif)';
		// Allow dragging the window by the overlay background (covered title bar);
		// the content box (render()) opts back out so its controls stay clickable.
		overlay.style.setProperty('-webkit-app-region', 'drag');

		this.installFocusTrap(overlay);

		document.body.appendChild(overlay);
		this.overlay = overlay;

		this.render();
	}

	private hide(): void {
		if (!this.overlay) {
			return;
		}
		this.stopMessageCycle();
		this.overlay.remove();
		this.overlay = undefined;
		this.removeHideWorkbenchStyle();
	}

	/** React to the roadmap wizard editor opening / closing. */
	private syncRoadmapEditor(): void {
		const wizardOpen = this.editorService.editors.some(e => e.resource?.scheme === ROADMAP_SCHEME);
		if (wizardOpen) {
			// Editor is up - stand the picker down (only if we currently show it).
			if (this.overlay) {
				this.hide();
				this.suppressedForRoadmap = true;
			}
			return;
		}
		// Editor gone - bring the picker back, but only if we were the ones who
		// hid it and no project pick is mid-flight (Save triggers a reload).
		if (this.suppressedForRoadmap) {
			this.suppressedForRoadmap = false;
			let justPicked = false;
			try { justPicked = sessionStorage.getItem(JUST_PICKED_FLAG) === '1'; } catch { /* ignore */ }
			if (!justPicked && !this.overlay) {
				this.installHideWorkbenchStyle();
				this.show();
			}
		}
	}

	// --- AI-assistant picker step ------------------------------------------

	/** A small themed button used by the AI picker step. Secondary buttons use
	 *  `inherit` so they read correctly on both the easy (white) and advanced
	 *  (dark) overlay backgrounds. */
	private makeButton(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.textContent = label;
		btn.style.padding = '9px 20px';
		btn.style.fontSize = '13.5px';
		btn.style.borderRadius = '5px';
		btn.style.cursor = 'pointer';
		btn.style.font = 'inherit';
		if (primary) {
			btn.style.background = 'var(--vscode-button-background, #0e639c)';
			btn.style.color = 'var(--vscode-button-foreground, #ffffff)';
			btn.style.border = '1px solid transparent';
		} else {
			btn.style.background = 'transparent';
			btn.style.color = 'inherit';
			btn.style.border = '1px solid rgba(127,127,127,0.5)';
		}
		btn.onclick = onClick;
		return btn;
	}

	/** Async-check which provider extensions are installed, then re-render. On
	 *  the first fill, pre-check the installed ones so a ready user can just
	 *  click Continue. */
	private async refreshAiInstalled(): Promise<void> {
		if (this.aiFetching) {
			return;
		}
		this.aiFetching = true;
		try {
			const check = async (p: ConcreteProvider) => !!(await this.extensionService.getExtension(PROVIDER_EXTENSION_ID[p]));
			const [claude, codex] = await Promise.all([check('claude'), check('codex')]);
			this.aiInstalled = { claude, codex };
			if (!this.aiCheckedInit) {
				this.aiChecked = { claude, codex };
				this.aiCheckedInit = true;
			}
		} finally {
			this.aiFetching = false;
		}
		if (this.overlay && !hasPickedAiProvider()) {
			this.rerender();
		}
	}

	private renderAiProviderSection(parent: HTMLElement): void {
		const title = document.createElement('h1');
		title.textContent = 'Choose your AI assistant';
		title.style.fontSize = '32px';
		title.style.fontWeight = '300';
		title.style.margin = '0 0 8px 0';
		parent.appendChild(title);

		const subtitle = document.createElement('p');
		subtitle.textContent = 'Qoka works with Claude Code or Codex. Pick the one(s) you\'ll use - you can select both. You can change this later in Settings.';
		subtitle.style.fontSize = '14px';
		subtitle.style.opacity = '0.7';
		subtitle.style.margin = '0 0 28px 0';
		subtitle.style.maxWidth = '520px';
		parent.appendChild(subtitle);

		// Installed-state not known yet → fetch it and show a spinner meanwhile.
		if (!this.aiInstalled) {
			void this.refreshAiInstalled();
			this.renderLoadingSection(parent);
			return;
		}

		const list = document.createElement('div');
		list.style.display = 'flex';
		list.style.flexDirection = 'column';
		list.style.gap = '12px';
		list.style.maxWidth = '520px';
		parent.appendChild(list);
		(['claude', 'codex'] as ConcreteProvider[]).forEach(p => list.appendChild(this.renderProviderRow(p)));

		// Continue is enabled whenever at least one provider is checked. What it
		// does depends on install state (see chooseAiProviders): all checked ones
		// installed → proceed; any missing → open the Marketplace page(s) so the
		// user can install, then reload.
		const anyChecked = (['claude', 'codex'] as ConcreteProvider[]).some(p => this.aiChecked[p]);
		const cont = this.makeButton('Continue', true, () => { if (anyChecked) { void this.chooseAiProviders(); } });
		cont.style.marginTop = '26px';
		if (!anyChecked) {
			cont.style.opacity = '0.5';
			cont.style.cursor = 'not-allowed';
		}
		parent.appendChild(cont);

		const hint = document.createElement('div');
		hint.textContent = 'Check the assistant(s) you want. If a checked one isn\'t installed yet, you\'ll be taken to install it after you pick a project.';
		hint.style.marginTop = '12px';
		hint.style.fontSize = '12px';
		hint.style.opacity = '0.6';
		hint.style.maxWidth = '520px';
		parent.appendChild(hint);
	}

	private renderProviderRow(p: ConcreteProvider): HTMLElement {
		const installed = !!this.aiInstalled?.[p];
		const row = document.createElement('div');
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '12px';
		row.style.padding = '14px 16px';
		row.style.border = '1px solid rgba(127,127,127,0.35)';
		row.style.borderRadius = '8px';

		// Checkbox is ALWAYS selectable - the user may want an assistant that
		// isn't installed yet; Continue routes such choices to the Marketplace.
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.checked = this.aiChecked[p];
		cb.style.width = '17px';
		cb.style.height = '17px';
		cb.style.cursor = 'pointer';
		cb.onchange = () => { this.aiChecked[p] = cb.checked; this.rerender(); };
		row.appendChild(cb);

		const name = document.createElement('div');
		name.textContent = PROVIDER_LABEL[p];
		name.style.flex = '1';
		name.style.fontSize = '15px';
		name.style.fontWeight = '600';
		row.appendChild(name);

		// Installed → an active Uninstall button (click removes it). Not installed
		// → a red "Uninstalled" label. The checkbox stays selectable in both cases.
		if (installed) {
			const uninstall = this.makeButton('Uninstall', false, () => void this.uninstallProvider(p));
			uninstall.style.padding = '5px 12px';
			uninstall.style.fontSize = '12.5px';
			row.appendChild(uninstall);
		} else {
			const label = document.createElement('span');
			label.textContent = 'Uninstalled';
			label.style.fontSize = '12.5px';
			label.style.fontWeight = '600';
			label.style.color = 'var(--vscode-errorForeground, #e51400)';
			row.appendChild(label);
		}
		return row;
	}

	private async uninstallProvider(p: ConcreteProvider): Promise<void> {
		try {
			await this.commandService.executeCommand('workbench.extensions.uninstallExtension', PROVIDER_EXTENSION_ID[p]);
			this.aiChecked[p] = false;
			this.notificationService.info(`${PROVIDER_LABEL[p]} uninstalled. Reload Qoka to fully remove it.`);
		} catch (e) {
			this.notificationService.error(`Could not uninstall ${PROVIDER_LABEL[p]}: ${(e as Error).message}`);
		}
		void this.refreshAiInstalled();
	}

	/**
	 * Continue from the AI picker:
	 *  - if every CHECKED provider is installed → record the choice in
	 *    `aria.aiProvider` and advance to the mode/project picker;
	 *  - if any CHECKED provider is NOT installed → dismiss the overlay and open
	 *    the Marketplace page for each missing one (both, if both were checked)
	 *    so the user can install; we do NOT mark the choice, so the picker
	 *    returns on the next reload where the now-installed provider proceeds.
	 */
	private async chooseAiProviders(): Promise<void> {
		const providers: ConcreteProvider[] = ['claude', 'codex'];
		const checked = providers.filter(p => this.aiChecked[p]);
		if (checked.length === 0) {
			return;
		}
		// Any checked provider that isn't installed yet is DEFERRED: record it and
		// advance to the project picker. Its Marketplace page opens later - after
		// the user picks a project - in that project window (see ariaStartupChat),
		// not here in the empty picker.
		const missing = checked.filter(p => !this.aiInstalled?.[p]);
		setPendingInstall(missing);

		const setting = providerSettingFor(this.aiChecked.claude, this.aiChecked.codex);
		markPickedAiProvider();
		try {
			// handleDirtyFile:'save' + donotNotifyError so writing the setting never
			// pops the settings.json editor / a save dialog over the overlay.
			await this.configurationService.updateValue(ARIA_AI_PROVIDER_SETTING, setting, {}, ConfigurationTarget.APPLICATION, { handleDirtyFile: 'save', donotNotifyError: true });
		} catch { /* proceed even if persisting fails; 'auto' resolution covers it */ }

		// Install the chosen provider(s)' CLI and register the MCP servers NOW,
		// behind a loading page, so the tools are ready before the user reaches the
		// chat. Idempotent, so a later relaunch (already installed) is fast and never
		// shows this. Failsafe timeout so a stuck install can't trap the user here.
		this.setupInProgress = true;
		this.rerender();
		try {
			await Promise.race([
				this.commandService.executeCommand('aria.setup.prepareProviders', checked),
				timeout(90000),
			]);
		} catch { /* proceed regardless - the project window's setup gate retries */ }
		this.setupInProgress = false;
		this.rerender(); // → mode + project picker
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

	/**
	 * The launch overlay follows the mode: white in easy (matching the forced
	 * light theme), the current dark editor background in advanced. Re-applied on
	 * every render, so clicking the Easy / Advanced card recolors it immediately.
	 */
	private applyModeColors(): void {
		if (!this.overlay) {
			return;
		}
		const easy = this.configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) === 'easy';
		this.overlay.style.background = easy ? '#ffffff' : 'var(--vscode-editor-background, #1e1e1e)';
		this.overlay.style.color = easy ? '#1f1f1f' : 'var(--vscode-foreground, #cccccc)';
	}

	private render(): void {
		if (!this.overlay) {
			return;
		}

		this.applyModeColors();

		const content = document.createElement('div');
		content.style.maxWidth = '900px';
		content.style.width = '100%';
		// `margin: auto` inside the flex overlay centers this box on both axes
		// (and overrides flex stretch), while still allowing scroll when tall.
		content.style.margin = 'auto';
		content.style.padding = '40px';
		content.style.boxSizing = 'border-box';
		// The overlay background is a window-drag region (see show()); the content
		// box opts out so its buttons / menus stay clickable.
		content.style.setProperty('-webkit-app-region', 'no-drag');
		this.overlay.appendChild(content);

		// A prior render's loading-message cycle points at a now-removed node.
		this.stopMessageCycle();

		// Sign-in gate: until authenticated, this overlay shows login (or the
		// loading spinner mid sign-in), NOT the project picker.
		if (!this.authChecked || this.authLoading) {
			// During an ACTIVE sign-in offer a way back: closing the external
			// browser fires no event, so createSession never rejects and the
			// spinner would otherwise hang on "Preparing sign-in…" forever.
			this.renderLoadingSection(content, this.authLoading);
			return;
		}
		if (!this.ariaSession) {
			this.renderLoginSection(content);
			return;
		}

		// Right after Continue on the AI picker: installing the CLI + registering
		// MCP. Blocks the picker until the tools are ready. (hasPickedAiProvider is
		// already true here, so this must be checked before that branch.)
		if (this.setupInProgress) {
			this.renderSetupLoading(content);
			return;
		}

		// First-run AI-assistant step: signed in but hasn't chosen an AI yet.
		// Blocks the mode/project picker until a provider is chosen (and at
		// least one chosen provider is installed).
		if (!hasPickedAiProvider()) {
			this.renderAiProviderSection(content);
			return;
		}

		const mode = this.configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '';

		const title = document.createElement('h1');
		title.textContent = mode === 'easy'
			? 'Qoka - Easy Mode'
			: mode === 'advanced'
				? 'Qoka - Advanced Mode'
				: 'Welcome to Qoka';
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

		this.renderSignedInBanner(content);
		this.renderModeSection(content, mode);
		this.renderStartSection(content);
		void this.renderRecentProjects(content);
	}

	// --- sign-in views (merged into the picker overlay) --------------------

	private startMessageCycle(target: HTMLElement): void {
		this.stopMessageCycle();
		// Sign-in-specific wording only during an actual sign-in; a plain reload
		// (e.g. switching projects while already signed in) gets neutral messages.
		const messages = this.authLoading ? SIGNIN_MESSAGES : LOADING_MESSAGES;
		let i = 0;
		target.textContent = messages[0];
		this.cycleTimer = setInterval(() => {
			i = (i + 1) % messages.length;
			target.style.opacity = '0';
			setTimeout(() => {
				target.textContent = messages[i];
				target.style.opacity = '0.7';
			}, 300);
		}, 1900);
	}

	private stopMessageCycle(): void {
		if (this.cycleTimer !== undefined) {
			clearInterval(this.cycleTimer);
			this.cycleTimer = undefined;
		}
	}

	private renderLoadingSection(parent: HTMLElement, cancellable = false): void {
		const box = document.createElement('div');
		box.style.display = 'flex';
		box.style.flexDirection = 'column';
		box.style.alignItems = 'center';
		box.style.justifyContent = 'center';
		box.style.gap = '22px';
		box.style.minHeight = '220px';
		parent.appendChild(box);

		const spinner = document.createElement('div');
		spinner.style.width = '42px';
		spinner.style.height = '42px';
		spinner.style.borderRadius = '50%';
		spinner.style.border = '3px solid rgba(127, 127, 127, 0.25)';
		spinner.style.borderTopColor = 'var(--vscode-foreground, #fff)';
		spinner.style.animation = 'aria-started-spin 1.05s linear infinite';
		this.ensureSpinnerKeyframes();
		box.appendChild(spinner);

		const msg = document.createElement('div');
		msg.style.fontSize = '13.5px';
		msg.style.opacity = '0.7';
		msg.style.minHeight = '1.4em';
		msg.style.transition = 'opacity 0.3s ease';
		box.appendChild(msg);
		this.startMessageCycle(msg);

		if (cancellable) {
			// The underlying createSession stays pending (the loopback server times
			// out on its own); this just drops the overlay's waiting state and
			// returns the user to the sign-in buttons so they aren't stuck.
			const back = document.createElement('button');
			back.textContent = 'Back to sign-in';
			back.style.marginTop = '4px';
			back.style.padding = '6px 16px';
			back.style.fontSize = '12.5px';
			back.style.fontFamily = 'inherit';
			back.style.color = 'var(--vscode-foreground, #cccccc)';
			back.style.background = 'transparent';
			back.style.border = '1px solid rgba(127, 127, 127, 0.4)';
			back.style.borderRadius = '5px';
			back.style.cursor = 'pointer';
			back.onclick = () => {
				console.log('[aria] sign-in cancelled by user (Back to sign-in), returning to sign-in screen');
				// Actually ABORT the in-flight browser login: closing the browser fires
				// no event, so the loopback server + its withProgress linger and would
				// block a following sign-in with a different provider (the new login's
				// browser never opens). This command closes that server and rejects the
				// pending createSession.
				void this.commandService.executeCommand('aria.auth.cancelSignIn');
				// Render the sign-in screen SYNCHRONOUSLY. We must NOT call refreshAuth
				// here: its getSessions() call can queue behind the pending createSession,
				// so awaiting it would hang and the view would never update. The user was
				// mid sign-in, so there is no session - go straight to the login buttons.
				this.authLoading = false;
				this.authChecked = true;
				this.ariaSession = undefined;
				this.stopMessageCycle();
				this.rerender();
			};
			box.appendChild(back);
		}
	}

	private ensureSpinnerKeyframes(): void {
		if (document.getElementById('aria-started-spin-kf')) {
			return;
		}
		const style = document.createElement('style');
		style.id = 'aria-started-spin-kf';
		style.textContent = '@keyframes aria-started-spin { to { transform: rotate(360deg); } }';
		document.head.appendChild(style);
	}

	/** Loading page shown right after the AI picker's Continue, while the chosen
	 *  provider's CLI installs and the MCP servers register. A fixed message (not
	 *  the cycling sign-in copy) since this is a one-time first-run download. */
	private renderSetupLoading(parent: HTMLElement): void {
		const box = document.createElement('div');
		box.style.display = 'flex';
		box.style.flexDirection = 'column';
		box.style.alignItems = 'center';
		box.style.justifyContent = 'center';
		box.style.gap = '20px';
		box.style.minHeight = '240px';
		box.style.textAlign = 'center';
		parent.appendChild(box);

		const spinner = document.createElement('div');
		spinner.style.width = '42px';
		spinner.style.height = '42px';
		spinner.style.borderRadius = '50%';
		spinner.style.border = '3px solid rgba(127, 127, 127, 0.25)';
		spinner.style.borderTopColor = 'var(--vscode-foreground, #fff)';
		spinner.style.animation = 'aria-started-spin 1.05s linear infinite';
		this.ensureSpinnerKeyframes();
		box.appendChild(spinner);

		const title = document.createElement('div');
		title.textContent = 'Setting up your AI assistant';
		title.style.fontSize = '16px';
		title.style.fontWeight = '600';
		box.appendChild(title);

		const sub = document.createElement('div');
		sub.textContent = 'Downloading the tools it needs. This can take a minute the first time.';
		sub.style.fontSize = '13px';
		sub.style.opacity = '0.7';
		sub.style.maxWidth = '420px';
		sub.style.lineHeight = '1.5';
		box.appendChild(sub);
	}

	private renderLoginSection(parent: HTMLElement): void {
		console.log('[aria] showing sign-in screen (no active session)');
		// The picker content is left-aligned and wide; the sign-in column is short,
		// so center it (vertically too) for a balanced, intentional login screen.
		parent.style.display = 'flex';
		parent.style.flexDirection = 'column';
		parent.style.alignItems = 'center';
		parent.style.textAlign = 'center';
		parent.style.justifyContent = 'center';
		parent.style.minHeight = '70vh';

		const title = document.createElement('h1');
		title.textContent = 'Qoka';
		title.style.fontSize = '32px';
		title.style.fontWeight = '300';
		title.style.margin = '0 0 8px 0';
		parent.appendChild(title);

		const sub = document.createElement('p');
		sub.textContent = 'Sign in with ORCID or Google to continue.';
		sub.style.fontSize = '14px';
		sub.style.opacity = '0.7';
		sub.style.margin = '0 0 28px 0';
		parent.appendChild(sub);

		const box = document.createElement('div');
		box.style.display = 'flex';
		box.style.flexDirection = 'column';
		box.style.gap = '10px';
		box.style.width = '300px';
		parent.appendChild(box);

		box.appendChild(this.makeLoginButton('Sign in with ORCID', () => void this.signIn('orcid')));
		box.appendChild(this.makeLoginButton('Sign in with Google', () => void this.signIn('google')));
	}

	private makeLoginButton(text: string, onClick: () => void): HTMLButtonElement {
		// Neutral, matching the Mode / Start cards - no brand accent colors.
		const btn = document.createElement('button');
		btn.textContent = text;
		btn.style.width = '100%';
		btn.style.padding = '13px 16px';
		btn.style.fontSize = '14px';
		btn.style.fontWeight = '600';
		btn.style.cursor = 'pointer';
		btn.style.border = '1px solid rgba(127, 127, 127, 0.2)';
		btn.style.borderRadius = '6px';
		btn.style.background = 'rgba(127, 127, 127, 0.06)';
		btn.style.color = 'var(--vscode-foreground, #cccccc)';
		btn.style.fontFamily = 'inherit';
		btn.onmouseenter = () => { btn.style.background = 'rgba(127, 127, 127, 0.14)'; };
		btn.onmouseleave = () => { btn.style.background = 'rgba(127, 127, 127, 0.06)'; };
		btn.onclick = (e) => { e.stopPropagation(); onClick(); };
		return btn;
	}

	private renderSignedInBanner(parent: HTMLElement): void {
		const s = this.ariaSession;
		if (!s) {
			return;
		}
		// Show the provider (google / orcid) after the name - the session itself has
		// no provider (scopes are []), so it comes from the extension via command.
		const name = (s.account?.label || 'Qoka user') + (this.ariaProvider ? ` (${this.ariaProvider})` : '');

		const banner = document.createElement('div');
		banner.style.display = 'flex';
		banner.style.alignItems = 'center';
		banner.style.gap = '12px';
		banner.style.padding = '14px 18px';
		banner.style.marginBottom = '28px';
		banner.style.border = '1px solid rgba(127, 127, 127, 0.2)';
		banner.style.borderRadius = '6px';
		banner.style.background = 'rgba(127, 127, 127, 0.06)';
		parent.appendChild(banner);

		const who = document.createElement('div');
		who.style.display = 'flex';
		who.style.flexDirection = 'column';
		who.style.gap = '2px';

		const nameEl = document.createElement('div');
		nameEl.style.fontSize = '14px';
		nameEl.style.fontWeight = '600';
		nameEl.textContent = name;
		who.appendChild(nameEl);

		const status = document.createElement('div');
		status.textContent = '✓ Signed in';
		status.style.fontSize = '12px';
		status.style.opacity = '0.6';
		who.appendChild(status);
		banner.appendChild(who);

		const out = document.createElement('button');
		out.textContent = 'Sign out';
		out.style.marginLeft = 'auto';
		out.style.fontSize = '12.5px';
		out.style.padding = '6px 12px';
		out.style.cursor = 'pointer';
		out.style.borderRadius = '7px';
		out.style.border = '1px solid rgba(127, 127, 127, 0.35)';
		out.style.background = 'transparent';
		out.style.color = 'var(--vscode-foreground, #cccccc)';
		out.style.fontFamily = 'inherit';
		out.onclick = (e) => { e.stopPropagation(); void this.signOut(); };
		banner.appendChild(out);
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
			'Pick a location and name, then draft the roadmap in the new project.',
			() => {
				// New Project first creates+opens the project folder, then the
				// roadmap canvas auto-opens inside that window (see createNewProject).
				void this.createNewProject();
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
			// User cancelled - keep the overlay up.
			return;
		}
		const folderUri = result[0];
		this.pickAndDismiss(() => {
			void this.hostService.openWindow([{ folderUri }], { forceReuseWindow: true });
		});
	}

	/**
	 * New Project: let the user choose a location + folder name (one save
	 * dialog), create that folder with an empty `.aria/roadmap.json`, then open
	 * it. A one-shot flag makes the roadmap canvas auto-open in the new window,
	 * where the user drafts the roadmap with Claude Code.
	 */
	private async createNewProject(): Promise<void> {
		const target = await this.fileDialogService.showSaveDialog({
			title: 'New project - choose a location and folder name',
			saveLabel: 'Create project',
		});
		if (!target) {
			// User cancelled - keep the overlay up.
			return;
		}
		// Canonicalise the save-dialog target into a plain file:// folder URI, the
		// same shape openWindow gets for recent/Open Project (which work). A raw
		// showSaveDialog URI can differ enough on Windows that the reload lands in
		// an empty window and bounces back to the picker.
		const folderUri = URI.file(target.fsPath);
		pushTrail(`createNewProject: target=${folderUri.fsPath}`);
		// Create the project FOLDER via the file service (main process): immediate
		// and reliable. Routing this through the aria-roadmap command instead meant
		// that on a FIRST launch the folder was created only AFTER that extension
		// finished ACTIVATING - a delay of seconds during which openWindow already
		// reloaded into an empty window and Started bounced back to the picker.
		// (After a sign-out the extension is already active, so it worked then.)
		try {
			await this.fileService.createFolder(folderUri);
			pushTrail('createNewProject: folder created OK');
		} catch (e) {
			pushTrail(`createNewProject: createFolder FAILED - ${(e as Error).message}`);
			this.notificationService.notify({
				severity: Severity.Error,
				message: `Could not create the project: ${(e as Error).message}`,
			});
			return;
		}
		// Scaffold a friendly default folder layout so non-developer users have
		// an obvious place for each kind of file from the start. Best-effort:
		// never let this block the project from opening.
		await this.scaffoldProjectTemplate(folderUri);
		// Best-effort: seed a fresh empty roadmap so the new project starts blank.
		// Don't block the reload on it - the folder is all openWindow needs, and
		// aria-roadmap writes this when it activates in the new project window.
		void this.commandService.executeCommand('aria.roadmap.createEmptyAt', folderUri.fsPath);
		try {
			// Onboarding starts on the PROJECT OVERVIEW tab (name + description), which
			// then hands off to the Roadmap. So pulse the Overview icon on this New
			// Project reload - NOT the roadmap (the AI opens the roadmap later, via the
			// aria-overview `open_roadmap` tool). One-shot; a normal restore won't pulse.
			sessionStorage.setItem('aria.overview.pulseOnLoad', '1');
		} catch {
			// Storage unavailable - the user can still open the tabs from the sidebar.
		}
		pushTrail(`createNewProject: calling openWindow(forceReuseWindow) for ${folderUri.fsPath}`);
		this.pickAndDismiss(() => {
			void this.hostService.openWindow([{ folderUri }], { forceReuseWindow: true });
		});
	}

	/**
	 * Create the default project folder layout inside a freshly created New
	 * Project folder. Folders that Qoka features also create lazily (notes/,
	 * paper/, reviews/) are pre-created so the structure is visible from the
	 * start; references/, data/, and downloads/ are new user-facing
	 * conventions. All writes are best-effort and idempotent - a failure here
	 * must never prevent the project from opening.
	 *
	 * Note on `paper/` vs `references/`: `paper/` is app-managed and holds the
	 * manuscripts you write (Paper Writer), one subfolder per manuscript.
	 * `references/` is for papers you save/download to read - kept separate so
	 * the two never collide.
	 */
	private async scaffoldProjectTemplate(folderUri: URI): Promise<void> {
		// `autopipe/` holds pipeline artifacts copied back from the run environment:
		// the pipeline CODE, an input manifest, and run OUTPUTS (see aria-autopipe's
		// project-sync). Scaffolded up front so the layout is there before the first run.
		const dirs = ['notes', 'references', 'data', 'downloads', 'paper', 'reviews', '.qoka',
			'autopipe', 'autopipe/pipelines', 'autopipe/pipelines_input', 'autopipe/pipelines_output'];
		for (const dir of dirs) {
			try {
				await this.fileService.createFolder(URI.joinPath(folderUri, dir));
			} catch { /* best-effort */ }
		}
		try {
			const readme = URI.joinPath(folderUri, 'README.md');
			if (!(await this.fileService.exists(readme))) {
				await this.fileService.writeFile(readme, VSBuffer.fromString(PROJECT_TEMPLATE_README));
			}
		} catch { /* best-effort */ }
		try {
			const marker = URI.joinPath(folderUri, '.qoka', 'project.json');
			if (!(await this.fileService.exists(marker))) {
				const body = JSON.stringify({ createdBy: 'aria', template: 'default', version: 1 }, null, 2) + '\n';
				await this.fileService.writeFile(marker, VSBuffer.fromString(body));
			}
		} catch { /* best-effort */ }
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

		// Drop recents whose folder/workspace no longer exists on disk (deleted
		// locally). VS Code keeps these around on purpose, but here we prune
		// them so the picker never offers a project that can't open. Runs on
		// every render, so it stays current as the overlay is reopened. Only
		// `file` paths are checked - remote/unmounted schemes are left as-is to
		// avoid false positives when a drive is temporarily unavailable.
		const withUris = recents.workspaces
			.map(item => ({
				item,
				uri: isRecentFolder(item)
					? item.folderUri
					: isRecentWorkspace(item)
						? item.workspace.configPath
						: undefined,
			}))
			.filter((x): x is { item: typeof x.item; uri: URI } => !!x.uri);

		const exists = await Promise.all(withUris.map(async x => {
			if (x.uri.scheme !== 'file') {
				return true;
			}
			try {
				return await this.fileService.exists(x.uri);
			} catch {
				return true; // on a check error, keep the entry rather than lose it
			}
		}));

		const missing = withUris.filter((_, i) => !exists[i]).map(x => x.uri);
		if (missing.length) {
			void this.workspacesService.removeRecentlyOpened(missing);
		}

		const all = withUris.filter((_, i) => exists[i]).map(x => x.item);
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

// Register at `Restored` - the same phase firstRunOverlay uses and
// is known to fully resolve every service we inject. Earlier phases
// (`Starting`, `Ready`) silently dropped the contribution because
// IWorkspacesService / IFileDialogService were not yet instantiated.
// The flash that previously made Restored unusable is now prevented
// by the early hide-workbench stylesheet installed at module-load
// time above - so we get late-but-reliable construction without the
// bare-workbench flicker.
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaStartedOverlayContribution, LifecyclePhase.Restored);
