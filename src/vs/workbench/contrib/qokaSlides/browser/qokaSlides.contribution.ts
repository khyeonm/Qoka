/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { registerThemingParticipant } from '../../../../platform/theme/common/themeService.js';
import { localize2 } from '../../../../nls.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { $, append } from '../../../../base/browser/dom.js';
import { browserLoadingSuppressor } from '../../browserView/common/browserLoadingSuppress.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ViewContainer, ViewContainerLocation, IViewContainersRegistry, Extensions as ViewContainerExtensions, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { QokaSlidesView } from './qokaSlidesView.js';

/** whirick web app: the Slides tab embeds it in the native integrated browser. */
export const WHIRICK_BASE_URL = 'https://whirick.level4.kr';
/**
 * level4 unified SSO login. whirick bounces signed-out users here; after they sign in
 * they are redirected back to WHIRICK_BASE_URL. Kept as its own host so the web view
 * can recognise the login round-trip (loginRequired) and reuse the one Slides tab.
 */
const WHIRICK_LOGIN_HOST = 'sso.level4.kr';
/**
 * Glob that identifies the whirick browser tab, so it is reused (singleton). Matches
 * any level4.kr host so the tab is reused across the whirick <-> SSO login redirect
 * instead of spawning a second tab while the user signs in.
 */
const WHIRICK_URL_FILTER = 'https://*.level4.kr/**';

/** Non-deck top-level whirick routes: their first path segment is NOT a deck slug. */
const WHIRICK_RESERVED_SEGMENTS = new Set(['', 'create', 'new', 'settings', 'folders', 'login', 'logout']);

/** The deck/slide the user currently has open in the whirick web view, if any. */
export interface WhirickWebContext {
	url: string;
	/** Deck slug from the path (e.g. `/abc123/edit` -> `abc123`), or null on a non-deck page. */
	slug: string | null;
	/** 1-based slide number from the `#sN` fragment, or null. */
	slide: number | null;
	/**
	 * True when the web view is sitting on whirick's login page: the user is not
	 * signed in to the Slides tab. Decks are private, so nothing can be shown or
	 * (usefully) built until they log in here - the AI must wait for that first.
	 */
	loginRequired: boolean;
}

/** Parse a whirick URL into the deck slug and slide number it points at. */
export function parseWhirickUrl(url: string): WhirickWebContext {
	let slug: string | null = null;
	let slide: number | null = null;
	let loginRequired = false;
	try {
		const u = new URL(url);
		const seg = u.pathname.split('/').filter(Boolean)[0] ?? '';
		// Signed-out users are bounced to the level4 SSO login host; whirick's own
		// /login path is kept as a fallback. Either way, nothing can be shown until
		// they sign in, so the deck slug stays null.
		if (u.host === WHIRICK_LOGIN_HOST || seg === 'login') {
			loginRequired = true;
		} else if (!WHIRICK_RESERVED_SEGMENTS.has(seg)) {
			slug = seg;
		}
		const m = /^#s(\d+)$/.exec(u.hash);
		if (m) { slide = parseInt(m[1], 10); }
	} catch { /* malformed URL */ }
	return { url, slug, slide, loginRequired };
}

/**
 * Slides - a left-sidebar activity-bar tab. Unlike Memory / Overview (which
 * collapse the sidebar and open a full editor), Slides behaves like the file
 * explorer: selecting its icon opens a sidebar listing this project's decks
 * (QokaSlidesView), and picking one opens the render editor (the qoka-slides
 * extension's webview) in the editor area.
 */

const SLIDES_CONTAINER_ID = 'workbench.view.qokaSlides';

const slidesIcon = registerIcon('qoka-slides-view', Codicon.window, localize2('qoka.slides.iconLabel', "Qoka Slides activity bar icon").value);

