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
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ViewContainer, ViewContainerLocation, IViewContainersRegistry, Extensions as ViewContainerExtensions, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { QokaSlidesView } from './qokaSlidesView.js';

/** whirick web app: the Slides tab embeds it in the native integrated browser. */
export const WHIRICK_BASE_URL = 'https://slides.pnucolab.com';
/** Glob that identifies the whirick browser tab, so it is reused (singleton). */
const WHIRICK_URL_FILTER = 'https://slides.pnucolab.com/**';

/** Non-deck top-level whirick routes: their first path segment is NOT a deck slug. */
const WHIRICK_RESERVED_SEGMENTS = new Set(['', 'create', 'new', 'settings', 'folders', 'login', 'logout']);

/** The deck/slide the user currently has open in the whirick web view, if any. */
export interface WhirickWebContext {
	url: string;
	/** Deck slug from the path (e.g. `/abc123/edit` -> `abc123`), or null on a non-deck page. */
	slug: string | null;
	/** 1-based slide number from the `#sN` fragment, or null. */
	slide: number | null;
}

/** Parse a whirick URL into the deck slug and slide number it points at. */
export function parseWhirickUrl(url: string): WhirickWebContext {
	let slug: string | null = null;
	let slide: number | null = null;
	try {
		const u = new URL(url);
		const seg = u.pathname.split('/').filter(Boolean)[0] ?? '';
		if (!WHIRICK_RESERVED_SEGMENTS.has(seg)) { slug = seg; }
		const m = /^#s(\d+)$/.exec(u.hash);
		if (m) { slide = parseInt(m[1], 10); }
	} catch { /* malformed URL */ }
	return { url, slug, slide };
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
		if (url && url.startsWith(WHIRICK_BASE_URL)) {
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
class QokaSlidesLayoutContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.qoka.slidesLayout';

	constructor(
		@IPaneCompositePartService paneCompositeService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this._register(paneCompositeService.onDidPaneCompositeOpen(e => {
			if (e.viewContainerLocation !== ViewContainerLocation.Sidebar) { return; }
			if (e.composite.getId() === SLIDES_CONTAINER_ID) {
				void this.commandService.executeCommand('qoka.slides.openWeb');
				try { this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART); } catch { /* layout not ready */ }
			}
		}));
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(QokaSlidesLayoutContribution, LifecyclePhase.Restored);
