/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';

/**
 * Full-screen "Aria is setting up" overlay. We mount a fixed div at the
 * top of <body> on workbench mount, blocking clicks and keyboard focus
 * underneath. The overlay stays up until every extension that opted into
 * tracking has reported completion — there is NO arbitrary safety
 * timeout, so the screen only clears when setup is genuinely done.
 *
 * Tracking commands:
 *   aria.startup.beginTracking(name)              — extension says "I'm setting up"
 *   aria.startup.markComplete(name, summary, ch)  — extension says "I'm done"
 *
 * Legacy commands (still supported for back-compat with the first-run
 * wizard's earlier integration):
 *   aria.firstRun.showOverlay()    — alias for beginTracking('aria-first-run-legacy')
 *   aria.firstRun.updateOverlay(s) — replace the secondary line of text
 *   aria.firstRun.hideOverlay()    — alias for markComplete('aria-first-run-legacy', '', false)
 *
 * When the tracking set is empty (and stays empty for POST_TRACKING_SETTLE_MS
 * so a slow-activating extension can still register), the overlay fades
 * out and we forward the collected summaries to the workbench command
 * `aria.startup.showSummaryToast` — an extension-side command shows the
 * toast itself because the workbench can't open a native VS Code modal.
 */

const OVERLAY_ID = 'aria-startup-overlay';

/** Short pause after the tracking set empties before we declare done.
 *  Cushions against extensions that activate a beat after the others. */
const POST_TRACKING_SETTLE_MS = 2000;

/** Initial cushion: if no extension calls beginTracking within this
 *  window, assume there's nothing to set up and dismiss the overlay.
 *  Sized generously so a slow-activating extension (e.g. autopipe on
 *  onStartupFinished) has time to register before we declare done —
 *  otherwise the overlay would fade out at 8s and our late-arrival
 *  guard in beginTracking would leave the user staring at the bare
 *  workbench while setup continues invisibly in the background. */
const INITIAL_SETTLE_MS = 30000;

/**
 * Minimum visible time after the FIRST beginTracking call. Without this,
 * a quick-activating extension (paper-search via onCommand) finishes
 * before a slower one (autopipe via onStartupFinished) even starts —
 * tracking goes empty, settle fires, overlay fades out, then the slow
 * extension begins and the overlay snaps back. The user-visible effect
 * is a flicker. Holding the overlay for at least 5s after the first
 * tracking call gives every reasonable extension a chance to register.
 */
const MIN_DURATION_AFTER_FIRST_TRACK_MS = 5000;

/** localStorage key for summaries that completed while the Started
 *  overlay was up. Setup runs in the background during Started, but
 *  the workbench-hide stylesheet that locks the screen also hides the
 *  notification VS Code would have raised — so the toast we dispatched
 *  would have been invisible. Instead we stash the summaries here, and
 *  the next window (the project window that vscode.openFolder reloads
 *  into) reads them on construction and shows the toast there. */
const PENDING_SUMMARIES_KEY = 'aria.startup.pendingSummaries';

interface SetupSummary {
	name: string;
	summary: string;
	changed: boolean;
}

class AriaFirstRunOverlayContribution extends Disposable implements IWorkbenchContribution {

	private overlay: HTMLDivElement | undefined;
	private subtitleEl: HTMLDivElement | undefined;
	private tracking = new Set<string>();
	private summaries: SetupSummary[] = [];
	private settleTimer: ReturnType<typeof setTimeout> | undefined;
	private finished = false;
	/** Wall-clock time of the first beginTracking. Used to enforce
	 *  MIN_DURATION_AFTER_FIRST_TRACK_MS so we don't flicker. */
	private firstTrackAt: number | undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();

		// Tracking-based commands — the canonical entry points.
		CommandsRegistry.registerCommand('aria.startup.beginTracking', (_accessor, name?: string) => {
			if (typeof name !== 'string' || !name) {
				return;
			}
			this.beginTracking(name);
		});
		CommandsRegistry.registerCommand('aria.startup.markComplete', (_accessor, name?: string, summary?: string, changed?: boolean) => {
			if (typeof name !== 'string' || !name) {
				return;
			}
			this.markComplete(name, typeof summary === 'string' ? summary : '', !!changed);
		});

		// Legacy aliases — keep the first-run wizard working without
		// requiring a touch to that file. `showOverlay` re-enters the
		// tracking set; `hideOverlay` exits it. The subtitle helper
		// stays as a pure UI poke.
		CommandsRegistry.registerCommand('aria.firstRun.showOverlay', (_accessor, message?: string) => {
			if (typeof message === 'string') {
				this.updateSubtitle(message);
			}
			this.beginTracking('aria-first-run-legacy');
		});
		CommandsRegistry.registerCommand('aria.firstRun.updateOverlay', (_accessor, message?: string) => {
			this.updateSubtitle(typeof message === 'string' ? message : '');
		});
		CommandsRegistry.registerCommand('aria.firstRun.hideOverlay', () => {
			this.markComplete('aria-first-run-legacy', '', false);
		});

