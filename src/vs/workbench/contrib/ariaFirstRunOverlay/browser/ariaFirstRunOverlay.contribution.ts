/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';

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
 *  window, assume there's nothing to set up and dismiss the overlay. */
const INITIAL_SETTLE_MS = 8000;

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

	constructor(@ICommandService private readonly commandService: ICommandService) {
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

		// Auto-show on workbench mount. We deliberately don't wait for
		// any extension trigger — the goal is to block interaction
		// before the user can poke things mid-setup.
		this.show();
		this.settleTimer = setTimeout(() => this.finish(), INITIAL_SETTLE_MS);
	}

	private beginTracking(name: string): void {
		if (this.finished) {
			// Late-arriving extension — bring the overlay back. This is
			// rare (extensions normally beat the initial settle window)
			// but resilient if it does happen.
			this.finished = false;
			this.show();
		}
		if (this.firstTrackAt === undefined) {
			this.firstTrackAt = Date.now();
		}
		if (this.settleTimer) {
			clearTimeout(this.settleTimer);
			this.settleTimer = undefined;
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
		if (drained.length > 0) {
			void this.commandService.executeCommand('aria.startup.showSummaryToast', drained);
		}
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
