/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Per-project "LLM wiki" storage — the single-project half of Aria's memory
 * system. (The cross-project half is a mem0 store added later; see the
 * project plan.)
 *
 * The wiki is just Markdown on disk under `<workspace>/.aria/memory/wiki/`:
 *
 *   index.md          — a generated catalog of pages, grouped by type
 *   log.md            — append-only record of every ingest (audit / rollback)
 *   pages/<slug>.md   — one page per topic, with YAML-ish frontmatter
 *
 * There is deliberately no database and no embedding index at this stage:
 * plain files stay transparent, git-versionable, and human-readable, and the
 * `index.md` catalog is enough to drive retrieval at moderate scale (per the
 * Karpathy "LLM wiki" approach). The intelligence — deciding whether a new
 * fact is a fresh page or an edit to an existing one — lives in the caller
 * (the foreground agent or, later, the background extractor); this module
 * only provides the read/write/search primitives.
 *
 * Scoping is by workspace folder: opening a different project points every
 * operation at that project's own wiki, so project memories never leak
 * across projects.
 */

const FRONTMATTER_FENCE = '---';

/** Page types the index groups by. Free-form `type` values are allowed but
 *  land under "Other" in the index. */
export interface PageFrontmatter {
	title: string;
	/** e.g. decision | entity | experiment | constraint | reference */
	type?: string;
	/** slugs of related pages, rendered as [[wikilinks]] in the body. */
	links?: string[];
	/** ISO timestamps, maintained by the engine. */
	created?: string;
	updated?: string;
}

export interface PageInfo {
	slug: string;
	title: string;
	type: string;
	filePath: string;
}

export interface SearchHit {
	slug: string;
	title: string;
	type: string;
	/** A short snippet of body text around the first match. */
	excerpt: string;
	score: number;
}

/** Absolute path to the wiki root for the current workspace, or undefined
 *  when no folder is open. */
export function wikiRoot(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder ? path.join(folder.uri.fsPath, '.aria', 'memory', 'wiki') : undefined;
}

function pagesDir(root: string): string { return path.join(root, 'pages'); }
function indexPath(root: string): string { return path.join(root, 'index.md'); }
function logPath(root: string): string { return path.join(root, 'log.md'); }

/** Create the wiki directory skeleton if it does not exist yet. Returns the
 *  root, or throws if no workspace folder is open. */
export function ensureWiki(): string {
	const root = wikiRoot();
	if (!root) {
		throw new Error('No workspace folder is open, so there is no project to store memory for.');
	}
	fs.mkdirSync(pagesDir(root), { recursive: true });
	if (!fs.existsSync(indexPath(root))) {
		fs.writeFileSync(indexPath(root), '# Project Memory — Index\n\n_No pages yet._\n', 'utf8');
	}
	if (!fs.existsSync(logPath(root))) {
		fs.writeFileSync(logPath(root), '# Memory Log\n\n', 'utf8');
	}
	return root;
}

/** Turn an arbitrary title into a filesystem-safe slug. */
export function slugify(title: string): string {
	const base = title
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9가-힣\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	return base || 'page';
}

// --- frontmatter (de)serialization ------------------------------------------
// A deliberately tiny YAML subset: `key: value` scalars plus a `links:` list
// written inline as `[a, b, c]`. Enough for our fixed field set; we never feed
// it arbitrary YAML, so a full parser would be overkill.

function serializeFrontmatter(fm: PageFrontmatter): string {
	const lines: string[] = [FRONTMATTER_FENCE];
	lines.push(`title: ${fm.title}`);
	if (fm.type) { lines.push(`type: ${fm.type}`); }
	if (fm.links && fm.links.length) { lines.push(`links: [${fm.links.join(', ')}]`); }
	if (fm.created) { lines.push(`created: ${fm.created}`); }
	if (fm.updated) { lines.push(`updated: ${fm.updated}`); }
	lines.push(FRONTMATTER_FENCE);
	return lines.join('\n');
}

interface ParsedPage {
	frontmatter: PageFrontmatter;
	body: string;
}

function parsePage(raw: string): ParsedPage {
	const fm: PageFrontmatter = { title: '' };
	if (!raw.startsWith(FRONTMATTER_FENCE)) {
		return { frontmatter: fm, body: raw.trim() };
	}
	const end = raw.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length);
	if (end === -1) {
		return { frontmatter: fm, body: raw.trim() };
	}
	const head = raw.slice(FRONTMATTER_FENCE.length, end).trim();
	const body = raw.slice(end + FRONTMATTER_FENCE.length + 1).trim();
	for (const line of head.split('\n')) {
		const idx = line.indexOf(':');
		if (idx <= 0) { continue; }
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (key === 'title') { fm.title = value; }
		else if (key === 'type') { fm.type = value; }
		else if (key === 'created') { fm.created = value; }
		else if (key === 'updated') { fm.updated = value; }
		else if (key === 'links') {
			fm.links = value.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
		}
	}
	return { frontmatter: fm, body };
}

// --- page CRUD --------------------------------------------------------------

export function listPages(): PageInfo[] {
	const root = wikiRoot();
	if (!root) { return []; }
	let files: string[] = [];
	try {
		files = fs.readdirSync(pagesDir(root)).filter(f => f.endsWith('.md'));
	} catch {
		return [];
	}
	return files.map(f => {
		const filePath = path.join(pagesDir(root), f);
		const slug = f.replace(/\.md$/, '');
		const { frontmatter } = parsePage(safeRead(filePath));
		return { slug, title: frontmatter.title || slug, type: frontmatter.type || 'other', filePath };
	});
}

