/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { registerThemingParticipant } from '../../../../platform/theme/common/themeService.js';
import { localize, localize2 } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ViewContainer, ViewContainerLocation, IViewContainersRegistry, Extensions as ViewContainerExtensions, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { QokaLoopView } from './qokaLoopView.js';

/**
 * Qoka Loops - a left activity-bar tab. Selecting its rail icon opens the Research Loop
 * Engine's full-width Loops view (the qoka-loop extension's "Qoka Loops" webview, opened via
 * the `qoka.loop.open` command) and collapses the sidebar - the same rail-icon -> centered-
 * editor pattern Memory / Project Overview use. The tab is display-only; loop control (design,
 * approve, run) all happens in the chat.
 */

const QOKA_LOOP_CONTAINER_ID = 'workbench.view.qokaLoop';

// Base codicon, overridden below with a circular-arrows (repeat/loop) SVG via mask-image so
// the glyph follows the activity bar's theme color (selected vs dimmed, light vs dark).
const loopIcon = registerIcon('qoka-loop-view', Codicon.sync, localize('qoka.loop.iconLabel', "Qoka Loops activity bar icon"));

// A two-arrow circular "loop / repeat" glyph (Feather refresh-cw geometry), inlined as a
// URL-encoded SVG data URI so the workbench bundle has no external asset. Rendered via
// mask-image, which masks by the stroke's alpha, so the drawn arrows take the theme color.
const LOOP_ICON_SVG_DATA_URI = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='-1 -1 26 26' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='23 4 23 10 17 10'/%3E%3Cpolyline points='1 20 1 14 7 14'/%3E%3Cpath d='M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15'/%3E%3C/svg%3E";

registerThemingParticipant((_theme, collector) => {
	const url = `url("${LOOP_ICON_SVG_DATA_URI}")`;
	collector.addRule(`
		.codicon-qoka-loop-view::before {
			content: '';
			display: inline-block;
			width: 28px;
			height: 28px;
			background-color: currentColor;
			-webkit-mask-image: ${url};
			mask-image: ${url};
			-webkit-mask-repeat: no-repeat;
			mask-repeat: no-repeat;
			-webkit-mask-size: contain;
			mask-size: contain;
			-webkit-mask-position: center;
			mask-position: center;
		}
	`);
});

const loopContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: QOKA_LOOP_CONTAINER_ID,
		title: localize2('qoka.loop.containerTitle', "Loops"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [QOKA_LOOP_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: loopIcon,
		// Just above Memory (order 99) / Settings (order 100) at the bottom of the activity bar.
		order: 98,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const loopView: IViewDescriptor = {
	id: QokaLoopView.ID,
	name: localize2('qoka.loop.viewName', "Loops"),
	containerIcon: loopIcon,
	ctorDescriptor: new SyncDescriptor(QokaLoopView),
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([loopView], loopContainer);

// --- Full-width layout orchestration ----------------------------------------
// Selecting the rail tab opens the extension's Loops webview as a centered editor and hides
// the (placeholder) sidebar, so the rail icon behaves like Memory / Project Overview.

class QokaLoopLayoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.qoka.loopLayout';

	constructor(
		@IPaneCompositePartService paneCompositeService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this._register(paneCompositeService.onDidPaneCompositeOpen(e => {
			if (e.viewContainerLocation !== ViewContainerLocation.Sidebar) { return; }
			if (e.composite.getId() === QOKA_LOOP_CONTAINER_ID) {
				// `qoka.loop.open` is contributed by the qoka-loop extension; executing it opens
				// (or reveals) the "Qoka Loops" webview editor and activates the extension if idle.
				void this.commandService.executeCommand('qoka.loop.open');
				try { this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART); } catch { /* layout not ready */ }
			}
		}));
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(QokaLoopLayoutContribution, LifecyclePhase.Restored);
