/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { listPages, readPageDetail, writePage, deletePage, slugify, PageDetail } from './wiki';
import { isSignedIn, listUser, rememberUser, updateUser, deleteUser, UserMemoryItem } from './userMemory';

/**
 * Commands that back the workbench Memory tab (core `ariaMemory` editor pane).
 *
 * The tab lives in core and cannot reach the wiki files or the authenticated mem0
 * client directly, so it drives everything through these `aria.memory.tab.*`
 * commands - the same core->extension pattern the Settings sections use.
 *
 * Two backends:
 *   - PROJECT memory: local markdown wiki files (wiki.ts). Instant, offline.
 *   - GLOBAL memory:  the user's mem0 store on the server (userMemory.ts). Needs
 *                     sign-in; edits re-embed via the server's gemma embedder.
 */

interface ProjectSaveArgs {
	title: string;
	type?: string;
	body: string;
	/** When editing, the slug of the page being edited. If the title changed to a
	 *  different slug, the old page is removed so an edit doesn't fork a duplicate. */
	originalSlug?: string;
}

export function registerMemoryTabCommands(context: vscode.ExtensionContext): void {
	const reg = (id: string, fn: (...args: any[]) => any) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));

	// --- project memory (local wiki files) ---------------------------------
	reg('aria.memory.tab.projectList', (): PageDetail[] =>
		listPages()
			.map(p => readPageDetail(p.slug))
			.filter((d): d is PageDetail => !!d)
			// Most-recently-updated first (undated pages sink to the bottom).
			.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '')));

	reg('aria.memory.tab.projectSave', (args: ProjectSaveArgs) => {
		if (!args || !args.title?.trim() || !args.body?.trim()) {
			throw new Error('A memory needs a title and content.');
		}
		const info = writePage({ title: args.title.trim(), type: args.type, body: args.body });
		// Title edited to a new slug: drop the old page so we don't leave a stale copy.
		if (args.originalSlug && args.originalSlug !== info.slug) {
			try { deletePage(args.originalSlug); } catch { /* ignore */ }
		}
		return { slug: info.slug, title: info.title, type: info.type };
	});

	reg('aria.memory.tab.projectDelete', (slug: string) => {
		if (!slug) { throw new Error('projectDelete requires a slug.'); }
		return deletePage(slug);
	});

	// Useful for the "+ Add" form to preview the slug a title will map to.
	reg('aria.memory.tab.projectSlugify', (title: string) => slugify(String(title ?? '')));

	// --- global memory (mem0, needs sign-in) -------------------------------
	reg('aria.memory.tab.globalSignedIn', (): Promise<boolean> => isSignedIn());

	reg('aria.memory.tab.globalList', async (): Promise<UserMemoryItem[]> => {
		if (!(await isSignedIn())) { return []; }
		return listUser();
	});

	reg('aria.memory.tab.globalAdd', async (content: string) => {
		if (!content?.trim()) { throw new Error('A memory cannot be empty.'); }
		return rememberUser(content.trim());
	});

	reg('aria.memory.tab.globalUpdate', async (args: { id: string; content: string }) => {
		if (!args?.id || !args.content?.trim()) { throw new Error('globalUpdate requires an id and content.'); }
		return updateUser(args.id, args.content.trim());
	});

	reg('aria.memory.tab.globalDelete', async (id: string) => {
		if (!id) { throw new Error('globalDelete requires an id.'); }
		return deleteUser(id);
	});
}
