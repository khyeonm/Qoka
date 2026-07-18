/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ViewContainer, ViewContainerLocation, IViewContainersRegistry, Extensions as ViewContainerExtensions, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { AriaPeerReviewView } from './ariaPeerReviewView.js';
import { registerAriaTabHelpTitleAction } from '../../aria/browser/ariaHelpEditor.js';
import { AriaPeerReviewEditorPane } from './ariaPeerReviewEditorPane.js';
import { AriaPeerReviewInput } from './ariaPeerReviewInput.js';

// --- Editor pane ------------------------------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AriaPeerReviewEditorPane,
		AriaPeerReviewEditorPane.ID,
		localize2('aria.peerReview.editorPaneName', "Peer Review").value
	),
	[
		new SyncDescriptor(AriaPeerReviewInput)
	]
);

// --- Commands ---------------------------------------------------------------

CommandsRegistry.registerCommand('aria.peerReview.new', async (accessor) => {
	await accessor.get(IEditorService).openEditor(new AriaPeerReviewInput(undefined), { pinned: true });
});

CommandsRegistry.registerCommand('aria.peerReview.open', async (accessor, execId?: unknown) => {
	if (typeof execId !== 'string' || !execId) { return; }
	await accessor.get(IEditorService).openEditor(new AriaPeerReviewInput(execId), { pinned: true });
});

CommandsRegistry.registerCommand('aria.peerReview.delete', async (accessor, execId?: unknown) => {
	if (typeof execId !== 'string' || !execId) { return; }
	const dialogService = accessor.get(IDialogService);
	const fileService = accessor.get(IFileService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const folder = workspaceContextService.getWorkspace().folders[0];
	if (!folder) { return; }
	const { confirmed } = await dialogService.confirm({
		type: 'warning',
		message: localize('aria.peerReview.deleteConfirm', "Delete this review?"),
		detail: localize('aria.peerReview.deleteDetail', "This moves the review folder to the trash."),
		primaryButton: localize('aria.peerReview.deleteButton', "Delete"),
	});
	if (!confirmed) { return; }
	const dir = joinPath(folder.uri, 'reviews', execId);
	try { await fileService.del(dir, { useTrash: true, recursive: true }); }
	catch { await fileService.del(dir, { useTrash: false, recursive: true }); }
});

// --- Sidebar "AI Peer Review" view ------------------------------------------

const PEER_REVIEW_CONTAINER_ID = 'workbench.view.ariaPeerReview';
const peerReviewIcon = registerIcon('aria-peer-review-view', Codicon.commentDiscussion, localize('aria.peerReview.iconLabel', "Aria Peer Review activity bar icon"));

const peerReviewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: PEER_REVIEW_CONTAINER_ID,
		title: localize2('aria.peerReview.containerTitle', "Peer Review"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [PEER_REVIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: peerReviewIcon,
		order: 17,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const peerReviewView: IViewDescriptor = {
	id: AriaPeerReviewView.ID,
	name: localize2('aria.peerReview.viewName', "Peer Review"),
	containerIcon: peerReviewIcon,
	ctorDescriptor: new SyncDescriptor(AriaPeerReviewView),
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([peerReviewView], peerReviewContainer);

// "How to use?" link in the view's title bar.
registerAriaTabHelpTitleAction(AriaPeerReviewView.ID, 'peer-review');
