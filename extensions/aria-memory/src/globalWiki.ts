/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	PageDetail, PageFrontmatter, PageInfo, SearchHit, WritePageInput, slugify,
} from './wiki';

/**
 * Cross-project ("global") memory - the same on-disk Markdown wiki as the
 * per-project memory (wiki.ts), but rooted at a single USER-level directory so
 * every project on this computer reads and writes the SAME store:
 *
 *   ~/.qoka/memory/wiki/   (os.homedir(), same layout on macOS/Windows/Linux)
 *     index.md   log.md   pages/<slug>.md
 *
 * This replaces the old server-backed mem0 store: no server, no login, no
 * embeddings. Retrieval is keyword search over the Markdown (an "LLM wiki"),
 * identical to the project wiki. Project memory (wiki.ts) is untouched.
 *
 * Cross-machine sync is intentionally out of scope for now; the folder layout
 * leaves room to add git / cloud sync later without touching callers.
 */

const FRONTMATTER_FENCE = '---';

/** Absolute path to the GLOBAL wiki root. Always available (home always exists). */
export function globalWikiRoot(): string {
	return path.join(os.homedir(), '.qoka', 'memory', 'wiki');
}

function pagesDir(root: string): string { return path.join(root, 'pages'); }
function indexPath(root: string): string { return path.join(root, 'index.md'); }
function logPath(root: string): string { return path.join(root, 'log.md'); }

/** Create the global wiki skeleton if missing. Returns the root. */
export function ensureGlobalWiki(): string {
	const root = globalWikiRoot();
	fs.mkdirSync(pagesDir(root), { recursive: true });
	if (!fs.existsSync(indexPath(root))) {
		fs.writeFileSync(indexPath(root), '# Global Memory - Index\n\n_No pages yet._\n', 'utf8');
	}
	if (!fs.existsSync(logPath(root))) {
		fs.writeFileSync(logPath(root), '# Memory Log\n\n', 'utf8');
	}
	return root;
}

// --- frontmatter (de)serialization (same tiny subset as wiki.ts) ------------

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
	const root = globalWikiRoot();
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

/** Parsed page for the Memory tab UI, or undefined. */
export function readPageDetail(slug: string): PageDetail | undefined {
	const raw = readPageRaw(slug);
	if (raw === undefined) { return undefined; }
	const { frontmatter, body } = parsePage(raw);
	return {
		slug,
		title: frontmatter.title || slug,
		type: frontmatter.type || 'other',
		body,
		links: frontmatter.links ?? [],
		created: frontmatter.created,
		updated: frontmatter.updated,
	};
}

/** Full raw markdown (frontmatter + body) of a page, or undefined. */
export function readPageRaw(slug: string): string | undefined {
	const root = globalWikiRoot();
	const filePath = path.join(pagesDir(root), `${slug}.md`);
	return fs.existsSync(filePath) ? safeRead(filePath) : undefined;
}

/**
 * Create or overwrite a page. `created` is preserved across overwrites; `updated`
 * is stamped now. The index is rebuilt and the log appended.
 */
export function writePage(input: WritePageInput): PageInfo {
	const root = ensureGlobalWiki();
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
	appendLog(root, `${existing ? 'update' : 'create'} [[${slug}]] - ${input.title}`);
	return { slug, title: input.title, type: fm.type || 'other', filePath };
}

export function deletePage(slug: string): boolean {
	const root = globalWikiRoot();
	const filePath = path.join(pagesDir(root), `${slug}.md`);
	if (!fs.existsSync(filePath)) { return false; }
	fs.rmSync(filePath);
	rebuildIndex(root);
	appendLog(root, `delete [[${slug}]]`);
	return true;
}

// --- search -----------------------------------------------------------------

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

export function rebuildIndex(root: string): void {
	const pages = listPages().sort((a, b) => a.title.localeCompare(b.title));
	const byType = new Map<string, PageInfo[]>();
	for (const p of pages) {
		const key = p.type || 'other';
		(byType.get(key) ?? byType.set(key, []).get(key)!).push(p);
	}

	const lines: string[] = ['# Global Memory - Index', ''];
	if (!pages.length) {
		lines.push('_No pages yet._', '');
	} else {
		for (const type of [...byType.keys()].sort()) {
			lines.push(`## ${capitalize(type)}`);
			for (const p of byType.get(type)!) {
				lines.push(`- [[${p.slug}]] - ${p.title}`);
			}
			lines.push('');
		}
	}
	fs.writeFileSync(indexPath(root), lines.join('\n'), 'utf8');
}

export function readIndex(): string {
	return safeRead(indexPath(globalWikiRoot()));
}

function appendLog(root: string, entry: string): void {
	const stamp = new Date().toISOString();
	fs.appendFileSync(logPath(root), `- ${stamp} - ${entry}\n`, 'utf8');
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