/** Resolve a page by slug (exact), then title (exact, then substring). */
export function resolvePage(ref: string): PageInfo | undefined {
	const pages = listPages();
	const arg = ref.trim().toLowerCase();
	return pages.find(p => p.slug.toLowerCase() === arg)
		?? pages.find(p => p.title.toLowerCase() === arg)
		?? pages.find(p => p.title.toLowerCase().includes(arg));
}

/** Full raw markdown (frontmatter + body) of a page, or undefined. */
export function readPageRaw(slug: string): string | undefined {
	const root = wikiRoot();
	if (!root) { return undefined; }
	const filePath = path.join(pagesDir(root), `${slug}.md`);
	return fs.existsSync(filePath) ? safeRead(filePath) : undefined;
}

export interface WritePageInput {
	title: string;
	type?: string;
	body: string;
	links?: string[];
}

/**
 * Create or overwrite a page. Returns the resulting PageInfo. `created` is
 * preserved across overwrites; `updated` is stamped now. The index is
 * rebuilt and the log appended so the on-disk catalog stays consistent.
 */
export function writePage(input: WritePageInput): PageInfo {
	const root = ensureWiki();
	const slug = slugify(input.title);
	const filePath = path.join(pagesDir(root), `${slug}.md`);
	const now = new Date().toISOString();

	const existing = fs.existsSync(filePath) ? parsePage(safeRead(filePath)) : undefined;
	const fm: PageFrontmatter = {
		title: input.title,
		type: input.type || existing?.frontmatter.type,
		links: input.links ?? existing?.frontmatter.links,
		created: existing?.frontmatter.created ?? now,
		updated: now,
	};

	const contents = `${serializeFrontmatter(fm)}\n\n${input.body.trim()}\n`;
	fs.writeFileSync(filePath, contents, 'utf8');
	rebuildIndex(root);
	appendLog(root, `${existing ? 'update' : 'create'} [[${slug}]] — ${input.title}`);
	return { slug, title: input.title, type: fm.type || 'other', filePath };
}

export function deletePage(slug: string): boolean {
	const root = wikiRoot();
	if (!root) { return false; }
	const filePath = path.join(pagesDir(root), `${slug}.md`);
	if (!fs.existsSync(filePath)) { return false; }
	fs.rmSync(filePath);
	rebuildIndex(root);
	appendLog(root, `delete [[${slug}]]`);
	return true;
}

// --- search -----------------------------------------------------------------

/**
 * Keyword search across page titles and bodies. Intentionally simple (no
 * embeddings yet): tokenizes the query, scores title matches higher than body
 * matches, and returns an excerpt around the first body hit. Good enough for
 * a moderate-sized wiki; swap in FTS/embeddings here later without touching
 * callers.
 */
export function searchPages(query: string, limit = 5): SearchHit[] {
	const terms = query.toLowerCase().split(/\s+/).map(t => t.trim()).filter(Boolean);
	if (!terms.length) { return []; }

	const hits: SearchHit[] = [];
	for (const page of listPages()) {
		const { frontmatter, body } = parsePage(safeRead(page.filePath));
		const title = (frontmatter.title || page.slug).toLowerCase();
		const bodyLower = body.toLowerCase();
		let score = 0;
		for (const term of terms) {
			if (title.includes(term)) { score += 3; }
			const count = bodyLower.split(term).length - 1;
			score += Math.min(count, 3);
		}
		if (score === 0) { continue; }
		hits.push({
			slug: page.slug,
			title: frontmatter.title || page.slug,
			type: frontmatter.type || 'other',
			excerpt: excerptAround(body, terms[0]),
			score,
		});
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function excerptAround(body: string, term: string): string {
	const idx = body.toLowerCase().indexOf(term);
	if (idx === -1) { return body.slice(0, 160).trim(); }
	const start = Math.max(0, idx - 60);
	const end = Math.min(body.length, idx + 100);
	return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`;
}

// --- index + log ------------------------------------------------------------

/** Regenerate index.md from the current pages, grouped by type. */
export function rebuildIndex(root: string): void {
	const pages = listPages().sort((a, b) => a.title.localeCompare(b.title));
	const byType = new Map<string, PageInfo[]>();
	for (const p of pages) {
		const key = p.type || 'other';
		(byType.get(key) ?? byType.set(key, []).get(key)!).push(p);
	}

	const lines: string[] = ['# Project Memory — Index', ''];
	if (!pages.length) {
		lines.push('_No pages yet._', '');
	} else {
		for (const type of [...byType.keys()].sort()) {
			lines.push(`## ${capitalize(type)}`);
			for (const p of byType.get(type)!) {
				lines.push(`- [[${p.slug}]] — ${p.title}`);
			}
			lines.push('');
		}
	}
	fs.writeFileSync(indexPath(root), lines.join('\n'), 'utf8');
}

export function readIndex(): string {
	const root = wikiRoot();
	if (!root) { return ''; }
	return safeRead(indexPath(root));
}

function appendLog(root: string, entry: string): void {
	const stamp = new Date().toISOString();
	fs.appendFileSync(logPath(root), `- ${stamp} — ${entry}\n`, 'utf8');
}

// --- helpers ----------------------------------------------------------------

function safeRead(filePath: string): string {
	try {
		return fs.readFileSync(filePath, 'utf8');
	} catch {
		return '';
	}
}

function capitalize(s: string): string {
	return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