// A presentation-board glyph (screen + two content lines + a stand), applied
// over the base codicon via mask-image so the rail shows a slides icon.
const SLIDES_ICON_SVG_DATA_URI = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.7' stroke-linejoin='round' stroke-linecap='round'%3E%3Crect x='3' y='4' width='18' height='12.5' rx='1.6'/%3E%3Cpath d='M7 8.5H13'/%3E%3Cpath d='M7 12H16'/%3E%3Cpath d='M12 16.5V20'/%3E%3Cpath d='M8.5 20.5L12 20L15.5 20.5'/%3E%3C/svg%3E";

registerThemingParticipant((_theme, collector) => {
	const url = `url("${SLIDES_ICON_SVG_DATA_URI}")`;
	collector.addRule(`
		.codicon-qoka-slides-view::before {
			content: '';
			background-color: currentColor;
			-webkit-mask: ${url} no-repeat;
			mask: ${url} no-repeat;
			-webkit-mask-size: contain;
			mask-size: contain;
			-webkit-mask-position: center;
			mask-position: center;
		}
	`);
});

const slidesContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: SLIDES_CONTAINER_ID,
		title: localize2('qoka.slides.containerTitle', "Slides"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SLIDES_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: slidesIcon,
		order: 98,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const slidesView: IViewDescriptor = {
	id: QokaSlidesView.ID,
	name: localize2('qoka.slides.viewName', "Slides"),
	containerIcon: slidesIcon,
	ctorDescriptor: new SyncDescriptor(QokaSlidesView),
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([slidesView], slidesContainer);

/**
 * Open the whirick slide app in the native integrated browser. Slides are managed
 * by whirick (not locally), so the Slides tab is this web view. `path` deep-links
 * within the app (e.g. `/<slug>/edit#s3`); omit it to open the app's home.
 * Reuses the existing whirick tab when one is already open (singleton).
 */
CommandsRegistry.registerCommand('qoka.slides.openWeb', async (accessor, path?: string) => {
	const url = WHIRICK_BASE_URL + (typeof path === 'string' && path ? (path.startsWith('/') ? path : '/' + path) : '');
	await accessor.get(ICommandService).executeCommand('workbench.action.browser.open', {
		url,
		reuseUrlFilter: WHIRICK_URL_FILTER,
	});
});

/**
 * Read what the user currently has open in the whirick web view (deck slug +
 * slide number), so the AI can act on "this deck / this slide". Returns null when
 * no whirick tab is open. Backing command for the qoka-slides MCP get_current_slides.
 */
CommandsRegistry.registerCommand('qoka.slides.getWebContext', (accessor): WhirickWebContext | null => {
	const svc = accessor.get(IBrowserViewWorkbenchService);
	for (const input of svc.getKnownBrowserViews().values()) {
		const url = input.url;
		// Match the whirick app tab, or the SSO login tab it redirects to while signed
		// out (so the AI sees loginRequired rather than "no Slides tab open").
		if (url && (url.startsWith(WHIRICK_BASE_URL) || url.startsWith(`https://${WHIRICK_LOGIN_HOST}`))) {
			return parseWhirickUrl(url);
		}
	}
	return null;
});

/**
 * Slides tab behaves like Memory / Overview: selecting its activity-bar icon opens
 * the whirick web app full-width in the editor area and collapses the sidebar,
 * rather than showing a local list.
 */
const ONBOARDING_SUPPRESS_ID = 'qoka-slides-onboarding';
const ONBOARDING_FONT = 'var(--vscode-font-family, system-ui, sans-serif)';
// Set once the user clicks "Go to slides" - after that, the Slides tab goes straight
// to the web view. Reset it to see the onboarding again. The `.v2` suffix retires the
// pre-level4 "done" flag: whirick moved to a new host + SSO login, so every user should
// re-run the setup once (connect the AI to whirick BEFORE the SSO sign-in).
const ONBOARDING_DONE_KEY = 'qoka.slides.onboardingDone.v2';
// Set by the Codex "Reload Window" button just before the reload, so the onboarding
// re-opens after the window comes back (the reload otherwise destroys it, hiding the
// steps below it). Cleared as soon as it is consumed.
const ONBOARDING_RESUME_KEY = 'qoka.slides.resumeOnboarding';

class QokaSlidesLayoutContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.qoka.slidesLayout';
	private onboardingEl: HTMLElement | undefined;

	constructor(
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._register(this.paneCompositeService.onDidPaneCompositeOpen(e => {
			if (e.viewContainerLocation !== ViewContainerLocation.Sidebar) { return; }
			if (e.composite.getId() === SLIDES_CONTAINER_ID) { void this.openSlides(); }
			else { this.hideOnboarding(); }
		}));
		this._register(toDisposable(() => this.hideOnboarding()));
		// Resume the onboarding after a Codex "Reload Window" so its verification steps
		// and the "Go to slides" button are visible again once the window is back.
		if (this.storageService.getBoolean(ONBOARDING_RESUME_KEY, StorageScope.APPLICATION, false)) {
			this.storageService.remove(ONBOARDING_RESUME_KEY, StorageScope.APPLICATION);
			void this.paneCompositeService.openPaneComposite(SLIDES_CONTAINER_ID, ViewContainerLocation.Sidebar);
		}
	}

	private get onboardingDone(): boolean {
		return this.storageService.getBoolean(ONBOARDING_DONE_KEY, StorageScope.APPLICATION, false);
	}

	/**
	 * Open the whirick web app full-width and collapse the sidebar. Until the user has
	 * finished the onboarding once (clicked "Go to slides"), show the onboarding screen
	 * over the still-hidden web view; after that, go straight to the web view.
	 */
	private async openSlides(): Promise<void> {
		await this.commandService.executeCommand('qoka.slides.openWeb');
		try { this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART); } catch { /* layout not ready */ }
		if (this.onboardingDone) { this.hideOnboarding(); } else { this.showOnboarding(); }
	}

	private showOnboarding(): void {
		if (this.onboardingEl) { return; }
		const container = this.layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
		if (!container) { return; }
		browserLoadingSuppressor.begin(ONBOARDING_SUPPRESS_ID);
		this.onboardingEl = this.buildOnboarding(container);
	}

	private hideOnboarding(): void {
		if (this.onboardingEl) { this.onboardingEl.remove(); this.onboardingEl = undefined; }
		browserLoadingSuppressor.end(ONBOARDING_SUPPRESS_ID);
	}

	private buildOnboarding(container: HTMLElement): HTMLElement {
		const root = append(container, $('.qoka-slides-onboarding'));
		Object.assign(root.style, {
			position: 'absolute', inset: '0', zIndex: '30', overflow: 'auto',
			display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
			background: 'var(--vscode-editor-background, #1e1e1e)', color: 'var(--vscode-foreground)',
			fontFamily: ONBOARDING_FONT, boxSizing: 'border-box', padding: '36px 24px',
		});
		const card = append(root, $('div'));
		Object.assign(card.style, { width: 'min(680px, 100%)', fontSize: '13px', lineHeight: '1.55' });

		const title = append(card, $('div'));
		title.textContent = 'Make slides with AI';
		Object.assign(title.style, { fontSize: '20px', fontWeight: '600', marginBottom: '10px' });
		const intro = append(card, $('div'));
		intro.textContent = 'You create slides by asking the AI in the chat. First, the AI needs to connect to the slide app. This is a one-time setup. Follow the steps for your assistant.';
		Object.assign(intro.style, { opacity: '0.85', marginBottom: '4px' });

		const heading = (text: string): void => {
			const h = append(card, $('div')); h.textContent = text;
			Object.assign(h.style, { fontWeight: '600', margin: '18px 0 8px' });
		};
		const step = (n: string, text: string): void => {
			const row = append(card, $('div'));
			Object.assign(row.style, { display: 'flex', gap: '8px', marginBottom: '5px' });
			const num = append(row, $('div')); num.textContent = n;
			Object.assign(num.style, { flexShrink: '0', opacity: '0.7', minWidth: '14px' });
			const t = append(row, $('div')); t.textContent = text; t.style.flex = '1';
		};
		const note = (text: string): void => {
			const d = append(card, $('div')); d.textContent = text;
			Object.assign(d.style, { opacity: '0.6', fontSize: '12px', margin: '4px 0 0 22px' });
		};
		const button = (label: string, primary: boolean, onClick: () => void): void => {
			const b = append(card, $('button')) as HTMLButtonElement;
			b.textContent = label;
			// 22px left indent aligns the button under the step text (past the number);
			// 0 top / 5px bottom makes the gap above (from the step's 5px marginBottom)
			// equal the gap below (to the next step).
			Object.assign(b.style, {
				display: 'inline-block', margin: '0 0 5px 22px', padding: '6px 14px', fontSize: '13px', fontFamily: ONBOARDING_FONT,
				cursor: 'pointer', borderRadius: '4px',
				border: primary ? 'none' : '1px solid var(--vscode-button-border, rgba(127,127,127,0.45))',
				background: primary ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground, transparent)',
				color: primary ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
			});
			b.onclick = onClick;
		};

		heading('If you use Claude');
		step('1.', 'In the chat, type /mcp');
		step('2.', 'In the "MCP servers" list, pick whirick, then choose Authenticate');
		step('3.', 'Sign in to whirick and approve in the browser that opens');
		note('(No window reload is needed for Claude.)');

		heading('If you use Codex');
		step('1.', 'Click "Connect Codex" below. It registers whirick with Codex and opens a whirick sign-in page.');
		button('Connect Codex', false, () => { void this.commandService.executeCommand('aria.slides.connectWhirickCodex', { skipReloadPrompt: true }); });
		step('2.', 'Approve the sign-in.');
		step('3.', 'Then click "Reload Window" below. Codex connects to whirick only after this reload.');
		button('Reload Window', false, () => {
			this.storageService.store(ONBOARDING_RESUME_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
			void this.commandService.executeCommand('workbench.action.reloadWindow');
		});

		const hr = append(card, $('div'));
		Object.assign(hr.style, { height: '1px', background: 'var(--vscode-editorWidget-border, rgba(127,127,127,0.25))', margin: '24px 0 6px' });

		heading('Is your assistant connected?');
		const check = append(card, $('div'));
		check.textContent = 'Check first, so the slides work right away:';
		Object.assign(check.style, { opacity: '0.85', marginBottom: '4px' });
		step('-', 'Claude: ask it "Can you use the whirick tools now?". If it says yes, you are connected (no reload needed).');
		step('-', 'Codex: after the reload, ask it "Can you use the whirick tools now?". If it says yes, you are connected.');

		const go = append(card, $('div'));
		go.textContent = 'When your assistant confirms it is connected, open the slides, you will sign in to whirick there.';
		Object.assign(go.style, { marginTop: '16px', marginBottom: '5px', opacity: '0.85' });
		button('Go to slides', true, () => {
			this.storageService.store(ONBOARDING_DONE_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
			this.hideOnboarding();
		});

		return root;
	}
}

/**
 * Re-open the Slides onboarding on demand (from the Settings "Slides" section), for a
 * user whose AI has lost its whirick connection: reset the "done" flag and open the
 * Slides tab, which then shows the onboarding again.
 */
CommandsRegistry.registerCommand('qoka.slides.showSetupGuide', async (accessor) => {
	accessor.get(IStorageService).store(ONBOARDING_DONE_KEY, false, StorageScope.APPLICATION, StorageTarget.USER);
	await accessor.get(IPaneCompositePartService).openPaneComposite(SLIDES_CONTAINER_ID, ViewContainerLocation.Sidebar, true);
});

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(QokaSlidesLayoutContribution, LifecyclePhase.Restored);
