/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { localize, localize2 } from '../../../../nls.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ViewContainer, ViewContainerLocation, IViewContainersRegistry, Extensions as ViewContainerExtensions, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { AriaProjectOverviewView } from './ariaProjectOverviewView.js';

/**
 * Project Overview - the top-most left-sidebar tab (above Explorer). One place to
 * run the whole project: an editable Title + Summary, a static picture of the
 * Roadmap (overall flow), and a To-do checklist the AI assistant helps keep up to
 * date (it proposes completions in the chat AND surfaces them here for Accept /
 * Reject). Data lives per-project at <workspace>/.aria/overview.json.
 */

const OVERVIEW_CONTAINER_ID = 'workbench.view.ariaProjectOverview';

// "checklist" codicon = a box/list with checkmarks, the closest built-in glyph to
// the requested checkbox icon.
const overviewIcon = registerIcon('aria-project-overview-view', Codicon.checklist, localize('aria.overview.iconLabel', "Aria Project Overview activity bar icon"));

const overviewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: OVERVIEW_CONTAINER_ID,
		title: localize2('aria.overview.containerTitle', "Project Overview"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [OVERVIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: overviewIcon,
		// Negative order so the activity-bar icon sorts ABOVE Explorer (order 0).
		order: -10,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const overviewView: IViewDescriptor = {
	id: AriaProjectOverviewView.ID,
	name: localize2('aria.overview.viewName', "Project Overview"),
	containerIcon: overviewIcon,
	ctorDescriptor: new SyncDescriptor(AriaProjectOverviewView),
	canToggleVisibility: true,
	canMoveView: true,
	// Only meaningful with a project folder open (overview lives in <project>/.aria/).
	when: ContextKeyExpr.notEquals('workbenchState', 'empty'),
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([overviewView], overviewContainer);

// --- Project Overview activity-bar icon pulse ------------------------------

/**
 * On a freshly created project, draw the user to the Project Overview tab (the
 * onboarding entry point) by pulsing its left activity-bar icon until they open
 * it. New Project sets a one-shot sessionStorage flag; a normal restore does not.
 */
const OVERVIEW_PULSE_CLASS = 'aria-overview-pulse';

class AriaProjectOverviewPulseContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.projectOverviewPulse';

	private pulsing = false;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super();
		this.installStyles();

		let requested = false;
		try {
			if (sessionStorage.getItem('aria.overview.pulseOnLoad') === '1') {
				sessionStorage.removeItem('aria.overview.pulseOnLoad');
				requested = true;
			}
		} catch { /* storage unavailable - just don't pulse */ }

		if (requested && !this.viewsService.isViewVisible(AriaProjectOverviewView.ID)) {
			this.start();
		}

		// Stop once the user opens the Project Overview view - they got the hint.
		this._register(this.viewsService.onDidChangeViewVisibility(e => {
			if (e.id === AriaProjectOverviewView.ID && e.visible) {
				this.stop();
			}
		}));
		this._register(toDisposable(() => this.stop()));
	}

	private start(): void {
		if (this.pulsing) { return; }
		this.pulsing = true;
		this.layoutService.mainContainer.classList.add(OVERVIEW_PULSE_CLASS);
	}

	private stop(): void {
		if (!this.pulsing) { return; }
		this.pulsing = false;
		this.layoutService.mainContainer.classList.remove(OVERVIEW_PULSE_CLASS);
	}

	private installStyles(): void {
		const style = createStyleSheet();
		style.textContent = `
@keyframes aria-overview-pulse-kf {
	0%, 100% { transform: translateY(0); }
	50%      { transform: translateY(-4px); }
}
.${OVERVIEW_PULSE_CLASS} .activitybar .action-item[data-aria-composite-id="${OVERVIEW_CONTAINER_ID}"] {
	background-color: rgba(255, 193, 7, 0.95);
	border-radius: 6px;
	animation: aria-overview-pulse-kf 0.7s ease-in-out infinite;
}
.${OVERVIEW_PULSE_CLASS} .activitybar .action-item[data-aria-composite-id="${OVERVIEW_CONTAINER_ID}"] .action-label {
	color: #1e1e1e !important;
}
`;
		this._register(toDisposable(() => style.remove()));
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaProjectOverviewPulseContribution, LifecyclePhase.Restored);
