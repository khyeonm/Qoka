/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { AriaPeerReviewEditorPane } from './ariaPeerReviewEditorPane.js';
import { AriaPeerReviewInput } from './ariaPeerReviewInput.js';

// The Peer Review sidebar tab was merged into the consolidated "Manuscript" tab
// (see ariaManuscript.contribution). This file keeps registering the review editor
// pane, input and `aria.peerReview.*` commands - only the sidebar container/view
// moved - so the Manuscript list, the Paper Writing handoff and the MCP tools keep
// working.

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

// Handoff from Paper Writing: open a NEW review with the given paper pre-selected as
// the source (the pane reads seedPaperId and switches to the "manuscript" source).
CommandsRegistry.registerCommand('aria.peerReview.newForPaper', async (accessor, paperId?: unknown) => {
	const seed = typeof paperId === 'string' && paperId ? paperId : undefined;
	await accessor.get(IEditorService).openEditor(new AriaPeerReviewInput(undefined, seed), { pinned: true });
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
	const dir = joinPath(folder.uri, '.qoka', 'manuscript', 'review', execId);
	try { await fileService.del(dir, { useTrash: true, recursive: true }); }
	catch { await fileService.del(dir, { useTrash: false, recursive: true }); }
});
