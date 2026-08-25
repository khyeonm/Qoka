/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { listPages, readPageDetail, writePage, deletePage, slugify, PageDetail } from './wiki';
import * as globalWiki from './globalWiki';

/**
 * Commands that back the workbench Memory tab (core `ariaMemory` editor pane).
 *
 * The tab lives in core and cannot reach the wiki files or the authenticated mem0
 * client directly, so it drives everything through these `aria.memory.tab.*`
 * commands - the same core->extension pattern the Settings sections use.
 *
 * Two backends:
 *   - PROJECT memory: local markdown wiki files (wiki.ts). Instant, offline.
 *   - GLOBAL memory:  a local markdown wiki (globalWiki.ts) at ~/.qoka/memory/wiki,
 *                     shared across every project on this computer. No server, no login.
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

	// --- global memory (local wiki at ~/.qoka/memory/wiki, shared across projects) ---
	reg('aria.memory.tab.globalList', (): PageDetail[] =>
		globalWiki.listPages()
			.map(p => globalWiki.readPageDetail(p.slug))
			.filter((d): d is PageDetail => !!d)
			// Most-recently-updated first (undated pages sink to the bottom).
			.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '')));

	reg('aria.memory.tab.globalSave', (args: ProjectSaveArgs) => {
		if (!args || !args.title?.trim() || !args.body?.trim()) {
			throw new Error('A memory needs a title and content.');
		}
		const info = globalWiki.writePage({ title: args.title.trim(), type: args.type, body: args.body });
		// Title edited to a new slug: drop the old page so we don't leave a stale copy.
		if (args.originalSlug && args.originalSlug !== info.slug) {
			try { globalWiki.deletePage(args.originalSlug); } catch { /* ignore */ }
		}
		return { slug: info.slug, title: info.title, type: info.type };
	});

	reg('aria.memory.tab.globalDelete', (slug: string) => {
		if (!slug) { throw new Error('globalDelete requires a slug.'); }
		return globalWiki.deletePage(slug);
	});

	reg('aria.memory.tab.globalSlugify', (title: string) => slugify(String(title ?? '')));
}
