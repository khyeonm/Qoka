/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { localize, localize2 } from '../../../../nls.js';
import { ViewContainer, ViewContainerLocation, IViewContainersRegistry, Extensions as ViewContainerExtensions, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IAction } from '../../../../base/common/actions.js';
import { IActionViewItem } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AriaVersionsView } from './ariaVersionsView.js';
import { registerAriaTabHelpContainerTitleAction, createAriaHelpTitleActionViewItem } from '../../aria/browser/ariaHelpEditor.js';

const ARIA_VERSIONS_CONTAINER_ID = 'workbench.view.ariaVersions';

/**
 * Versions is a SINGLE merged view (Changes + Snapshots in one body) with
 * `mergeViewWithContainerWhenSingleView: true`, so the container shows just the
 * "Versions" title - no collapsible sub-headers. The "How to use?" link lives in
 * the container title bar; this subclass renders it as a blue text link. It adds
 * no constructor, so it inherits ViewPaneContainer's injected dependencies.
 */
class AriaVersionsViewPaneContainer extends ViewPaneContainer {
	override getActionViewItem(action: IAction, options: IBaseActionViewItemOptions): IActionViewItem | undefined {
		return createAriaHelpTitleActionViewItem(action, 'versions', options ?? {})
			?? super.getActionViewItem(action, options);
	}
}

const versionsIcon = registerIcon(
	'aria-versions-view',
	Codicon.archive,
	localize('aria.versions.iconLabel', "Aria Versions activity bar icon")
);

// Single merged view → `mergeViewWithContainerWhenSingleView: true` collapses the
// view into the container: one "Versions" title, no sub-header, no collapse toggle.
const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: ARIA_VERSIONS_CONTAINER_ID,
		title: localize2('aria.versions.containerTitle', "Versions"),
		ctorDescriptor: new SyncDescriptor(AriaVersionsViewPaneContainer, [ARIA_VERSIONS_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: true,
		icon: versionsIcon,
		order: 15,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const easyOnly = ContextKeyExpr.equals('aria.mode', 'easy');

const versionsView: IViewDescriptor = {
	id: AriaVersionsView.ID,
	name: localize2('aria.versions.viewName', "Versions"),
	containerIcon: versionsIcon,
	ctorDescriptor: new SyncDescriptor(AriaVersionsView),
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
	when: easyOnly,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([versionsView], viewContainer);

// "How to use?" link in the container title bar (right of the "VERSIONS" title).
registerAriaTabHelpContainerTitleAction(ARIA_VERSIONS_CONTAINER_ID, 'versions');
