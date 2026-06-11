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
import { AriaSkillsView } from './ariaSkillsView.js';

const ARIA_SKILLS_CONTAINER_ID = 'workbench.view.ariaSkills';

// Activity-bar icon. We register against Codicon.extensions and override
// the glyph with our own square puzzle SVG via the CSS rule below. The
// rule uses `mask-image` so the icon picks up the activity bar's
// `currentColor` automatically, which means light/dark theme switches
// work for free.
const skillsIcon = registerIcon(
	'aria-skills-view',
	Codicon.extensions,
	localize('aria.skills.iconLabel', "Aria Skills activity bar icon")
);

// Lucide-style puzzle piece — the user-approved icon from the earlier
// design pass. Outline only so the `mask-image` rule below can paint it
// with the activity bar's `currentColor`, matching codicon behavior.
const SKILLS_ICON_SVG_DATA_URI = 'data:image/svg+xml;utf8,'
	+ encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" `
		+ `stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`
		+ `<path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704`
		+ `s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925`
		+ `a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.611`
		+ `a2.404 2.404 0 0 1-1.705.706 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29`
		+ `c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02`
		+ `a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704`
		+ `L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259`
		+ `c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998`
		+ `c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968`
		+ `a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"/></svg>`,
	);

registerThemingParticipant((_theme, collector) => {
	const url = `url("${SKILLS_ICON_SVG_DATA_URI}")`;
	collector.addRule(`
		.codicon-aria-skills-view::before {
			content: '';
			display: inline-block;
			width: 24px;
			height: 24px;
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

// Order 4 places Skills directly below Autopipe (order 3) in the activity
// bar. We want both Aria features to sit together so the user perceives
// them as a related cluster.
const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: ARIA_SKILLS_CONTAINER_ID,
		title: localize2('aria.skills.containerTitle', "Skills"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ARIA_SKILLS_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: skillsIcon,
		order: 4,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const skillsView: IViewDescriptor = {
	id: AriaSkillsView.ID,
	name: localize2('aria.skills.viewName', "Skills"),
	containerIcon: skillsIcon,
	ctorDescriptor: new SyncDescriptor(AriaSkillsView),
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([skillsView], viewContainer);
