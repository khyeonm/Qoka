/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { listPapers, savePaper, savePapers, SavePaperInput } from '../library';
import { resolveIdentifier, titlesMatch } from '../resolver';

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

/** A save that was refused because the identifier names a different paper. */
interface Conflict {
	claimedTitle: string;
	resolvedTitle: string;
	identifier: string;
}

type VerifyOutcome =
	| { kind: 'saved'; input: SavePaperInput }
	| { kind: 'conflict'; conflict: Conflict };

/**
 * Replace the assistant's transcribed metadata with the registration agency's
 * record, and refuse the save when the identifier turns out to name a different
 * paper.
 *
 * This is code, not an instruction: `save_paper` is the only way into the
 * library, so putting the check here is the only way to make it unconditional.
 *
 * Resolution failing is NOT a refusal. Offline, a timeout, an agency that does
 * not answer - the paper is still saved with what the assistant had, marked as
 * unverified so the sidebar and the background sweep can repair it later. The
 * library is a reading list as well as a citation source, and losing a save
 * because a network call did not land would be the wrong trade.
 */
async function verifyBeforeSave(
	input: SavePaperInput,
	identifiers: { doi?: string; pmid?: string; arxiv?: string },
	trustDoi: boolean,
): Promise<VerifyOutcome> {
	if (!identifiers.doi && !identifiers.pmid && !identifiers.arxiv) {
		return { kind: 'saved', input: { ...input, metadataSource: 'assistant' } };
	}
	const record = await resolveIdentifier(identifiers);
	if (!record) {
		return { kind: 'saved', input: { ...input, metadataSource: 'assistant' } };
	}
	// `trustDoi` is how the user's answer comes back: they were shown both titles
	// and said the identifier is the right one, so the check is not re-run.
	if (!trustDoi && !titlesMatch(input.title, record.title)) {
		return {
			kind: 'conflict',
			conflict: {
				claimedTitle: input.title,
				resolvedTitle: record.title,
				identifier: identifiers.doi ?? identifiers.pmid ?? identifiers.arxiv ?? '',
			},
		};
	}
	return {
		kind: 'saved',
		input: {
			...input,
			// Replaced wholesale, not merged: a truncated author list looks complete,
			// so filling only the blanks would leave it wrong.
			title: record.title,
			authors: record.authors,
			year: record.year ?? input.year,
			venue: record.venue ?? input.venue,
			doi: record.doi ?? identifiers.doi ?? input.doi,
			// Kept from the assistant - registries carry these rarely or not at all.
			abstract: input.abstract,
			pdfUrl: input.pdfUrl,
			csl: record.csl,
			metadataSource: record.source,
			cslType: record.cslType,
		},
	};
}

function describeConflict(conflict: Conflict): string {
	return [
		`  You asked to save: "${conflict.claimedTitle}"`,
		`  but ${conflict.identifier} is: "${conflict.resolvedTitle}"`,
	].join('\n');
}

/** Resolve at most `limit` inputs at a time - a 20-paper batch run serially would
 *  stack twenty round trips onto one tool call. */
async function inPool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) { return; }
			results[index] = await work(items[index]);
		}
	});
	await Promise.all(runners);
	return results;
}

