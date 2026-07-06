/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	deletePage, listPages, readIndex, readPageRaw, resolvePage,
	searchPages, writePage,
} from '../wiki';
import { rememberUser, recallUser } from '../userMemory';

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
 * the READ/WRITE surface the agent uses for the single-project half of Aria's
 * memory system.
 *
 * Cross-project ("user"/assistant) memory is served by a separate mem0 store
 * and its own tools — added in a later phase. Everything here is scoped to the
 * currently-open workspace folder.
 *
 * Note on writes: `remember_project_memory` writes the page immediately.
 * A review queue for edits/deletes (the user confirms before an existing page
 * is overwritten or removed) is a planned workbench feature; until it exists,
 * the log at `.aria/memory/wiki/log.md` is the audit trail.
 */
export function buildTools(): ToolDefinition[] {
	return [
		{
			name: 'project_memory_index',
			description: 'Get the index (table of contents) of this project\'s long-term memory wiki, grouped by type. Call this first to see what the project already remembers before answering, or before writing a new memory (so you update an existing page instead of duplicating it).',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				const index = readIndex();
				return ok(index || 'Project memory is empty — no pages yet.');
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
				const rendered = hits.map(h => `- [[${h.slug}]] (${h.type}) — ${h.title}\n  ${h.excerpt}`).join('\n');
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
			description: 'Save or update a piece of THIS project\'s long-term knowledge (a decision, architecture note, experiment result, data location, project-specific term, etc.). Only for project-scoped facts — cross-project user preferences belong in user memory. Reuse the same `title` to update an existing page rather than creating a near-duplicate; check project_memory_index / search_project_memory first.',
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
					return ok(`Saved project memory "${info.title}" (${info.slug}, type: ${info.type}).`);
				} catch (e) {
					return err(`remember_project_memory failed: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'forget_project_memory',
			description: 'Delete a project memory page. Writes immediately and is irreversible — only do this when the user explicitly asks to remove that memory. `page` is a slug or title.',
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
				return deletePage(info.slug)
					? ok(`Deleted project memory "${info.title}" (${info.slug}).`)
					: err(`Could not delete "${info.slug}".`);
			},
		},
		{
			name: 'list_project_memory',
			description: 'List every project memory page as slug + title + type. A flat alternative to project_memory_index.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				const pages = listPages();
				if (!pages.length) { return ok('Project memory is empty — no pages yet.'); }
				return ok(JSON.stringify(pages.map(p => ({ slug: p.slug, title: p.title, type: p.type })), null, 2));
			},
		},
		// --- cross-project ("user") memory — backed by the mem0 server ---------
		{
			name: 'remember_user_memory',
			description: 'Save a CROSS-PROJECT fact about the USER — something that stays true and useful in ANY project (their preferences, working style, identity, tools they favour, cross-cutting conventions). Do NOT use this for facts specific to the current project — those go to remember_project_memory. When unsure whether a fact is project-specific or cross-project, prefer remember_project_memory.',
			inputSchema: {
				type: 'object',
				properties: {
					content: { type: 'string', description: 'The cross-project fact about the user, self-contained. e.g. "Prefers replies in Korean."' },
				},
				required: ['content'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const content = asString(args.content);
				if (!content) { return err('remember_user_memory requires `content`.'); }
				try {
					await rememberUser(content);
					return ok('Saved to cross-project user memory.');
				} catch (e) {
					return err(`remember_user_memory failed (memory server): ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'recall_user_memory',
			description: 'Search the USER\'s cross-project memory (preferences, working style, identity) by meaning — regardless of which project is open. Use this to recall what you know about the user before answering.',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'What to recall about the user.' },
					limit: { type: 'number', description: 'Max results (default 5).' },
				},
				required: ['query'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const query = asString(args.query);
				if (!query) { return err('recall_user_memory requires `query`.'); }
				const limit = typeof args.limit === 'number' ? args.limit : 5;
				try {
					const hits = await recallUser(query, limit);
					if (!hits.length) { return ok(`No cross-project memory matches "${query}".`); }
					return ok(hits.map(h => `- ${h.memory}${typeof h.score === 'number' ? ` (${h.score.toFixed(2)})` : ''}`).join('\n'));
				} catch (e) {
					return err(`recall_user_memory failed (memory server): ${(e as Error).message}`);
				}
			},
		},
	];
}