		// Show the overlay only when a workspace folder is open. The
		// Started page (Aria Start Page editor) takes over the screen
		// when no folder is loaded, so we don't need a separate blocker
		// then — the page itself absorbs user input while setup runs.
		// When a folder *is* open, the user expects the workbench to be
		// usable immediately, so we keep the overlay up until setup
		// finishes.
		//
		// In both cases we still run the settle timer so finish() fires
		// and the summary toast is delivered when tracked extensions
		// complete.
		if (this.shouldShowOverlay()) {
			// Project window — inherit any summaries the Started-window
			// finish() persisted, so finish() here dispatches the toast
			// with both the Started-window run and this window's run.
			this.loadPendingSummaries();
			this.show();
		}
		this.settleTimer = setTimeout(() => this.finish(), INITIAL_SETTLE_MS);
	}

	private loadPendingSummaries(): void {
		let raw: string | null;
		try {
			raw = localStorage.getItem(PENDING_SUMMARIES_KEY);
		} catch {
			return;
		}
		if (!raw) {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			// Corrupt payload — drop it so it doesn't keep failing.
			try { localStorage.removeItem(PENDING_SUMMARIES_KEY); } catch { /* ignore */ }
			return;
		}
		if (!Array.isArray(parsed)) {
			return;
		}
		for (const entry of parsed) {
			if (!entry || typeof entry !== 'object') {
				continue;
			}
			const e = entry as Record<string, unknown>;
			if (typeof e.name === 'string' && typeof e.summary === 'string' && e.summary) {
				this.summaries.push({
					name: e.name,
					summary: e.summary,
					changed: !!e.changed,
				});
			}
		}
	}

	private savePendingSummaries(summaries: SetupSummary[]): void {
		try {
			localStorage.setItem(PENDING_SUMMARIES_KEY, JSON.stringify(summaries));
		} catch {
			// Storage unavailable — nothing we can do; the toast just
			// won't appear in the next window. Not worth crashing over.
		}
	}

	private clearPendingSummaries(): void {
		try {
			localStorage.removeItem(PENDING_SUMMARIES_KEY);
		} catch {
			// ignore
		}
	}

	private shouldShowOverlay(): boolean {
		// EMPTY workbench == no folder, no workspace file. Started page
		// is shown in this case and serves as the "we're getting ready"
		// surface.
		return this.workspaceContextService.getWorkbenchState() !== WorkbenchState.EMPTY;
	}

	private beginTracking(name: string): void {
		// Once we've already finished and hidden the overlay, do NOT
		// re-summon it. A late-arriving beginTracking used to flash the
		// loading screen back on, producing the "loading appears,
		// disappears, appears again" sequence the user sees on slow
		// extension activations. The tracker still records the name so
		// markComplete / the summary toast behave consistently.
		if (!this.finished) {
			if (this.firstTrackAt === undefined) {
				this.firstTrackAt = Date.now();
			}
			if (this.settleTimer) {
				clearTimeout(this.settleTimer);
				this.settleTimer = undefined;
			}
		}
		this.tracking.add(name);
	}

	private markComplete(name: string, summary: string, changed: boolean): void {
		this.tracking.delete(name);
		if (summary) {
			this.summaries.push({ name, summary, changed });
		}
		if (this.tracking.size === 0) {
			if (this.settleTimer) {
				clearTimeout(this.settleTimer);
			}
			this.settleTimer = setTimeout(() => this.finish(), POST_TRACKING_SETTLE_MS);
		}
	}

	private updateSubtitle(message: string): void {
		if (this.subtitleEl) {
			this.subtitleEl.textContent = message || 'This usually takes a moment.';
		}
	}

	private finish(): void {
		if (this.finished) {
			return;
		}

		// Enforce minimum visible duration after the first beginTracking
		// so a fast extension doesn't dismiss the overlay before slower
		// ones get a chance to register. Without this we'd flicker.
		if (this.firstTrackAt !== undefined) {
			const elapsed = Date.now() - this.firstTrackAt;
			const remaining = MIN_DURATION_AFTER_FIRST_TRACK_MS - elapsed;
			if (remaining > 0) {
				if (this.settleTimer) {
					clearTimeout(this.settleTimer);
				}
				this.settleTimer = setTimeout(() => this.finish(), remaining);
				return;
			}
		}

		this.finished = true;
		if (this.settleTimer) {
			clearTimeout(this.settleTimer);
			this.settleTimer = undefined;
		}
		this.hide();
		// Drain the buffered summaries; if any survived, hand them to
		// the toast command. We snapshot + reset so a late-arriving
		// beginTracking starts a fresh round.
		const drained = this.summaries;
		this.summaries = [];
		if (drained.length === 0) {
			return;
		}

		// Started-window path (EMPTY workspace): the toast would render
		// behind the Started overlay's hide-workbench stylesheet and the
		// user would never see it. Persist instead, so the next window
		// (the project window vscode.openFolder reloads into) picks it
		// up via loadPendingSummaries() and dispatches the toast there.
		if (!this.shouldShowOverlay()) {
			// Overwrite — each Aria launch's run is the freshest view of
			// what the user should see when they finally open a project.
			this.savePendingSummaries(drained);
			return;
		}

		// Project-window path: clear the persisted handoff (we just
		// merged it into `drained` at constructor time) and dispatch.
		// Dedupe by name so identical entries from the Started run and
		// this run don't double up; the current run's entry is the
		// authoritative one because it reflects the latest tracking
		// outcome — Map.set on a later iteration overwrites the
		// previous insertion's value but preserves order, so the
		// fresher result wins and the toast stays one-line-per-source.
		this.clearPendingSummaries();
		const byName = new Map<string, SetupSummary>();
		for (const entry of drained) {
			byName.set(entry.name, entry);
		}
		const deduped = [...byName.values()];
		void this.commandService.executeCommand('aria.startup.showSummaryToast', deduped);
	}

	private show(): void {
		if (this.overlay) {
			return;
		}

		const overlay = document.createElement('div');
		overlay.id = OVERLAY_ID;
		overlay.style.position = 'fixed';
		overlay.style.inset = '0';
		overlay.style.background = 'rgba(0, 0, 0, 0.78)';
		overlay.style.backdropFilter = 'blur(2px)';
		(overlay.style as unknown as Record<string, string>).webkitBackdropFilter = 'blur(2px)';
		overlay.style.zIndex = '999999';
		overlay.style.display = 'flex';
		overlay.style.flexDirection = 'column';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';
		overlay.style.color = '#fff';
		overlay.style.fontFamily = 'var(--vscode-font-family, system-ui, sans-serif)';
		overlay.style.cursor = 'wait';
		overlay.style.transition = 'opacity 200ms ease-in';
		overlay.style.opacity = '0';

		const spinner = document.createElement('div');
		spinner.style.width = '44px';
		spinner.style.height = '44px';
		spinner.style.border = '3px solid rgba(255, 255, 255, 0.2)';
		spinner.style.borderTopColor = '#fff';
		spinner.style.borderRadius = '50%';
		spinner.style.animation = 'aria-first-run-spin 1.1s linear infinite';
		spinner.style.marginBottom = '24px';
		overlay.appendChild(spinner);

		const title = document.createElement('div');
		title.textContent = 'Setting up Aria';
		title.style.fontSize = '20px';
		title.style.fontWeight = '600';
		title.style.marginBottom = '8px';
		overlay.appendChild(title);

		const subtitleEl = document.createElement('div');
		subtitleEl.textContent = 'This usually takes a moment.';
		subtitleEl.style.fontSize = '13px';
		subtitleEl.style.opacity = '0.85';
		overlay.appendChild(subtitleEl);
		this.subtitleEl = subtitleEl;

		this.ensureKeyframes();
		this.installFocusTrap(overlay);

		document.body.appendChild(overlay);
		this.overlay = overlay;

		requestAnimationFrame(() => {
			overlay.style.opacity = '1';
		});
	}

	private hide(): void {
		const overlay = this.overlay;
		if (!overlay) {
			return;
		}
		this.overlay = undefined;
		this.subtitleEl = undefined;
		overlay.style.opacity = '0';
		setTimeout(() => {
			overlay.remove();
		}, 220);
	}

	private ensureKeyframes(): void {
		if (document.getElementById('aria-first-run-keyframes')) {
			return;
		}
		const style = document.createElement('style');
		style.id = 'aria-first-run-keyframes';
		style.textContent = `
			@keyframes aria-first-run-spin {
				from { transform: rotate(0deg); }
				to { transform: rotate(360deg); }
			}
		`;
		document.head.appendChild(style);
	}

	private installFocusTrap(overlay: HTMLDivElement): void {
		const swallow = (e: Event) => {
			if (overlay.contains(e.target as Node)) {
				return;
			}
			e.stopPropagation();
			e.preventDefault();
		};
		overlay.addEventListener('keydown', swallow, true);
		overlay.addEventListener('click', swallow, true);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaFirstRunOverlayContribution, LifecyclePhase.Restored);
