/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
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
import { AriaPaperWriterView } from './ariaPaperWriterView.js';
import { AriaPaperWriterEditorPane } from './ariaPaperWriterEditorPane.js';
import { registerAriaTabHelpTitleAction } from '../../aria/browser/ariaHelpEditor.js';
import { AriaPaperWriterInput } from './ariaPaperWriterInput.js';
import { AriaManuscriptReviewEditorPane } from './ariaManuscriptReviewEditorPane.js';
import { AriaManuscriptReviewInput } from './ariaManuscriptReviewInput.js';

// --- Editor pane (paper setup form) -----------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AriaPaperWriterEditorPane,
		AriaPaperWriterEditorPane.ID,
		localize2('aria.paperWriter.editorPaneName', "Paper Writing").value
	),
	[
		new SyncDescriptor(AriaPaperWriterInput)
	]
);

// --- Editor pane (manuscript revision review) -------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AriaManuscriptReviewEditorPane,
		AriaManuscriptReviewEditorPane.ID,
		localize2('aria.manuscriptReview.editorPaneName', "Manuscript Review").value
	),
	[
		new SyncDescriptor(AriaManuscriptReviewInput)
	]
);

CommandsRegistry.registerCommand('aria.paperWriter.openReview', async (accessor, resource?: unknown) => {
	const uri = reviveUri(resource);
	if (!uri) { return; }
	await accessor.get(IEditorService).openEditor(new AriaManuscriptReviewInput(uri), { pinned: true });
});

// --- Commands ---------------------------------------------------------------

function reviveUri(resource: unknown): URI | undefined {
	if (!resource) { return undefined; }
	return URI.isUri(resource) ? resource : URI.revive(resource as never);
}

CommandsRegistry.registerCommand('aria.paperWriter.new', async (accessor) => {
	const fileService = accessor.get(IFileService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const editorService = accessor.get(IEditorService);
	const folder = workspaceContextService.getWorkspace().folders[0];
	if (!folder) { return; }
	const id = 'paper-' + generateUuid().slice(0, 8);
	const dir = joinPath(folder.uri, 'paper', id);
	await fileService.createFolder(dir);
	const now = new Date().toISOString();
	const meta = {
		id,
		title: 'Untitled paper',
		format: { paperType: 'research-article', targetWords: 4000, citationStyle: 'ieee', language: 'en' },
		outline: [] as unknown[],
		createdAt: now,
		updatedAt: now,
	};
	await fileService.writeFile(joinPath(dir, 'meta.json'), VSBuffer.fromString(JSON.stringify(meta, null, 2)));
	await fileService.writeFile(joinPath(dir, 'manuscript.md'), VSBuffer.fromString(''));
	await fileService.writeFile(joinPath(dir, 'citations.csl.json'), VSBuffer.fromString('[]\n'));
	await editorService.openEditor(new AriaPaperWriterInput(dir), { pinned: true });
});

CommandsRegistry.registerCommand('aria.paperWriter.open', async (accessor, resource?: unknown) => {
	const uri = reviveUri(resource);
	if (!uri) { return; }
	await accessor.get(IEditorService).openEditor(new AriaPaperWriterInput(uri), { pinned: true });
});

CommandsRegistry.registerCommand('aria.paperWriter.delete', async (accessor, resource?: unknown) => {
	const uri = reviveUri(resource);
	if (!uri) { return; }
	// Capture services BEFORE the await - the accessor is only valid synchronously.
	const dialogService = accessor.get(IDialogService);
	const fileService = accessor.get(IFileService);
	const { confirmed } = await dialogService.confirm({
		type: 'warning',
		message: localize('aria.paperWriter.deleteConfirm', "Delete this paper?"),
		detail: localize('aria.paperWriter.deleteDetail', "This moves the paper folder to the trash."),
		primaryButton: localize('aria.paperWriter.deleteButton', "Delete"),
	});
	if (!confirmed) { return; }
	try {
		await fileService.del(uri, { useTrash: true, recursive: true });
	} catch {
		await fileService.del(uri, { useTrash: false, recursive: true });
	}
});

// --- Sidebar "Paper Writer" view --------------------------------------------

const PAPER_WRITER_CONTAINER_ID = 'workbench.view.ariaPaperWriter';

const paperWriterIcon = registerIcon('aria-paper-writer-view', Codicon.edit, localize('aria.paperWriter.iconLabel', "Qoka Paper Writer activity bar icon"));

const paperWriterContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: PAPER_WRITER_CONTAINER_ID,
		title: localize2('aria.paperWriter.containerTitle', "Paper Writing"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [PAPER_WRITER_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: paperWriterIcon,
		order: 16,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const paperWriterView: IViewDescriptor = {
	id: AriaPaperWriterView.ID,
	name: localize2('aria.paperWriter.viewName', "Paper Writing"),
	containerIcon: paperWriterIcon,
	ctorDescriptor: new SyncDescriptor(AriaPaperWriterView),
	// Pinned like the other Qoka views; a togglable single view with no `when`
	// gets hidden by the merge-single-view logic.
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([paperWriterView], paperWriterContainer);

// "How to use?" link in the view's title bar.
registerAriaTabHelpTitleAction(AriaPaperWriterView.ID, 'paper-writer');
