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
import {
	ViewContainer, ViewContainerLocation,
	IViewContainersRegistry, Extensions as ViewContainerExtensions,
	IViewsRegistry, Extensions as ViewExtensions,
	IViewDescriptor,
} from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { AriaAutopipeView } from './ariaAutopipeView.js';
import { registerAriaTabHelpTitleAction } from '../../aria/browser/ariaHelpEditor.js';

const ARIA_AUTOPIPE_CONTAINER_ID = 'workbench.view.ariaAutopipe';

// We register the icon against an arbitrary Codicon as a fallback so VS Code's
// icon registry is happy. The actual glyph the user sees in the activity bar
// is provided by the CSS injection below - that override replaces the codicon
// font character with our pipe-A SVG, rendered via mask-image so it still
// follows the theme color (selected vs. dimmed, light vs. dark).
const autopipeIcon = registerIcon(
	'aria-autopipe-view',
	Codicon.symbolEvent,
	localize('aria.autopipe.iconLabel', "Qoka Autopipe activity bar icon")
);

// Activity bar glyph. The user-supplied artwork is a 64×64 PNG with the
// "A" drawn in opaque pixels on a transparent background, so it works as
// a CSS `mask-image` source - the alpha channel selects which pixels get
// painted with the activity bar's `currentColor`. We embed it inline as
// a data URI so the workbench bundle has no external asset dependency.
const AUTOPIPE_ICON_PNG_DATA_URI = 'data:image/png;base64,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';

// Inject a theme-aware CSS rule that swaps the codicon glyph for our pipe-A
// SVG anywhere the `aria-autopipe-view` icon is rendered. Using mask-image
// keeps the icon monochrome and theme-following - the activity bar passes
// its own `color` down to the pseudo-element which becomes the mask's fill
// via `background-color`.
registerThemingParticipant((_theme, collector) => {
	const url = `url("${AUTOPIPE_ICON_PNG_DATA_URI}")`;
	// 22px matches the activity-bar codicon visual size more closely than the
	// 16px default; the codicon font glyphs are designed against a 16px box
	// but rendered upscaled in the activity bar, so a raster-style mask
	// needs the bigger square to read as the same weight.
	collector.addRule(`
		.codicon-aria-autopipe-view::before {
			content: '';
			display: inline-block;
			width: 32px;
			height: 32px;
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

// The activity-bar ordering for custom containers in VS Code is "higher
// order shown earlier" (Versions sits at 2 and appears before us in tests
// when we used 1.5). We want Autopipe between Search and Versions, so we
// pick a value larger than Versions' 2. Picking 3 leaves room for future
// containers and keeps Versions next to Autopipe.
const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: ARIA_AUTOPIPE_CONTAINER_ID,
		title: localize2('aria.autopipe.containerTitle', "Autopipe"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ARIA_AUTOPIPE_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: autopipeIcon,
		order: 14,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const autopipeView: IViewDescriptor = {
	id: AriaAutopipeView.ID,
	name: localize2('aria.autopipe.viewName', "Autopipe"),
	containerIcon: autopipeIcon,
	ctorDescriptor: new SyncDescriptor(AriaAutopipeView),
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([autopipeView], viewContainer);

// "How to use?" link in the view's title bar (right of the "AUTOPIPE" title).
registerAriaTabHelpTitleAction(AriaAutopipeView.ID, 'autopipe');