export const ALL_TOOLS: ToolDefinition[] = [
	{
		name: 'save_paper',
		description: 'Save a SINGLE paper to the user\'s Qoka paper library. To save SEVERAL papers at once, do NOT call this repeatedly - use `save_papers` (one batched call) instead. ALWAYS pass the `doi` (or `pmid` / `arxiv`) when the search result has one: the paper is then looked up at the registration agency and its authors, year, venue, volume, issue and pages are taken from the publisher\'s own record, so you do NOT need to transcribe them carefully - the identifier matters far more than the fields you copy. Only the title is required; without an identifier the entry is saved exactly as you give it and marked unverified. If the identifier turns out to name a DIFFERENT paper the save is REFUSED and both titles are returned: show them to the user, ask which paper they meant, and then either call again with `trustDoi: true` (they confirmed the identifier) or call again without the identifier (it was wrong). Re-saving an existing paper (same DOI or URL) refreshes its metadata but preserves the user\'s note, tags and citekey. After a successful save the Paper Library sidebar tab opens automatically, so tell the user it now appears in their Paper Library tab.',
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
				pmid: { type: 'string', description: 'PubMed ID, used to look the paper up when there is no DOI.' },
				arxiv: { type: 'string', description: 'arXiv id (e.g. "2401.12345"), used to look the paper up when there is no DOI.' },
				trustDoi: { type: 'string', description: 'Pass "true" ONLY after the user confirmed the identifier names the paper they meant, to save it despite a title mismatch.' },
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
			const identifiers = {
				doi: typeof args.doi === 'string' ? args.doi : undefined,
				pmid: typeof args.pmid === 'string' ? args.pmid : undefined,
				arxiv: typeof args.arxiv === 'string' ? args.arxiv : undefined,
			};
			const outcome = await verifyBeforeSave(
				{
					title,
					authors,
					doi: identifiers.doi,
					url: typeof args.url === 'string' ? args.url : undefined,
					pdfUrl: typeof args.pdfUrl === 'string' ? args.pdfUrl : undefined,
					year: typeof args.year === 'number' ? args.year : undefined,
					venue: typeof args.venue === 'string' ? args.venue : undefined,
					abstract: typeof args.abstract === 'string' ? args.abstract : undefined,
					source: normalizeSource(args.source),
				},
				identifiers,
				String(args.trustDoi ?? '') === 'true',
			);

			if (outcome.kind === 'conflict') {
				return errorResult(
					`NOT SAVED - that identifier names a different paper.\n${describeConflict(outcome.conflict)}\n\n` +
					`Ask the user which paper they meant, then call save_paper again: with trustDoi: "true" if the identifier is right, ` +
					`or without the identifier if it is wrong.`
				);
			}

			const entry = savePaper(outcome.input);
			// Best-effort: reveal the Paper Library tab so the saved paper shows
			// (the view auto-refreshes when it becomes visible). Never let a
			// headless/no-UI context or a hidden view break the save.
			if (revealLibrary) {
				try {
					revealLibrary();
				} catch { /* reveal is optional - the save already succeeded */ }
			}
			const verified = entry.metadataSource && entry.metadataSource !== 'assistant'
				? ` Metadata verified against ${entry.metadataSource}.`
				: ' Metadata is unverified (no identifier resolved); it can be verified later from the Paper Library tab.';
			return textResult(`Saved "${entry.title}" to the Qoka paper library (id: ${entry.id}, citekey: ${entry.citekey}).${verified} Cite it in a research note as [@${entry.citekey}].`);
		},
	},
	{
		name: 'save_papers',
		description: 'Save SEVERAL papers to the user\'s Qoka paper library in ONE call. Use this instead of calling save_paper repeatedly whenever the user wants to save more than one paper (e.g. "save these", "save all of them") - it writes the library once and opens the Paper Library tab once. Pass an array of paper objects, each with the same fields as save_paper (only `title` is required per paper). ALWAYS include each paper\'s `doi` (or `pmid` / `arxiv`) when the search result has one: those papers are looked up at the registration agency and their bibliographic fields are taken from the publisher\'s own record, so the identifier matters far more than the fields you transcribe. Papers with no title are skipped. A paper whose identifier names a DIFFERENT paper is NOT saved - the rest still are - and comes back in the response with both titles: show those to the user, ask which paper they meant, then re-save each one individually with save_paper (with `trustDoi: "true"` if the identifier is right, or without the identifier if it is wrong). After saving, tell the user how many were added and that they now appear in their Paper Library tab.',
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
							pmid: { type: 'string', description: 'PubMed ID, used to look the paper up when there is no DOI.' },
							arxiv: { type: 'string', description: 'arXiv id, used to look the paper up when there is no DOI.' },
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
			const pending: { input: SavePaperInput; identifiers: { doi?: string; pmid?: string; arxiv?: string } }[] = [];
			let skipped = 0;
			for (const p of raw) {
				const obj = (p && typeof p === 'object') ? p as Record<string, unknown> : {};
				const title = typeof obj.title === 'string' ? obj.title.trim() : '';
				if (!title) { skipped++; continue; }        // best-effort: skip the untitled, keep the rest
				const authors = Array.isArray(obj.authors) ? obj.authors.map(a => String(a)).filter(Boolean) : [];
				const identifiers = {
					doi: typeof obj.doi === 'string' ? obj.doi : undefined,
					pmid: typeof obj.pmid === 'string' ? obj.pmid : undefined,
					arxiv: typeof obj.arxiv === 'string' ? obj.arxiv : undefined,
				};
				pending.push({
					identifiers,
					input: {
						title,
						authors,
						doi: identifiers.doi,
						url: typeof obj.url === 'string' ? obj.url : undefined,
						pdfUrl: typeof obj.pdfUrl === 'string' ? obj.pdfUrl : undefined,
						year: typeof obj.year === 'number' ? obj.year : undefined,
						venue: typeof obj.venue === 'string' ? obj.venue : undefined,
						abstract: typeof obj.abstract === 'string' ? obj.abstract : undefined,
						source: normalizeSource(obj.source),
					},
				});
			}
			if (pending.length === 0) {
				return errorResult('save_papers: every paper was missing a title, so nothing was saved.');
			}

			// Look the batch up concurrently, then write the library ONCE - the whole
			// point of this tool over repeated save_paper calls.
			const outcomes = await inPool(pending, 5, item => verifyBeforeSave(item.input, item.identifiers, false));
			const inputs = outcomes.filter(o => o.kind === 'saved').map(o => (o as { input: SavePaperInput }).input);
			const conflicts = outcomes.filter(o => o.kind === 'conflict').map(o => (o as { conflict: Conflict }).conflict);

			if (inputs.length === 0) {
				return errorResult(
					`NOT SAVED - every identifier named a different paper.\n${conflicts.map(describeConflict).join('\n\n')}\n\n` +
					`Ask the user which paper they meant for each, then save them one at a time with save_paper.`
				);
			}

			const results = savePapers(inputs);
			const created = results.filter(r => r.isNew).length;
			const refreshed = results.length - created;
			const unverified = results.filter(r => !r.entry.metadataSource || r.entry.metadataSource === 'assistant').length;
			// Reveal the Paper Library tab ONCE for the whole batch.
			if (revealLibrary) {
				try { revealLibrary(); } catch { /* reveal is optional - the saves already succeeded */ }
			}
			const parts = [`Saved ${results.length} paper(s) to the Qoka paper library`, `${created} new`, `${refreshed} updated`];
			if (unverified) { parts.push(`${unverified} unverified (no identifier resolved)`); }
			if (skipped) { parts.push(`${skipped} skipped for missing title`); }
			const citekeys = results.map(r => `${r.entry.citekey}: ${r.entry.title}`).join('\n');
			const conflictNote = conflicts.length
				? `\n\nNOT SAVED - ${conflicts.length} paper(s) whose identifier names a different paper:\n${conflicts.map(describeConflict).join('\n\n')}\n` +
				`Ask the user which paper they meant for each, then save those individually with save_paper (trustDoi: "true" if the identifier is right, or without it if it is wrong).`
				: '';
			return textResult(`${parts.join(', ')}. They now appear in your Paper Library tab.\nCitekeys (use as [@citekey] in a research note):\n${citekeys}${conflictNote}`);
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
				// 'assistant' means nobody checked these fields against a registry.
				verifiedFrom: p.metadataSource && p.metadataSource !== 'assistant' ? p.metadataSource : undefined,
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
