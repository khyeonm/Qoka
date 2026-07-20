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
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ViewContainer, ViewContainerLocation, IViewContainersRegistry, Extensions as ViewContainerExtensions, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { AriaNoteEditorPane } from './ariaNoteEditorPane.js';
import { AriaNoteEditorInput } from './ariaNoteEditorInput.js';
import { AriaNotesView } from './ariaNotesView.js';
import { registerAriaTabHelpTitleAction } from '../../aria/browser/ariaHelpEditor.js';
import { setNoteProposal } from './ariaNotesProposals.js';

// --- Editor pane (BlockNote webview) ---------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AriaNoteEditorPane,
		AriaNoteEditorPane.ID,
		localize('aria.notes.editorPaneName', "Research Note")
	),
	[
		new SyncDescriptor(AriaNoteEditorInput)
	]
);

// --- Commands ---------------------------------------------------------------

function reviveUri(resource: unknown): URI | undefined {
	if (!resource) { return undefined; }
	return URI.isUri(resource) ? resource : URI.revive(resource as never);
}

CommandsRegistry.registerCommand('aria.notes.new', async (accessor) => {
	const fileService = accessor.get(IFileService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const editorService = accessor.get(IEditorService);
	const folder = workspaceContextService.getWorkspace().folders[0];
	if (!folder) { return; }
	const dir = joinPath(folder.uri, 'notes');
	await fileService.createFolder(dir);
	const uri = joinPath(dir, `note-${generateUuid().slice(0, 8)}.json`);
	const payload = { version: 1, title: 'Untitled', blocks: [] as unknown[], updatedAt: new Date().toISOString() };
	await fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(payload, null, 2)));
	await editorService.openEditor(new AriaNoteEditorInput(uri), { pinned: true });
});

CommandsRegistry.registerCommand('aria.notes.open', async (accessor, resource?: unknown) => {
	const uri = reviveUri(resource);
	if (!uri) { return; }
	await accessor.get(IEditorService).openEditor(new AriaNoteEditorInput(uri), { pinned: true });
});

// Fired by the aria-notes MCP server when Claude proposes a note edit. We stage
// the proposal and open the note; the pane shows it read-only for Accept/Reject.
CommandsRegistry.registerCommand('aria.notes.workbench.onProposal', async (accessor, payload?: unknown) => {
	const p = payload as { filePath?: string; title?: string; blocks?: unknown[]; currentMarkdown?: string; proposedMarkdown?: string } | undefined;
	if (!p || typeof p.filePath !== 'string' || !Array.isArray(p.blocks)) { return; }
	const fileUri = URI.file(p.filePath);
	setNoteProposal({
		fileKey: fileUri.toString(),
		title: typeof p.title === 'string' ? p.title : '',
		blocks: p.blocks,
		currentMarkdown: typeof p.currentMarkdown === 'string' ? p.currentMarkdown : '',
		proposedMarkdown: typeof p.proposedMarkdown === 'string' ? p.proposedMarkdown : '',
	});
	await accessor.get(IEditorService).openEditor(new AriaNoteEditorInput(fileUri), { pinned: true });
});

CommandsRegistry.registerCommand('aria.notes.rename', async (accessor, resource?: unknown) => {
	const uri = reviveUri(resource);
	if (!uri) { return; }
	const fileService = accessor.get(IFileService);
	const quickInputService = accessor.get(IQuickInputService);
	let parsed: { title?: string; blocks?: unknown[]; version?: number } = {};
	try {
		const content = await fileService.readFile(uri);
		parsed = JSON.parse(content.value.toString());
	} catch {
		// new/empty - rename still allowed
	}
	const name = await quickInputService.input({
		prompt: localize('aria.notes.renamePrompt', "Rename note"),
		value: typeof parsed.title === 'string' ? parsed.title : '',
	});
	if (name === undefined) {
		return;
	}
	parsed.version = parsed.version ?? 1;
	parsed.title = name.trim() || 'Untitled';
	await fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(parsed, null, 2)));
});

CommandsRegistry.registerCommand('aria.notes.delete', async (accessor, resource?: unknown) => {
	const uri = reviveUri(resource);
	if (!uri) { return; }
	// Capture services BEFORE any await - the accessor is only valid during the
	// synchronous part of the command invocation.
	const dialogService = accessor.get(IDialogService);
	const fileService = accessor.get(IFileService);
	const { confirmed } = await dialogService.confirm({
		type: 'warning',
		message: localize('aria.notes.deleteConfirm', "Delete this note?"),
		detail: localize('aria.notes.deleteDetail', "This moves the note to the trash."),
		primaryButton: localize('aria.notes.deleteButton', "Delete"),
	});
	if (!confirmed) { return; }
	try {
		await fileService.del(uri, { useTrash: true, recursive: false });
	} catch {
		await fileService.del(uri, { useTrash: false, recursive: false });
	}
});

// --- Sidebar "Research Note" view -------------------------------------------

const NOTES_CONTAINER_ID = 'workbench.view.ariaNotes';

const notesIcon = registerIcon('aria-notes-view', Codicon.note, localize('aria.notes.iconLabel', "Qoka Notes activity bar icon"));

const notesContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: NOTES_CONTAINER_ID,
		title: localize2('aria.notes.containerTitle', "Research Note"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [NOTES_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: notesIcon,
		order: 13,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const notesView: IViewDescriptor = {
	id: AriaNotesView.ID,
	name: localize2('aria.notes.viewName', "Research Note"),
	containerIcon: notesIcon,
	ctorDescriptor: new SyncDescriptor(AriaNotesView),
	canToggleVisibility: true,
	canMoveView: true,
	// Only meaningful with a project folder open (notes live in <project>/notes/).
	when: ContextKeyExpr.notEquals('workbenchState', 'empty'),
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([notesView], notesContainer);

// "How to use?" link in the view's title bar.
registerAriaTabHelpTitleAction(AriaNotesView.ID, 'research-note');
