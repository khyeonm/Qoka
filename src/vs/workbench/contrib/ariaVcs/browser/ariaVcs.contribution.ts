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
import { AriaChangesView } from './ariaChangesView.js';
import { AriaSnapshotsView } from './ariaSnapshotsView.js';
import { registerAriaTabHelpContainerTitleAction, createAriaHelpTitleActionViewItem } from '../../aria/browser/ariaHelpEditor.js';

const ARIA_VERSIONS_CONTAINER_ID = 'workbench.view.ariaVersions';

/**
 * Versions uses `mergeViewWithContainerWhenSingleView: false` (two sub-panels),
 * so the "How to use?" link lives in the CONTAINER title bar. This subclass
 * renders that container-title action as a blue text link. It adds no
 * constructor, so it inherits ViewPaneContainer's injected dependencies.
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

// We disable `mergeViewWithContainerWhenSingleView` because the container
// always hosts both Changes and Snapshots: we want the standard "view header
// + drag-to-resize" treatment with two visible sub-panels.
const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: ARIA_VERSIONS_CONTAINER_ID,
		title: localize2('aria.versions.containerTitle', "Versions"),
		ctorDescriptor: new SyncDescriptor(AriaVersionsViewPaneContainer, [ARIA_VERSIONS_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: false }]),
		hideIfEmpty: true,
		icon: versionsIcon,
		order: 15,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const easyOnly = ContextKeyExpr.equals('aria.mode', 'easy');

// canToggleVisibility is false so the container title bar shows no "..." overflow
// (the Views submenu is dropped when nothing is toggleable) — Changes and
// Snapshots stay split and always visible by default.
const changesView: IViewDescriptor = {
	id: AriaChangesView.ID,
	name: localize2('aria.versions.changesViewName', "Changes"),
	containerIcon: versionsIcon,
	ctorDescriptor: new SyncDescriptor(AriaChangesView),
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
	when: easyOnly,
	weight: 60,
};

const snapshotsView: IViewDescriptor = {
	id: AriaSnapshotsView.ID,
	name: localize2('aria.versions.snapshotsViewName', "Snapshots"),
	containerIcon: versionsIcon,
	ctorDescriptor: new SyncDescriptor(AriaSnapshotsView),
	canToggleVisibility: false,
	canMoveView: false,
	order: 2,
	when: easyOnly,
	weight: 40,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([changesView, snapshotsView], viewContainer);

// "How to use?" link in the container title bar (right of the "VERSIONS" title).
registerAriaTabHelpContainerTitleAction(ARIA_VERSIONS_CONTAINER_ID, 'versions');
