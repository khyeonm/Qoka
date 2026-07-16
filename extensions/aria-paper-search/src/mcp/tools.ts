/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { listPapers, savePaper } from '../library';

/**
 * Two MCP tools the paper-library server exposes:
 *
 *  - save_paper:      Claude calls this when the user asks to save a
 *                     paper to their Aria library.
 *  - list_saved_papers: Claude calls this when the user asks "what's in
 *                     my library" or wants to filter against the saved
 *                     set rather than search the web.
 *
 * Deliberately small surface area - delete / note edits / tag edits
 * live in the Paper Search sidebar tab, not the MCP. Keeping Claude
 * away from destructive operations means the user's library can't be
 * silently emptied by a misinterpreted prompt.
 */

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: JsonSchemaObject;
	handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface CallToolResult {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
}

interface JsonSchemaObject {
	type: 'object';
	properties: Record<string, JsonSchemaProp>;
	required?: string[];
	additionalProperties?: boolean;
}

type JsonSchemaProp =
	| { type: 'string'; description?: string }
	| { type: 'integer'; description?: string }
	| { type: 'number'; description?: string }
	| { type: 'array'; description?: string; items: JsonSchemaProp }
	| { type: 'object'; description?: string; properties?: Record<string, JsonSchemaProp> };

function textResult(text: string): CallToolResult {
	return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): CallToolResult {
	return { content: [{ type: 'text', text }], isError: true };
}

export const ALL_TOOLS: ToolDefinition[] = [
	{
		name: 'save_paper',
		description: 'Save a paper to the user\'s Aria paper library. Only the title is required. Pass whatever other metadata you have - the rest are optional but enrich the library entry. If a field such as authors is missing, first try to find it (from the search result or a quick lookup); if it still cannot be determined, save the paper anyway with what you have (leave authors empty rather than refusing). Re-saving an existing paper (same DOI or URL) refreshes its metadata but preserves the user\'s note and tags.',
		inputSchema: {
			type: 'object',
			required: ['title'],
			properties: {
				title: { type: 'string', description: 'Paper title.' },
				authors: { type: 'array', items: { type: 'string' }, description: 'Author names in publication order.' },
				doi: { type: 'string', description: 'DOI without the URL prefix, e.g. "10.1126/science.1225829".' },
				url: { type: 'string', description: 'Landing-page URL for the paper.' },
				pdfUrl: { type: 'string', description: 'Direct link to a PDF if one is known.' },
				year: { type: 'integer', description: 'Publication year.' },
				venue: { type: 'string', description: 'Journal, conference, or preprint server name.' },
				abstract: { type: 'string', description: 'Abstract text.' },
				source: { type: 'string', description: 'Where the paper was found (e.g. "openalex", "crossref", "arxiv", "biorxiv", "pubmed").' },
			},
		},
		handler: async (args) => {
			const title = typeof args.title === 'string' ? args.title.trim() : '';
			const authorsRaw = args.authors;
			if (!title) {
				return errorResult('save_paper requires a non-empty `title`.');
			}
			// Authors are best-effort: if the model could not determine them,
			// save the paper anyway with an empty author list rather than
			// blocking the save.
			const authors = Array.isArray(authorsRaw)
				? authorsRaw.map(a => String(a)).filter(Boolean)
				: [];
			const entry = savePaper({
				title,
				authors,
				doi: typeof args.doi === 'string' ? args.doi : undefined,
				url: typeof args.url === 'string' ? args.url : undefined,
				pdfUrl: typeof args.pdfUrl === 'string' ? args.pdfUrl : undefined,
				year: typeof args.year === 'number' ? args.year : undefined,
				venue: typeof args.venue === 'string' ? args.venue : undefined,
				abstract: typeof args.abstract === 'string' ? args.abstract : undefined,
				source: normalizeSource(args.source),
			});
			return textResult(`Saved "${entry.title}" to the Aria paper library (id: ${entry.id}).`);
		},
	},
	{
		name: 'list_saved_papers',
		description: 'List the papers in the user\'s Aria paper library. Optional `query` filters by title, authors, abstract, venue, note, or tag (case-insensitive substring). Returns at most 200 papers in JSON.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Optional substring filter.' },
				tag: { type: 'string', description: 'Optional exact tag filter.' },
			},
		},
		handler: async (args) => {
			const query = typeof args.query === 'string' ? args.query : undefined;
			const tag = typeof args.tag === 'string' ? args.tag : undefined;
			const papers = listPapers({ query, tag }).slice(0, 200);
			if (papers.length === 0) {
				return textResult('The Aria paper library has no papers matching that filter yet.');
			}
			const summary = papers.map(p => ({
				id: p.id,
				title: p.title,
				authors: p.authors,
				year: p.year,
				venue: p.venue,
				doi: p.doi,
				tags: p.tags,
				note: p.note || undefined,
			}));
			return textResult(`${papers.length} paper(s) in the library:\n${JSON.stringify(summary, null, 2)}`);
		},
	},
];

export function findTool(name: string): ToolDefinition | undefined {
	return ALL_TOOLS.find(t => t.name === name);
}

function normalizeSource(raw: unknown): 'openalex' | 'crossref' | 'arxiv' | 'biorxiv' | 'pubmed' | 'other' {
	if (typeof raw !== 'string') {
		return 'other';
	}
	const v = raw.toLowerCase();
	if (v === 'openalex' || v === 'crossref' || v === 'arxiv' || v === 'biorxiv' || v === 'pubmed') {
		return v;
	}
	return 'other';
}
