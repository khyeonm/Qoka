/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { localize, localize2 } from '../../../../nls.js';
import {
	ViewContainer, ViewContainerLocation,
	IViewContainersRegistry, Extensions as ViewContainerExtensions,
	IViewsRegistry, Extensions as ViewExtensions,
	IViewDescriptor,
} from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { AriaConnectionsView } from './ariaConnectionsView.js';

const ARIA_CONNECTIONS_CONTAINER_ID = 'workbench.view.ariaConnections';

// Activity-bar glyph: a plain server codicon (NOT the settings gear). Represents
// the built-in server + SSH servers this tab manages, and is distinct from the
// other Qoka tab icons.
const connectionsIcon = registerIcon(
	'aria-connections-view',
	Codicon.server,
	localize('aria.connections.iconLabel', "Qoka Connections activity bar icon")
);

// Sit next to Autopipe in the activity bar (Autopipe is order 14).
const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: ARIA_CONNECTIONS_CONTAINER_ID,
		title: localize2('aria.connections.containerTitle', "Connections"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ARIA_CONNECTIONS_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: connectionsIcon,
		order: 13,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const connectionsView: IViewDescriptor = {
	id: AriaConnectionsView.ID,
	name: localize2('aria.connections.viewName', "Connections"),
	containerIcon: connectionsIcon,
	ctorDescriptor: new SyncDescriptor(AriaConnectionsView),
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([connectionsView], viewContainer);
