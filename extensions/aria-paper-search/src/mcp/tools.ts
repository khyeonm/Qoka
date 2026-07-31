/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { listPapers, savePaper, savePapers, SavePaperInput } from '../library';

/**
 * Two MCP tools the paper-library server exposes:
 *
 *  - save_paper:      Claude calls this when the user asks to save a
 *                     paper to their Qoka library.
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

/**
 * Optional callback the extension host wires up so that, after a paper is
 * saved, the Paper Library sidebar tab is revealed (its list auto-refreshes
 * when it becomes visible, so the freshly saved paper shows up). Kept as a
 * best-effort hook: in a headless / no-UI context it is simply never set, and
 * even when set it is called defensively so a failure can't break the save.
 */
let revealLibrary: (() => void) | undefined;

export function setRevealLibrary(fn: (() => void) | undefined): void {
	revealLibrary = fn;
}

function textResult(text: string): CallToolResult {
	return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): CallToolResult {
	return { content: [{ type: 'text', text }], isError: true };
}

export const ALL_TOOLS: ToolDefinition[] = [
	{
		name: 'save_paper',
		description: 'Save a SINGLE paper to the user\'s Qoka paper library. To save SEVERAL papers at once, do NOT call this repeatedly - use `save_papers` (one batched call) instead. Only the title is required. Pass whatever other metadata you have - the rest are optional but enrich the library entry. If a field such as authors is missing, first try to find it (from the search result or a quick lookup); if it still cannot be determined, save the paper anyway with what you have (leave authors empty rather than refusing). Re-saving an existing paper (same DOI or URL) refreshes its metadata but preserves the user\'s note and tags. After a successful save the Paper Library sidebar tab opens automatically to show the saved paper, so tell the user it now appears in their Paper Library tab.',
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
			// Best-effort: reveal the Paper Library tab so the saved paper shows
			// (the view auto-refreshes when it becomes visible). Never let a
			// headless/no-UI context or a hidden view break the save.
			if (revealLibrary) {
				try {
					revealLibrary();
				} catch { /* reveal is optional - the save already succeeded */ }
			}
			return textResult(`Saved "${entry.title}" to the Qoka paper library (id: ${entry.id}, citekey: ${entry.citekey}). Cite it in a research note as [@${entry.citekey}].`);
		},
	},
	{
		name: 'save_papers',
		description: 'Save SEVERAL papers to the user\'s Qoka paper library in ONE call. Use this instead of calling save_paper repeatedly whenever the user wants to save more than one paper (e.g. "save these", "save all of them") - it writes the library once and opens the Paper Library tab once. Pass an array of paper objects, each with the same fields as save_paper (only `title` is required per paper; fill in whatever other metadata you have). Papers with no title are skipped (the rest are still saved); re-saving an existing paper refreshes its metadata but preserves the user\'s note and tags. After saving, tell the user how many were added and that they now appear in their Paper Library tab.',
		inputSchema: {
			type: 'object',
			required: ['papers'],
			properties: {
				papers: {
					type: 'array',
					description: 'The papers to save, in the order they should appear (first = top of the list).',
					items: {
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
						additionalProperties: false,
					},
				},
			},
		},
		handler: async (args) => {
			const raw = Array.isArray(args.papers) ? args.papers : [];
			if (raw.length === 0) {
				return errorResult('save_papers requires a non-empty `papers` array. To save one paper, use save_paper.');
			}
			const inputs: SavePaperInput[] = [];
			let skipped = 0;
			for (const p of raw) {
				const obj = (p && typeof p === 'object') ? p as Record<string, unknown> : {};
				const title = typeof obj.title === 'string' ? obj.title.trim() : '';
				if (!title) { skipped++; continue; }        // best-effort: skip the untitled, keep the rest
				const authors = Array.isArray(obj.authors) ? obj.authors.map(a => String(a)).filter(Boolean) : [];
				inputs.push({
					title,
					authors,
					doi: typeof obj.doi === 'string' ? obj.doi : undefined,
					url: typeof obj.url === 'string' ? obj.url : undefined,
					pdfUrl: typeof obj.pdfUrl === 'string' ? obj.pdfUrl : undefined,
					year: typeof obj.year === 'number' ? obj.year : undefined,
					venue: typeof obj.venue === 'string' ? obj.venue : undefined,
					abstract: typeof obj.abstract === 'string' ? obj.abstract : undefined,
					source: normalizeSource(obj.source),
				});
			}
			if (inputs.length === 0) {
				return errorResult('save_papers: every paper was missing a title, so nothing was saved.');
			}
			const results = savePapers(inputs);
			const created = results.filter(r => r.isNew).length;
			const refreshed = results.length - created;
			// Reveal the Paper Library tab ONCE for the whole batch.
			if (revealLibrary) {
				try { revealLibrary(); } catch { /* reveal is optional - the saves already succeeded */ }
			}
			const parts = [`Saved ${results.length} paper(s) to the Qoka paper library`, `${created} new`, `${refreshed} updated`];
			if (skipped) { parts.push(`${skipped} skipped for missing title`); }
			const citekeys = results.map(r => `${r.entry.citekey}: ${r.entry.title}`).join('\n');
			return textResult(`${parts.join(', ')}. They now appear in your Paper Library tab.\nCitekeys (use as [@citekey] in a research note):\n${citekeys}`);
		},
	},
	{
		name: 'list_saved_papers',
		description: 'List the papers in the user\'s Qoka paper library. Optional `query` filters by title, authors, abstract, venue, note, or tag (case-insensitive substring). Returns at most 200 papers in JSON. Each entry includes its `citekey` - that is how the paper is cited in a research note, written inline as [@citekey]. This is the ONLY source of valid citekeys: never invent one, and if the paper you want to cite is not listed here, save it with save_paper first (its response returns the new citekey).',
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
				return textResult('The Qoka paper library has no papers matching that filter yet.');
			}
			const summary = papers.map(p => ({
				id: p.id,
				citekey: p.citekey,
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
