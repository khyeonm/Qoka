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
import { AriaChangesView } from './ariaChangesView.js';
import { AriaSnapshotsView } from './ariaSnapshotsView.js';

const ARIA_VERSIONS_CONTAINER_ID = 'workbench.view.ariaVersions';

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
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ARIA_VERSIONS_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: false }]),
		hideIfEmpty: true,
		icon: versionsIcon,
		order: 15,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const easyOnly = ContextKeyExpr.equals('aria.mode', 'easy');

const changesView: IViewDescriptor = {
	id: AriaChangesView.ID,
	name: localize2('aria.versions.changesViewName', "Changes"),
	containerIcon: versionsIcon,
	ctorDescriptor: new SyncDescriptor(AriaChangesView),
	canToggleVisibility: true,
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
	canToggleVisibility: true,
	canMoveView: false,
	order: 2,
	when: easyOnly,
	weight: 40,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([changesView, snapshotsView], viewContainer);
