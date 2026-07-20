/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getPandoc } from './exporter';
import { exportDir, getManuscript, resolvePaper } from './papers';
import { CallToolResult, ToolDefinition } from './mcp/tools';

const execFileAsync = promisify(execFile);

/**
 * Per-project AI Peer Review storage. Each review run lives in
 * `<workspace>/reviews/<execId>/`:
 *   - meta.json      { execId, title, reviewers[], paperId?, manuscriptFile?, supplementaryFiles[], createdAt, iteration }
 *   - files/         attached originals (manuscript + supplementary) for file-based reviews
 *   - concerns.json  { iteration, reviewers: { <reviewer>: { concerns: Concern[], recordedAt } } }
 *   - revisions/     (Phase 2) staged defensive revisions
 *
 * execId is unique per run, so two reviews of a same-titled paper stay distinct.
 * The Qoka Peer Review tab reads meta/concerns directly; these MCP tools are for
 * the reviewer agent (extract text on read, record structured concerns).
 */

export interface Concern {
	severity: 'major' | 'minor';
	title: string;
	detail: string;
}

export interface ReviewMeta {
	execId: string;
	title: string;
	reviewers: string[];
	/** Set when reviewing an in-project Paper Writer manuscript. */
	paperId?: string;
	/**
	 * Which stored format of that manuscript to review: 'markdown' → the live
	 * manuscript.md, 'docx' → export/paper.docx, 'latex' → export/paper.tex.
	 * Defaults to markdown. docx/latex are extracted to text via pandoc.
	 */
	paperFormat?: 'markdown' | 'docx' | 'latex';
	/** The MAIN manuscript file (relative to the review dir) - the text reviewed,
	 *  previewed, and revised. Set for attached-file reviews. */
	draftFile?: string;
	/** Figure files (relative) - passed to the reviewer by name only. */
	figureFiles?: string[];
	/** Supplementary/data files (relative) - extracted to text as extra context. */
	supplementaryFiles?: string[];
	createdAt: string;
	iteration: number;
}

function ok(text: string): CallToolResult { return { content: [{ type: 'text', text }] }; }
function err(text: string): CallToolResult { return { content: [{ type: 'text', text }], isError: true }; }

export function reviewsDir(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder ? path.join(folder.uri.fsPath, 'reviews') : undefined;
}

function reviewDir(execId: string): string | undefined {
	const dir = reviewsDir();
	return dir ? path.join(dir, execId) : undefined;
}

export function getReviewMeta(execId: string): ReviewMeta | undefined {
	const dir = reviewDir(execId);
	if (!dir) { return undefined; }
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as ReviewMeta;
	} catch {
		return undefined;
	}
}

