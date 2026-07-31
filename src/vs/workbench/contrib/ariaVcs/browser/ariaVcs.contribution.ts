/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { VIEW_CONTAINER } from '../../files/browser/explorerViewlet.js';
import { AriaChangesView, AriaSnapshotsView, AriaVersionsView } from './ariaVersionsView.js';

/**
 * Versions is folded INTO the Analysis tab (the former Explorer) as TWO separate
 * collapsible toggles beneath the file tree - "Changes" (pending changes + Save
 * snapshot) and "Snapshots" (the saved-version timeline + restore) - like the
 * Notebook tab's sections. There is no longer a standalone Versions tab; the
 * snapshot backend (aria-vcs `aria.vcs.*` commands) is unchanged.
 */
const easyOnly = ContextKeyExpr.equals('aria.mode', 'easy');

const changesView: IViewDescriptor = {
	id: AriaChangesView.ID,
	name: localize2('aria.changes.viewName', "Changes"),
	containerIcon: Codicon.diff,
	ctorDescriptor: new SyncDescriptor(AriaChangesView),
	canToggleVisibility: true,
	canMoveView: false,
	// After the file tree (Folders is order 1); Changes above Snapshots.
	order: 20,
	when: easyOnly,
};

const snapshotsView: IViewDescriptor = {
	id: AriaSnapshotsView.ID,
	name: localize2('aria.snapshots.viewName', "Snapshots"),
	containerIcon: Codicon.history,
	ctorDescriptor: new SyncDescriptor(AriaSnapshotsView),
	canToggleVisibility: true,
	canMoveView: false,
	order: 21,
	when: easyOnly,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([changesView, snapshotsView], VIEW_CONTAINER);

// No "How to use?" link on either section: Changes and Snapshots are two
// collapsible sections INSIDE the Analysis tab, so a per-section help link read
// as belonging to the whole tab. The 'versions' how-to content is still
// registered and reachable from the help editor.

// --- Changes title-bar actions: Save snapshot + Refresh --------------------
// These sit inline with the "Changes" view title (right side), instead of a toolbar
// row in the body. Each routes to the live Changes view instance.

const SAVE_ID = 'aria.vcs.ui.saveSnapshot';
const REFRESH_ID = 'aria.vcs.ui.refresh';

function changesView2(accessor: ServicesAccessor): AriaVersionsView | undefined {
	const v = accessor.get(IViewsService).getViewWithId(AriaChangesView.ID);
	return v instanceof AriaVersionsView ? v : undefined;
}

CommandsRegistry.registerCommand(SAVE_ID, (accessor) => changesView2(accessor)?.saveSnapshotFlow());
CommandsRegistry.registerCommand(REFRESH_ID, (accessor) => changesView2(accessor)?.refreshNow());

MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: SAVE_ID, title: localize('aria.vcs.save', "Save snapshot"), icon: Codicon.save },
	group: 'navigation', order: 1,
	when: ContextKeyExpr.equals('view', AriaChangesView.ID),
});
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: REFRESH_ID, title: localize('aria.vcs.refreshTooltip', "Refresh"), icon: Codicon.refresh },
	group: 'navigation', order: 2,
	when: ContextKeyExpr.equals('view', AriaChangesView.ID),
});
