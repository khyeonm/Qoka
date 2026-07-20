/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	addCitation, createPaper, getAssets, getCitations, getManuscript, getMeta,
	getProposal, hasUnsavedEdits, listPapers, OutlineSection, PaperFormat,
	resolvePaper, setAssetSummary, setFocus, setFormat, setOutline, setProposal,
	setTitle, syncManuscriptTitle, writeManuscript,
} from '../papers';
import { ExportFormat, exportPaper } from '../exporter';
import { WRITING_GUIDE } from '../guide';

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
function asNumber(v: unknown): number | undefined { return typeof v === 'number' && isFinite(v) ? v : undefined; }

/** Only English and Korean are supported for now. Returns 'en' | 'ko' | undefined. */
function normalizeLanguage(v: string): 'en' | 'ko' | undefined {
	const s = v.trim().toLowerCase();
	if (s === 'en' || s === 'english' || s === '영어') { return 'en'; }
	if (s === 'ko' || s === 'kr' || s === 'korean' || s === '한국어' || s === '국문') { return 'ko'; }
	return undefined;
}

function resolveOrErr(arg: unknown): { id: string } | CallToolResult {
	const a = asString(arg);
	if (!a) { return err('`paper` (id or title) is required.'); }
	const meta = resolvePaper(a);
	if (!meta) { return err(`No paper matches "${a}". Use list_papers to see ids/titles.`); }
	return { id: meta.id };
}

/**
 * Paper-writing tools. Reads/structure/citations/export operate on the
 * per-project paper store; the actual prose is written by the agent following
 * get_writing_guide. (HITL propose/accept editing arrives in a later phase -
 * for now set_manuscript writes directly.)
 */