/** Extract plain text / markdown from an attached document (any common format). */
async function extractText(absFile: string): Promise<string> {
	const ext = path.extname(absFile).toLowerCase();
	if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
		return fs.readFileSync(absFile, 'utf8');
	}
	if (ext === '.docx' || ext === '.tex' || ext === '.html' || ext === '.htm' || ext === '.odt' || ext === '.rtf') {
		const from = ext === '.tex' ? 'latex'
			: (ext === '.html' || ext === '.htm') ? 'html'
				: ext === '.odt' ? 'odt'
					: ext === '.rtf' ? 'rtf'
						: 'docx';
		try {
			const pandoc = await getPandoc();
			const { stdout } = await execFileAsync(pandoc, [absFile, '-f', from, '-t', 'markdown', '--wrap=none'], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
			return stdout;
		} catch (e) {
			return `[Could not extract ${ext} (pandoc): ${(e as Error).message.slice(0, 200)}. Provide the paper as .md if this persists.]`;
		}
	}
	if (ext === '.pdf') {
		try {
			const { stdout } = await execFileAsync('pdftotext', ['-layout', absFile, '-'], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
			return stdout;
		} catch {
			return `[Could not extract PDF text - 'pdftotext' is not available. Convert the paper to .md or .docx and attach that. File: ${path.basename(absFile)}]`;
		}
	}
	// Unknown extension: best-effort as UTF-8 text.
	try { return fs.readFileSync(absFile, 'utf8'); } catch { return `[Unreadable file: ${path.basename(absFile)}]`; }
}

/** Record a reviewer's concerns for a review run. */
function recordConcerns(execId: string, reviewer: string, concerns: Concern[]): void {
	const dir = reviewDir(execId);
	if (!dir) { throw new Error('No workspace folder is open.'); }
	fs.mkdirSync(dir, { recursive: true });
	const p = path.join(dir, 'concerns.json');
	let data: { iteration: number; reviewers: Record<string, { concerns: Concern[]; recordedAt: string }> };
	try {
		data = JSON.parse(fs.readFileSync(p, 'utf8'));
	} catch {
		const meta = getReviewMeta(execId);
		data = { iteration: meta?.iteration ?? 1, reviewers: {} };
	}
	data.reviewers[reviewer] = { concerns, recordedAt: new Date().toISOString() };
	fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

/** One candidate edit (an "Argument / Edit footprint / Risk" strategy). */
export interface RevisionProposal { original: string; replacement: string; explanation: string }
/** Up to 3 alternative proposals that resolve one concern, for one document. */
export interface Revision { documentKey: string; proposals: RevisionProposal[]; recordedAt: string }

/** Extracted-snapshot + working-copy paths for a document, all under `docs/`.
 *  `main` is the draft; `suppl-<i>` are supplementary documents. */
function docPaths(dir: string, docKey: string): { extracted: string; working: string } {
	const base = path.join(dir, 'docs');
	return { extracted: path.join(base, `${docKey}.extracted.md`), working: path.join(base, `${docKey}.working.md`) };
}

function recordRevisionEntry(execId: string, concernId: string, documentKey: string, proposals: RevisionProposal[]): void {
	const dir = reviewDir(execId);
	if (!dir) { throw new Error('No workspace folder is open.'); }
	fs.mkdirSync(dir, { recursive: true });
	const p = path.join(dir, 'revisions.json');
	let data: Record<string, Revision> = {};
	try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* fresh */ }
	data[concernId] = { documentKey, proposals, recordedAt: new Date().toISOString() };
	fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

/** The current editable text for one document of a review: its working copy if
 *  any revisions were accepted, else its extracted snapshot. Defaults to `main`. */
export function reviewWorkingText(execId: string, docKey = 'main'): string | undefined {
	const dir = reviewDir(execId);
	if (!dir) { return undefined; }
	const { extracted, working } = docPaths(dir, docKey);
	for (const p of [working, extracted]) {
		if (fs.existsSync(p)) { try { return fs.readFileSync(p, 'utf8'); } catch { /* next */ } }
	}
	return undefined;
}

/** Next free standalone-edit id (`edit-1`, `edit-2`, …) in a review's revisions. */
function nextEditId(execId: string): string {
	const dir = reviewDir(execId);
	let data: Record<string, unknown> = {};
	if (dir) { try { data = JSON.parse(fs.readFileSync(path.join(dir, 'revisions.json'), 'utf8')); } catch { /* fresh */ } }
	let n = 1;
	while (Object.prototype.hasOwnProperty.call(data, `edit-${n}`)) { n++; }
	return `edit-${n}`;
}

export type ReviewExportFormat = 'markdown' | 'docx' | 'latex';
const REVIEW_EXT: Record<ReviewExportFormat, string> = { markdown: 'md', docx: 'docx', latex: 'tex' };

/** Export one document of a review (working copy) to md/docx/latex inside the
 *  review's own directory. Markdown is a direct write; docx/latex go via pandoc. */
export async function exportReviewPaper(execId: string, format: ReviewExportFormat, docKey = 'main'): Promise<string> {
	const dir = reviewDir(execId);
	if (!dir) { throw new Error('No workspace folder is open.'); }
	const text = reviewWorkingText(execId, docKey);
	if (text === undefined) { throw new Error('No paper text to export yet - run the review first.'); }
	const outDir = path.join(dir, 'export');
	fs.mkdirSync(outDir, { recursive: true });
	const base = docKey === 'main' ? 'paper' : docKey;
	const outPath = path.join(outDir, `${base}.${REVIEW_EXT[format]}`);
	if (format === 'markdown') {
		fs.writeFileSync(outPath, text, 'utf8');
		return outPath;
	}
	const tmp = path.join(outDir, '.export.src.md');
	fs.writeFileSync(tmp, text, 'utf8');
	try {
		const pandoc = await getPandoc();
		const args = [tmp, '-f', 'markdown', '-t', format === 'docx' ? 'docx' : 'latex'];
		if (format === 'latex') { args.push('--standalone'); }
		args.push('-o', outPath);
		await execFileAsync(pandoc, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
	} finally {
		try { fs.unlinkSync(tmp); } catch { /* ignore */ }
	}
	return outPath;
}

function parseConcerns(raw: unknown): Concern[] {
	if (!Array.isArray(raw)) { return []; }
	const out: Concern[] = [];
	for (const c of raw) {
		if (!c || typeof c !== 'object') { continue; }
		const o = c as Record<string, unknown>;
		const severity = o.severity === 'major' ? 'major' : 'minor';
		const title = typeof o.title === 'string' ? o.title : '';
		const detail = typeof o.detail === 'string' ? o.detail : '';
		if (title || detail) { out.push({ severity, title, detail }); }
	}
	return out;
}

/** MCP tools for the reviewer agent. Concatenated onto the paper tools. */
export function buildReviewTools(): ToolDefinition[] {
	return [
		{
			name: 'open_new_review',
			description: 'Open Qoka\'s Peer Review tab and start a NEW review window. Call this FIRST when the user asks IN CHAT to peer-review / critique a paper and you do not yet have an execId. It only opens the UI (best-effort) - it does not start the review. After calling it, tell the user their draft is in the new-review window where they can add figures / supplementary files, and to say when they are done; the actual run is started from the tab (which gives you an execId for get_review).',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				// Best-effort: reveal the Peer Review tab, then open the new-review
				// window. UI failures must not fail the tool.
				try { await vscode.commands.executeCommand('workbench.view.ariaPeerReview'); } catch { /* tab optional */ }
				try { await vscode.commands.executeCommand('aria.peerReview.new'); } catch { /* window optional */ }
				return ok('Opened the new-review window on the Peer Review tab. Tell the user their draft is in and they can add figures / supplementary files there, then say when they are done - only then does the review run (started from the tab).');
			},
		},
		{
			name: 'get_review',
			description: 'Load an AI Peer Review run started from Qoka\'s Peer Review tab. Returns the paper title, the MAIN manuscript text (the thing to review), any supplementary text, referenced figure names, and the reviewers to use. Call this first with the execId Qoka gave you, then run the reviewer sub-agents on the manuscript.',
			inputSchema: {
				type: 'object',
				properties: { execId: { type: 'string', description: 'The review run id Qoka passed in the prompt.' } },
				required: ['execId'],
			},
			handler: async (args) => {
				const execId = typeof args.execId === 'string' ? args.execId : '';
				const meta = getReviewMeta(execId);
				if (!meta) { return err(`No review run "${execId}". It may not have been created yet.`); }
				const dir = reviewDir(execId)!;
				// The MAIN manuscript - the text to review, preview, and revise.
				let manuscript: { name: string; text: string } | undefined;
				if (meta.paperId) {
					const fmt = meta.paperFormat ?? 'markdown';
					if (fmt === 'markdown') {
						let text = getManuscript(meta.paperId) || '';
						if (!text.trim()) { const r = resolvePaper(meta.paperId); text = r ? getManuscript(r.id) : ''; }
						manuscript = { name: `${meta.title}.md`, text };
					} else {
						const exp = exportDir(meta.paperId);
						const abs = exp ? path.join(exp, fmt === 'docx' ? 'paper.docx' : 'paper.tex') : undefined;
						manuscript = (abs && fs.existsSync(abs))
							? { name: path.basename(abs), text: await extractText(abs) }
							: { name: `${meta.title}.md`, text: getManuscript(meta.paperId) || '' };
					}
				} else if (meta.draftFile) {
					manuscript = { name: path.basename(meta.draftFile), text: await extractText(path.join(dir, meta.draftFile)) };
				}
				if (!manuscript) { return err(`Review "${execId}" has no main manuscript file.`); }

				// Supplementary = extra text/data (also revisable); figures = names only.
				const supplementary: { key: string; name: string; text: string }[] = [];
				for (let i = 0; i < (meta.supplementaryFiles ?? []).length; i++) {
					const rel = meta.supplementaryFiles![i];
					supplementary.push({ key: `suppl-${i + 1}`, name: path.basename(rel), text: await extractText(path.join(dir, rel)) });
				}
				const figures = (meta.figureFiles ?? []).map(rel => path.basename(rel));

				// Snapshot each document's extracted text once (so accepted revisions in
				// *.working.md aren't shadowed), and return the working copy when present.
				const load = (docKey: string, name: string, text: string): { key: string; name: string; text: string } => {
					const { extracted, working } = docPaths(dir, docKey);
					if (!fs.existsSync(extracted)) { fs.mkdirSync(path.dirname(extracted), { recursive: true }); try { fs.writeFileSync(extracted, text, 'utf8'); } catch { /* non-fatal */ } }
					if (fs.existsSync(working)) { try { return { key: docKey, name, text: fs.readFileSync(working, 'utf8') }; } catch { /* fall through */ } }
					return { key: docKey, name, text };
				};
				const mainDoc = load('main', manuscript.name, manuscript.text);
				const supplDocs = supplementary.map(sd => load(sd.key, sd.name, sd.text));

				return ok(JSON.stringify({
					execId,
					title: meta.title,
					reviewers: meta.reviewers,
					iteration: meta.iteration,
					manuscript: { key: 'main', name: mainDoc.name, text: mainDoc.text },
					supplementary: supplDocs,
					figures,
					note: 'Review the MAIN manuscript (documentKey "main"). supplementary items (each has a key like "suppl-1") are extra data/context - check the manuscript claims against them, and if a fix belongs in a supplementary document target it via that key. figures are filenames only (you cannot see the images). When proposing a revision, pass the document key as documentKey.',
				}));
			},
		},
		{
			name: 'record_review',
			description: 'Record one reviewer\'s Major/Minor Concerns for a review run so Qoka\'s Peer Review tab can display them. Call once per reviewer after aggregating that reviewer\'s sub-agents. `concerns` is an array of { severity: "major"|"minor", title, detail }.',
			inputSchema: {
				type: 'object',
				properties: {
					execId: { type: 'string', description: 'The review run id.' },
					reviewer: { type: 'string', description: 'Reviewer id, e.g. "claude".' },
					concerns: {
						type: 'array',
						description: 'Concerns. Each: { severity: "major"|"minor", title, detail }.',
						items: {
							type: 'object',
							properties: {
								severity: { type: 'string', enum: ['major', 'minor'] },
								title: { type: 'string' },
								detail: { type: 'string' },
							},
							required: ['severity', 'title'],
						},
					},
				},
				required: ['execId', 'reviewer', 'concerns'],
			},
			handler: async (args) => {
				const execId = typeof args.execId === 'string' ? args.execId : '';
				const reviewer = typeof args.reviewer === 'string' ? args.reviewer : '';
				if (!execId || !reviewer) { return err('execId and reviewer are required.'); }
				if (!getReviewMeta(execId)) { return err(`No review run "${execId}".`); }
				const concerns = parseConcerns(args.concerns);
				try {
					recordConcerns(execId, reviewer, concerns);
				} catch (e) {
					return err(`record_review failed: ${(e as Error).message}`);
				}
				const major = concerns.filter(c => c.severity === 'major').length;
				return ok(`Recorded ${concerns.length} concern(s) for "${reviewer}" (${major} major). Qoka's Peer Review tab will show them.`);
			},
		},
		{
			name: 'record_revision',
			description: 'Propose UP TO 3 alternative revision strategies that resolve ONE concern from a review run. Qoka shows them in a "< N/3 >" carousel with an Accept button; the user browses the strategies and accepts one, which replaces that span in the paper. Call get_review first to read the CURRENT paper. Each proposal is a distinct strategy (different argument / edit footprint / risk) with the EXACT original span to replace (verbatim, long enough to be unique) and the full replacement. Only add reasoning/scoping/framing grounded in the existing paper - never invent data, numbers, procedures, or citations.',
			inputSchema: {
				type: 'object',
				properties: {
					execId: { type: 'string', description: 'The review run id.' },
					concernId: { type: 'string', description: 'The concern id Qoka gave you in the Suggest Revision prompt (e.g. "claude#0").' },
					documentKey: { type: 'string', description: 'Which document to edit: "main" for the manuscript (default), or a supplementary key like "suppl-1" from get_review.' },
					proposals: {
						type: 'array',
						minItems: 1,
						maxItems: 3,
						description: 'Up to 3 alternative strategies. Each: { original, replacement, explanation }. Different proposals may edit different spans.',
						items: {
							type: 'object',
							properties: {
								original: { type: 'string', description: 'Exact span to replace, copied verbatim from the current paper.' },
								replacement: { type: 'string', description: 'The full replacement text for that span.' },
								explanation: { type: 'string', description: 'The strategy: its argument and any risk, in one or two sentences.' },
							},
							required: ['original', 'replacement'],
						},
					},
				},
				required: ['execId', 'concernId', 'proposals'],
			},
			handler: async (args) => {
				const execId = typeof args.execId === 'string' ? args.execId : '';
				const concernId = typeof args.concernId === 'string' ? args.concernId : '';
				const documentKey = typeof args.documentKey === 'string' && args.documentKey ? args.documentKey : 'main';
				if (!execId || !concernId) { return err('execId and concernId are required.'); }
				if (!getReviewMeta(execId)) { return err(`No review run "${execId}".`); }
				const raw = Array.isArray(args.proposals) ? args.proposals : [];
				const proposals: RevisionProposal[] = [];
				for (const item of raw.slice(0, 3)) {
					if (!item || typeof item !== 'object') { continue; }
					const o = item as Record<string, unknown>;
					const original = typeof o.original === 'string' ? o.original : '';
					const replacement = typeof o.replacement === 'string' ? o.replacement : '';
					const explanation = typeof o.explanation === 'string' ? o.explanation : '';
					if (original) { proposals.push({ original, replacement, explanation }); }
				}
				if (!proposals.length) { return err('`proposals` must contain at least one strategy with an `original` span.'); }
				const current = reviewWorkingText(execId, documentKey) ?? '';
				const missing = proposals.filter(p => current && !current.includes(p.original));
				if (missing.length) {
					return err(`These proposal 'original' spans were not found verbatim in the current paper: ${missing.map(m => JSON.stringify(m.original.slice(0, 40))).join(', ')}. Call get_review again and copy exact text (punctuation/whitespace included).`);
				}
				try {
					recordRevisionEntry(execId, concernId, documentKey, proposals);
				} catch (e) {
					return err(`record_revision failed: ${(e as Error).message}`);
				}
				return ok(`Recorded ${proposals.length} revision strategy(ies) for concern ${concernId}. Qoka shows them in a "< N/${proposals.length} >" carousel with an Accept button.`);
			},
		},
		{
			name: 'propose_document_edit',
			description: 'Propose an edit to ONE document of a review (the "main" manuscript or a supplementary doc like "suppl-1") that the USER directly asked for and is NOT tied to a review concern - e.g. "delete the title in the supplementary", "fix this typo". Qoka shows it inline in that document (auto-switching to its tab) with an Accept button; nothing changes until the user accepts. This is for the REVIEW\'s documents - do NOT use Paper Writer tools for these. (For fixing a specific review concern, use record_revision instead.) You may give up to 3 alternative `proposals`; the user browses "< N/3 >" and accepts one. Call get_review first and copy the exact text. Set `replacement` to "" to delete a span.',
			inputSchema: {
				type: 'object',
				properties: {
					execId: { type: 'string', description: 'The review run id.' },
					documentKey: { type: 'string', description: 'Which document to edit: "main" (default) or a supplementary key like "suppl-1" from get_review.' },
					proposals: {
						type: 'array',
						minItems: 1,
						maxItems: 3,
						description: 'Up to 3 alternative ways to make the requested edit. Each: { original, replacement, explanation }.',
						items: {
							type: 'object',
							properties: {
								original: { type: 'string', description: 'Exact span to change, copied verbatim from the document.' },
								replacement: { type: 'string', description: 'Replacement text; use "" to delete the span.' },
								explanation: { type: 'string', description: 'One line on what this does.' },
							},
							required: ['original'],
						},
					},
				},
				required: ['execId', 'proposals'],
			},
			handler: async (args) => {
				const execId = typeof args.execId === 'string' ? args.execId : '';
				const documentKey = typeof args.documentKey === 'string' && args.documentKey ? args.documentKey : 'main';
				if (!execId) { return err('execId is required.'); }
				if (!getReviewMeta(execId)) { return err(`No review run "${execId}".`); }
				const raw = Array.isArray(args.proposals) ? args.proposals : [];
				const proposals: RevisionProposal[] = [];
				for (const item of raw.slice(0, 3)) {
					if (!item || typeof item !== 'object') { continue; }
					const o = item as Record<string, unknown>;
					const original = typeof o.original === 'string' ? o.original : '';
					const replacement = typeof o.replacement === 'string' ? o.replacement : '';
					const explanation = typeof o.explanation === 'string' ? o.explanation : '';
					if (original) { proposals.push({ original, replacement, explanation }); }
				}
				if (!proposals.length) { return err('`proposals` must contain at least one { original, replacement }.'); }
				const current = reviewWorkingText(execId, documentKey) ?? '';
				const missing = proposals.filter(p => current && !current.includes(p.original));
				if (missing.length) {
					return err(`These 'original' spans were not found verbatim in "${documentKey}": ${missing.map(m => JSON.stringify(m.original.slice(0, 40))).join(', ')}. Call get_review again and copy exact text.`);
				}
				try {
					recordRevisionEntry(execId, nextEditId(execId), documentKey, proposals);
				} catch (e) {
					return err(`propose_document_edit failed: ${(e as Error).message}`);
				}
				return ok(`Proposed ${proposals.length} edit option(s) for "${documentKey}". Qoka switched to that document and shows an Accept button - nothing is applied until the user accepts.`);
			},
		},
	];
}
