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
import { ViewContainer, ViewContainerLocation, IViewContainersRegistry, Extensions as ViewContainerExtensions, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { QokaSlidesView } from './qokaSlidesView.js';

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