export function buildTools(): ToolDefinition[] {
	return [
		{
			name: 'get_writing_guide',
			description: 'Read the manuscript-writing methodology Qoka expects you to follow (structure, source-exclusivity, citation keys, prose rules). Call this before drafting.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => ok(WRITING_GUIDE),
		},
		{
			name: 'create_paper',
			description: 'Create a new, empty paper project and return its id. Writes <project>/paper/<id>/ with a default format.',
			inputSchema: {
				type: 'object',
				properties: { title: { type: 'string', description: 'Working title for the paper.' } },
				required: ['title'],
				additionalProperties: false,
			},
			handler: async (a) => {
				try {
					const meta = createPaper(asString(a.title) ?? 'Untitled');
					// Best-effort: move to the Paper Writing tab and open the new paper
					// so the user lands in the wizard (folder URI is
					// <workspace>/paper/<id>). UI failures must not fail the tool.
					try {
						const folder = vscode.workspace.workspaceFolders?.[0];
						if (folder) {
							const paperUri = vscode.Uri.joinPath(folder.uri, 'paper', meta.id);
							await vscode.commands.executeCommand('workbench.view.ariaPaperWriter');
							await vscode.commands.executeCommand('aria.paperWriter.open', paperUri);
						}
					} catch { /* opening the writing window is best-effort */ }
					return ok(`Created paper "${meta.title}" (id: ${meta.id}). Opened the Paper Writing window - tell the user you moved to the writing window.`);
				} catch (e) { return err(`create_paper failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'list_papers',
			description: 'List paper projects in this workspace (id and title).',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => ok(JSON.stringify(listPapers())),
		},
		{
			name: 'get_paper',
			description: 'Get a paper: its format settings, outline, and the current manuscript Markdown. `paper` is the id or title.',
			inputSchema: {
				type: 'object',
				properties: { paper: { type: 'string', description: 'Paper id or title.' } },
				required: ['paper'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const meta = getMeta(r.id)!;
				const pending = getProposal(r.id);
				const assets = getAssets(r.id);
				return ok(JSON.stringify({
					id: meta.id,
					title: meta.title,
					format: meta.format,
					focus: meta.focus,
					outline: meta.outline,
					manuscript: getManuscript(r.id),
					// User-provided figures/sources (paths are relative to the paper
					// dir). Each has a `summary`; summarize any with an empty summary
					// (read the file, call set_asset_summary) before writing.
					figures: assets.figures,
					sources: assets.sources,
					// If a revision is awaiting the user's review, build your next
					// edit ON TOP OF this (not the saved manuscript) so multiple
					// pending edits accumulate for review.
					pendingRevision: pending ? pending : undefined,
				}, null, 2));
			},
		},
		{
			name: 'set_format',
			description: 'Set the paper\'s format: paperType, targetWords, citationStyle (ieee|apa|nature|vancouver|chicago), language (BCP-47), venue. Only the fields you pass are changed.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					paperType: { type: 'string' },
					targetWords: { type: 'number' },
					citationStyle: { type: 'string', description: 'ieee | apa | nature | chicago | vancouver | ama | harvard | mla | cell | science | pnas | plos | elife | nar | bioinformatics | lancet | bmj | nejm' },
					language: { type: 'string', enum: ['en', 'ko'], description: 'Writing language: en (English) or ko (Korean).' },
					venue: { type: 'string' },
				},
				required: ['paper'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const partial: Partial<PaperFormat> = {};
				if (asString(a.paperType) !== undefined) { partial.paperType = asString(a.paperType); }
				if (asNumber(a.targetWords) !== undefined) { partial.targetWords = asNumber(a.targetWords); }
				if (asString(a.citationStyle) !== undefined) { partial.citationStyle = asString(a.citationStyle); }
				if (asString(a.language) !== undefined) {
					const lang = normalizeLanguage(asString(a.language)!);
					if (!lang) { return err('language must be "en" (English) or "ko" (Korean).'); }
					partial.language = lang;
				}
				if (asString(a.venue) !== undefined) { partial.venue = asString(a.venue); }
				try {
					const meta = setFormat(r.id, partial);
					return ok(`Updated format: ${JSON.stringify(meta.format)}`);
				} catch (e) { return err(`set_format failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'set_title',
			description: 'Set the paper title. Updates the title shown in the Paper Writer sidebar/editor AND the manuscript\'s top-level heading (and the frozen original). Propose a title to the user and get their confirmation BEFORE calling this.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					title: { type: 'string', description: 'The new paper title.' },
				},
				required: ['paper', 'title'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const title = asString(a.title);
				if (title === undefined || !title.trim()) { return err('`title` is required.'); }
				try {
					const meta = setTitle(r.id, title);
					syncManuscriptTitle(r.id); // refresh the manuscript H1 to match
					return ok(`Set title to "${meta.title}".`);
				} catch (e) { return err(`set_title failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'set_focus',
			description: 'Set the research focus - a bullet-point statement of the problem, objectives, gap/contribution, and (if figures exist) where each figure belongs. Develop it with the user one question at a time, then record it here. See get_writing_guide → Focus.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					focus: { type: 'string', description: 'The research-focus statement (bullet points).' },
				},
				required: ['paper', 'focus'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const focus = asString(a.focus);
				if (focus === undefined) { return err('`focus` is required.'); }
				try {
					setFocus(r.id, focus);
					return ok('Saved research focus.');
				} catch (e) { return err(`set_focus failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'set_outline',
			description: 'Set the paper outline: an ordered list of sections, each { title, wordCount?, keyPoints?, citations? } where citations are citekeys from list_citations. Per-section wordCount should sum to targetWords.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					sections: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								title: { type: 'string' },
								wordCount: { type: 'number' },
								keyPoints: { type: 'array', items: { type: 'string' } },
								citations: { type: 'array', items: { type: 'string' } },
							},
							required: ['title'],
							additionalProperties: false,
						},
					},
				},
				required: ['paper', 'sections'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				if (!Array.isArray(a.sections)) { return err('`sections` must be an array.'); }
				try {
					const meta = setOutline(r.id, a.sections as OutlineSection[]);
					return ok(`Set outline (${meta.outline.length} sections).`);
				} catch (e) { return err(`set_outline failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'set_manuscript',
			description: 'Write a FULL draft (initial draft or full re-generation). This RESETS both the working copy and the frozen original baseline to this text and clears any pending review. Use this ONLY for a fresh/whole draft - for editing an existing manuscript use propose_manuscript_revision instead. Use [@citekey] for in-text citations; the chosen style is applied at export. Follow get_writing_guide.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					markdown: { type: 'string', description: 'Full manuscript Markdown.' },
					force: { type: 'boolean', description: 'Set true only after the user confirms discarding their edited version. Required when the working copy has edits not in the original.' },
				},
				required: ['paper', 'markdown'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const md = asString(a.markdown);
				if (md === undefined) { return err('`markdown` is required.'); }
				// Guard: a re-generation discards the user's accepted edits. Make
				// the agent confirm with the user first (the UI re-write button
				// passes force after its own confirm dialog).
				if (a.force !== true && hasUnsavedEdits(r.id)) {
					return ok('This paper has user edits (the working copy differs from the original draft) that a full re-write would discard. Ask the user to confirm they want to replace their edited version; if they agree, call set_manuscript again with force=true. (The frozen original is always kept either way.)');
				}
				try {
					writeManuscript(r.id, md);
					return ok(`Saved new draft (${md.length} chars). Reset the working copy and the original baseline.`);
				} catch (e) { return err(`set_manuscript failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'propose_manuscript_revision',
			description: 'Propose a revised manuscript for the user to REVIEW before it is applied. Pass the FULL revised Markdown (keep unchanged sections/paragraphs verbatim so only your actual edits are highlighted). This does NOT overwrite manuscript.md - it stages the change; Qoka opens a review tab where the user accepts/rejects each changed section or paragraph (added = yellow, removed = red). Use this for partial edits/revisions; use set_manuscript only for the initial full draft. After the user reviews, run export_paper and tell them the output path.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					markdown: { type: 'string', description: 'Full revised manuscript Markdown (unchanged parts kept verbatim).' },
				},
				required: ['paper', 'markdown'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const md = asString(a.markdown);
				if (md === undefined) { return err('`markdown` is required.'); }
				try {
					setProposal(r.id, md);
					return ok(`Staged a proposed revision for review. Qoka is opening a review tab where the user accepts/rejects each change. Wait for the user to review; once they accept, run export_paper and tell them the output path.`);
				} catch (e) { return err(`propose_manuscript_revision failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'list_assets',
			description: 'List the paper\'s figures and supplementary source files (id, file path relative to the paper dir, and AI summary). Read this to know what visuals/data the user provided.',
			inputSchema: {
				type: 'object',
				properties: { paper: { type: 'string', description: 'Paper id or title.' } },
				required: ['paper'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				return ok(JSON.stringify(getAssets(r.id), null, 2));
			},
		},
		{
			name: 'set_asset_summary',
			description: 'Save a concise summary for a figure or source file (the figures/sources writing prompts use the summary, not the raw file). Read the actual file first (view images, read data files), then describe what it shows and the concept it illustrates in 3-4 sentences.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					assetId: { type: 'string', description: 'The asset id from get_paper/list_assets.' },
					summary: { type: 'string', description: 'Concise description of the figure/source.' },
				},
				required: ['paper', 'assetId', 'summary'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const assetId = asString(a.assetId);
				const summary = asString(a.summary);
				if (!assetId || summary === undefined) { return err('`assetId` and `summary` are required.'); }
				const hit = setAssetSummary(r.id, assetId, summary);
				if (!hit) { return err(`No asset "${assetId}" in this paper.`); }
				return ok(`Saved summary for ${hit.name}.`);
			},
		},
		{
			name: 'list_citations',
			description: 'List the citeable references for this paper (CSL-JSON). Only these citekeys may be cited in the manuscript.',
			inputSchema: {
				type: 'object',
				properties: { paper: { type: 'string', description: 'Paper id or title.' } },
				required: ['paper'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const items = getCitations(r.id).map(c => {
					const x = c as Record<string, unknown>;
					return { id: x.id, title: x.title, issued: x.issued };
				});
				return ok(JSON.stringify(items, null, 2));
			},
		},
		{
			name: 'add_citation',
			description: 'Add a citeable reference as a CSL-JSON object (must include a `type` and ideally `id`, `title`, `author`, `issued`). Returns the citekey to use as [@citekey].',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					csl: { type: 'object', description: 'A single CSL-JSON reference item.' },
				},
				required: ['paper', 'csl'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				if (typeof a.csl !== 'object' || a.csl === null) { return err('`csl` must be a CSL-JSON object.'); }
				try {
					const key = addCitation(r.id, a.csl as Record<string, unknown>);
					return ok(`Added citation [@${key}].`);
				} catch (e) { return err(`add_citation failed: ${(e as Error).message}`); }
			},
		},
		{
			name: 'export_paper',
			description: 'Convert / export the manuscript to a file via the BUNDLED pandoc + citeproc. format = markdown | docx | latex. THIS tool is the ONLY correct way to produce a .docx / .tex / .md of the paper - do NOT convert it yourself and NEVER run pandoc (or any converter) in your own terminal/shell: the user has no pandoc installed, Qoka bundles its own, and a terminal attempt silently fails. This works for docx exactly as it does for markdown/latex - the bundled pandoc converts the manuscript Markdown to any of the three. By default it converts the SAVED manuscript.md; to convert text that is NOT saved yet, pass it as `markdown` and it is used directly (and saved as the manuscript if none exists) - so docx export never requires you to save first. In-text citations and the bibliography are rendered in the paper\'s citation style. (PDF is added later.) Returns the output path.',
			inputSchema: {
				type: 'object',
				properties: {
					paper: { type: 'string', description: 'Paper id or title.' },
					format: { type: 'string', description: 'markdown | docx | latex' },
					markdown: { type: 'string', description: 'Optional. The manuscript Markdown to convert. Provide this to export/convert (e.g. to docx) even when the manuscript has NOT been saved yet: it is used as the conversion source, and saved as the manuscript when none exists. Omit to convert the already-saved manuscript.' },
				},
				required: ['paper', 'format'],
				additionalProperties: false,
			},
			handler: async (a) => {
				const r = resolveOrErr(a.paper);
				if ('content' in r) { return r; }
				const fmt = asString(a.format) as ExportFormat | undefined;
				if (fmt !== 'markdown' && fmt !== 'docx' && fmt !== 'latex') {
					return err('`format` must be markdown, docx, or latex.');
				}
				try {
					const res = await exportPaper(r.id, fmt, asString(a.markdown));
					return ok(`Exported ${fmt} -> ${res.outputPath} (style: ${res.style}).`);
				} catch (e) { return err(`export_paper failed: ${(e as Error).message}`); }
			},
		},
	];
}
