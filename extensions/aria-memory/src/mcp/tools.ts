/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	deletePage, listPages, readIndex, readPageRaw, resolvePage,
	searchPages, writePage,
} from '../wiki';
import * as globalWiki from '../globalWiki';
import * as vscode from 'vscode';

/** After a chat saves or deletes a memory, reflect it in the Memory tab at once:
 *  reload BOTH sections, and (on a save) open/focus the tab. Best-effort - the tab
 *  need not be open, and the workbench commands are no-ops when it isn't. */
function notifyMemoryChanged(openTab: boolean): void {
	if (openTab) { void vscode.commands.executeCommand('aria.memory.open'); }
	void vscode.commands.executeCommand('aria.memory.refresh');
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: unknown;
	handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface CallToolResult {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
}

function ok(text: string): CallToolResult { return { content: [{ type: 'text', text }] }; }
function err(text: string): CallToolResult { return { content: [{ type: 'text', text }], isError: true }; }
function asString(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined; }
function asStringArray(v: unknown): string[] | undefined {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

/**
 * Project-memory tools backed by the per-project wiki (`wiki.ts`). These are
 * the READ/WRITE surface the agent uses for the single-project half of Qoka's
 * memory system.
 *
 * Cross-project ("user"/assistant) memory is served by a separate mem0 store
 * and its own tools - added in a later phase. Everything here is scoped to the
 * currently-open workspace folder.
 *
 * Note on writes: `remember_project_memory` writes the page immediately.
 * A review queue for edits/deletes (the user confirms before an existing page
 * is overwritten or removed) is a planned workbench feature; until it exists,
 * the log at `.qoka/memory/wiki/log.md` is the audit trail.
 */
export function buildTools(): ToolDefinition[] {
	return [
		{
			name: 'project_memory_index',
			description: 'Get the index (table of contents) of this project\'s long-term memory wiki, grouped by type. Call this first to see what the project already remembers before answering, or before writing a new memory (so you update an existing page instead of duplicating it).',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				const index = readIndex();
				return ok(index || 'Project memory is empty - no pages yet.');
			},
		},
		{
			name: 'search_project_memory',
			description: 'Search this project\'s memory wiki by keyword and return the most relevant pages with excerpts. Use this to recall what was decided/observed in THIS project before answering the user.',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'What to look for (keywords or a short phrase).' },
					limit: { type: 'number', description: 'Max pages to return (default 5).' },
				},
				required: ['query'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const query = asString(args.query);
				if (!query) { return err('search_project_memory requires `query`.'); }
				const limit = typeof args.limit === 'number' ? args.limit : 5;
				const hits = searchPages(query, limit);
				if (!hits.length) { return ok(`No project memory matches "${query}".`); }
				const rendered = hits.map(h => `- [[${h.slug}]] (${h.type}) - ${h.title}\n  ${h.excerpt}`).join('\n');
				return ok(rendered);
			},
		},
		{
			name: 'read_project_memory',
			description: 'Read one memory page in full (Markdown). `page` is a slug or title from project_memory_index / search_project_memory.',
			inputSchema: {
				type: 'object',
				properties: { page: { type: 'string', description: 'Page slug or title.' } },
				required: ['page'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const page = asString(args.page);
				if (!page) { return err('read_project_memory requires `page`.'); }
				const info = resolvePage(page);
				if (!info) { return err(`No page matches "${page}". Use project_memory_index to list pages.`); }
				const raw = readPageRaw(info.slug);
				return raw ? ok(raw) : err(`Could not read page "${info.slug}".`);
			},
		},
		{
			name: 'remember_project_memory',
			description: 'Save or update a piece of THIS project\'s long-term knowledge (a decision, architecture note, experiment result, data location, project-specific term, etc.). The user need NOT say "remember": if they stated a project/environment fact ("you can use the X server", "the data is at X") and agreed to your offer to save it, save it here. Only for project-scoped facts - cross-project user preferences belong in remember_user_memory. If it is unclear whether a fact is project-specific or a cross-project user preference, ASK the user which before saving. Reuse the same `title` to update an existing page rather than creating a near-duplicate; check project_memory_index / search_project_memory first. If the user is RE-SCOPING a fact you had saved GLOBALLY (they say "remember this for THIS project only" after it went to user memory), first delete the global copy with forget_user_memory (confirm before deleting), then save it here - never leave both.',
			inputSchema: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'Short page title. Reusing an existing title updates that page.' },
					content: { type: 'string', description: 'The knowledge to store, in Markdown. Be self-contained and specific.' },
					type: {
						type: 'string',
						description: 'Category for grouping in the index, e.g. decision | entity | experiment | constraint | reference.',
					},
					links: {
						type: 'array',
						items: { type: 'string' },
						description: 'Optional slugs of related pages to cross-link.',
					},
				},
				required: ['title', 'content'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const title = asString(args.title);
				const content = asString(args.content);
				if (!title || content === undefined) {
					return err('remember_project_memory requires `title` and `content`.');
				}
				try {
					const info = writePage({
						title,
						body: content,
						type: asString(args.type),
						links: asStringArray(args.links),
					});
					notifyMemoryChanged(true);
					return ok(`Saved project memory "${info.title}" (${info.slug}, type: ${info.type}).`);
				} catch (e) {
					return err(`remember_project_memory failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'forget_project_memory',
			description: 'Delete a project memory page. Writes immediately and is irreversible - only do this when the user explicitly asks to remove that memory. `page` is a slug or title.',
			inputSchema: {
				type: 'object',
				properties: { page: { type: 'string', description: 'Page slug or title to delete.' } },
				required: ['page'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const page = asString(args.page);
				if (!page) { return err('forget_project_memory requires `page`.'); }
				const info = resolvePage(page);
				if (!info) { return err(`No page matches "${page}".`); }
				if (deletePage(info.slug)) {
					notifyMemoryChanged(false);
					return ok(`Deleted project memory "${info.title}" (${info.slug}).`);
				}
				return err(`Could not delete "${info.slug}".`);
			},
		},
		{
			name: 'list_project_memory',
			description: 'List every project memory page as slug + title + type. A flat alternative to project_memory_index.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				const pages = listPages();
				if (!pages.length) { return ok('Project memory is empty - no pages yet.'); }
				return ok(JSON.stringify(pages.map(p => ({ slug: p.slug, title: p.title, type: p.type })), null, 2));
			},
		},
		// --- cross-project ("user"/global) memory - local wiki at ~/.qoka/memory/wiki ---
		// Same on-disk Markdown wiki as project memory, but USER-scoped (home dir) so
		// every project on this computer shares it. No server, login, or embeddings.
		{
			name: 'user_memory_index',
			description: 'Get the index (table of contents) of the cross-project USER memory - facts true in ANY project (preferences, working style, identity, favoured tools), shared across every project on this computer. Call this before answering (to recall what you know about the user) or before saving a user fact (to update an existing page instead of duplicating).',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				const index = globalWiki.readIndex();
				return ok(index || 'Cross-project memory is empty - no pages yet.');
			},
		},
		{
			name: 'read_user_memory',
			description: 'Read one cross-project memory page in full (Markdown). `page` is a slug or title from user_memory_index / recall_user_memory.',
			inputSchema: {
				type: 'object',
				properties: { page: { type: 'string', description: 'Page slug or title.' } },
				required: ['page'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const page = asString(args.page);
				if (!page) { return err('read_user_memory requires `page`.'); }
				const info = globalWiki.resolvePage(page);
				if (!info) { return err(`No page matches "${page}". Use user_memory_index to list pages.`); }
				const raw = globalWiki.readPageRaw(info.slug);
				return raw ? ok(raw) : err(`Could not read page "${info.slug}".`);
			},
		},
		{
			name: 'remember_user_memory',
			description: 'Save or update a CROSS-PROJECT fact about the USER - something true and useful in ANY project (preferences, working style, identity, favoured tools, cross-cutting conventions). The user need NOT say remember: if they stated a preference or standing rule and agreed to your offer to save it, save it here. Do NOT use this for facts specific to the current project - those go to remember_project_memory. If it is unclear whether a fact is project-specific or a cross-project user preference, ASK the user which before saving. Reuse the same `title` to UPDATE an existing page instead of creating a near-duplicate; check user_memory_index / recall_user_memory first.',
			inputSchema: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'Short page title. Reusing an existing title updates that page.' },
					content: { type: 'string', description: 'The cross-project fact about the user, self-contained Markdown. e.g. Prefers replies in Korean.' },
					type: { type: 'string', description: 'Category for grouping, e.g. preference | identity | convention | reference.' },
				},
				required: ['title', 'content'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const title = asString(args.title);
				const content = asString(args.content);
				if (!title || content === undefined) { return err('remember_user_memory requires `title` and `content`.'); }
				try {
					const info = globalWiki.writePage({ title, body: content, type: asString(args.type) });
					notifyMemoryChanged(true);
					return ok(`Saved cross-project memory "${info.title}" (${info.slug}, type: ${info.type}).`);
				} catch (e) {
					return err(`remember_user_memory failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'recall_user_memory',
			description: 'Search the cross-project USER memory by KEYWORD (preferences, working style, identity) - regardless of which project is open. Use this to recall what you know about the user before answering. To REMOVE or RE-SCOPE a memory the user retracts, delete it with forget_user_memory rather than saving a contradicting one.',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'What to recall about the user (keywords or a short phrase).' },
					limit: { type: 'number', description: 'Max pages to return (default 5).' },
				},
				required: ['query'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const query = asString(args.query);
				if (!query) { return err('recall_user_memory requires `query`.'); }
				const limit = typeof args.limit === 'number' ? args.limit : 5;
				const hits = globalWiki.searchPages(query, limit);
				if (!hits.length) { return ok(`No cross-project memory matches "${query}".`); }
				return ok(hits.map(h => `- [[${h.slug}]] (${h.type}) - ${h.title}\n  ${h.excerpt}`).join('\n'));
			},
		},
		{
			name: 'forget_user_memory',
			description: 'Delete a CROSS-PROJECT (global) user memory page. Writes immediately and is irreversible - only when the user explicitly asks to remove that memory, or wants a fact remembered for the CURRENT PROJECT ONLY instead of globally (then delete here and re-save with remember_project_memory - never leave both). `page` is a slug or title from user_memory_index / recall_user_memory.',
			inputSchema: {
				type: 'object',
				properties: { page: { type: 'string', description: 'Page slug or title to delete.' } },
				required: ['page'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const page = asString(args.page);
				if (!page) { return err('forget_user_memory requires `page`.'); }
				const info = globalWiki.resolvePage(page);
				if (!info) { return err(`No page matches "${page}".`); }
				if (globalWiki.deletePage(info.slug)) {
					notifyMemoryChanged(false);
					return ok(`Deleted cross-project memory "${info.title}" (${info.slug}).`);
				}
				return err(`Could not delete "${info.slug}".`);
			},
		},
	];
}
