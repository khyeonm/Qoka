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
import { ViewContainer, ViewContainerLocation, IViewContainersRegistry, Extensions as ViewContainerExtensions, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { QokaLoopView } from './qokaLoopView.js';
// Registers the `qoka.loop.markOpen` command the extension calls to say which loop's detail is open.
import './qokaLoopOpenState.js';

/**
 * Qoka Loops - a left activity-bar tab. Selecting its rail icon opens a SIDEBAR list of this
 * project's research loops (QokaLoopView); clicking a loop opens its DETAIL in the editor area
 * (the qoka-loop extension's `qoka.loop.open` command) - the same sidebar-list -> editor-detail
 * pattern the Manuscript tab uses. The detail is display-only; loop control (design, approve,
 * run, stop) all happens in the chat.
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
