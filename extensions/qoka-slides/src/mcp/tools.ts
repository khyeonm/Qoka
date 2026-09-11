/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
	Aspect, DeckMeta, canvasFor, listDecks, readMeta, writeMeta, readText, writeText,
	deckRevision, splitSlides, deckExists, newSlug, createDeck, deleteDeck, duplicateDeck,
	readFigures, saveImage,
} from '../storage';
import { loadTheme, listThemes } from '../themes';
import { seedDeckXml } from '../templates';

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
function json(value: unknown): CallToolResult { return ok(JSON.stringify(value, null, 2)); }

function asString(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined; }
function asNumber(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }
function asAspect(v: unknown): Aspect | undefined { return v === '16:9' || v === '4:3' ? v : undefined; }

/** Reveal the Slides tab (provided by the core Slides view). Best-effort - a
 *  build without the view still runs the MCP; the tab just does not open. */
async function revealSlides(): Promise<void> {
	try { await vscode.commands.executeCommand('qoka.slides.open'); } catch { /* tab optional */ }
}

/** A blank slide sized to the deck's canvas (elements are added by the AI/user). */
const BLANK_SECTION = '<section></section>';

/** Insert `slides` into `deck` at 1-based position `at` (append when out of range). */
function insertSlidesAt(deckXml: string, slides: string[], at: number): string {
	const existing = splitSlides(deckXml);
	const idx = Math.max(0, Math.min(at - 1, existing.length));
	existing.splice(idx, 0, ...slides);
	return existing.join('\n');
}

export function buildTools(extensionPath: string): ToolDefinition[] {
	const themesRoot = path.join(extensionPath, 'themes');
	return [
		{
			name: 'list_themes',
			description: 'List the available slide designs (themes) to choose from when creating a deck. Each has an id, a display name, and a default aspect. The user picks a design first, then a ratio (16:9 or 4:3).',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				try { return json(listThemes(themesRoot)); } catch (e) { return err((e as Error).message); }
			},
		},
		{
			name: 'open_slides',
			description: 'Open / reveal the Slides tab so the user can watch the deck render live. Call this BEFORE you start creating or editing a deck.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => { await revealSlides(); return ok('Slides tab opened.'); },
		},
		{
			name: 'list_decks',
			description: 'List every slide deck in this project (slug, title, slide count, last-modified). Use get_deck to read one.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				try {
					const decks = await listDecks();
					const out = await Promise.all(decks.map(async d => ({
						slug: d.slug,
						title: d.meta.title ?? d.slug,
						theme: d.meta.theme ?? null,
						aspect: d.meta.aspect ?? '16:9',
						slides: splitSlides((await readText(d.slug)) ?? '').length,
					})));
					return json(out);
				} catch (e) { return err((e as Error).message); }
			},
		},
		{
			name: 'get_deck',
			description: "Read one deck: title, theme, aspect, the full slide markup (the XML you edit), the design canvas size (px), and the current `revision`. ALWAYS read a deck here before changing it, and pass the `revision` back when you write so a stale copy cannot clobber newer edits.",
			inputSchema: {
				type: 'object',
				properties: { slug: { type: 'string', description: 'Deck slug' } },
				required: ['slug'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const slug = asString(args.slug);
				if (!slug) { return err('Missing slug.'); }
				try {
					if (!(await deckExists(slug))) { return err(`No such deck: ${slug}`); }
					const meta = await readMeta(slug);
					const xml = (await readText(slug)) ?? '';
					const aspect = meta.aspect ?? '16:9';
					return json({
						slug,
						title: meta.title ?? slug,
						theme: meta.theme ?? null,
						aspect,
						canvas: canvasFor(aspect),
						slides: splitSlides(xml).length,
						revision: await deckRevision(slug),
						xml,
					});
				} catch (e) { return err((e as Error).message); }
			},
		},
		{
			name: 'create_deck',
			description: "Create a new slide deck. Pick a design (theme id from list_themes) and an aspect ('16:9' default, or '4:3'). Optionally seed the slide markup with `xml` (a series of <section>…</section> slides using absolute-px positioned elements on the canvas); omit it for one blank slide to fill in. Returns the new deck's slug + revision and opens the Slides tab.",
			inputSchema: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'Deck title (shown in the sidebar).' },
					theme: { type: 'string', description: 'Design/theme id (see list_themes).' },
					aspect: { type: 'string', enum: ['16:9', '4:3'], description: "Aspect ratio; default '16:9'." },
					xml: { type: 'string', description: 'Optional seed markup (<section> slides).' },
				},
				required: ['title'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const title = asString(args.title);
				if (!title) { return err('Missing title.'); }
				try {
					const aspect = asAspect(args.aspect) ?? '16:9';
					const themeId = asString(args.theme);
					const meta: DeckMeta = { title, theme: themeId, aspect };
					let seed = asString(args.xml)?.trim();
					if (!seed) {
						const theme = themeId ? loadTheme(themesRoot, themeId, aspect) : undefined;
						seed = theme ? seedDeckXml(theme) : BLANK_SECTION;
					}
					const slug = await newSlug(title);
					await createDeck(slug, meta, seed);
					await revealSlides();
					return json({ slug, revision: await deckRevision(slug), slides: splitSlides(seed).length });
				} catch (e) { return err((e as Error).message); }
			},
		},
		{
			name: 'update_deck',
			description: "Replace a deck's ENTIRE slide markup. Pass the `revision` you got from get_deck as `revision`; if the deck has changed since (the user edited it in the tab), the write is refused so nothing is lost - re-read with get_deck and re-apply. To change one slide only, prefer update_slide.",
			inputSchema: {
				type: 'object',
				properties: {
					slug: { type: 'string' },
					xml: { type: 'string', description: 'The full deck markup (<section> slides).' },
					revision: { type: 'string', description: 'The revision from get_deck (optimistic concurrency).' },
				},
				required: ['slug', 'xml'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const slug = asString(args.slug); const xml = asString(args.xml);
				if (!slug || xml === undefined) { return err('Missing slug or xml.'); }
				try {
					if (!(await deckExists(slug))) { return err(`No such deck: ${slug}`); }
					const rev = asString(args.revision);
					if (rev && rev !== (await deckRevision(slug))) {
						return err('Deck has changed since you read it (revision mismatch). Call get_deck again, reconcile, then retry.');
					}
					await writeText(slug, xml);
					return json({ slug, slides: splitSlides(xml).length, revision: await deckRevision(slug) });
				} catch (e) { return err((e as Error).message); }
			},
		},
		{
			name: 'get_slide',
			description: 'Read one slide (1-based) of a deck as its <section> markup.',
			inputSchema: {
				type: 'object',
				properties: { slug: { type: 'string' }, n: { type: 'number', description: '1-based slide number.' } },
				required: ['slug', 'n'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const slug = asString(args.slug); const n = asNumber(args.n);
				if (!slug || n === undefined) { return err('Missing slug or n.'); }
				try {
					const slides = splitSlides((await readText(slug)) ?? '');
					if (n < 1 || n > slides.length) { return err(`Slide ${n} out of range (deck has ${slides.length}).`); }
					return ok(slides[n - 1]);
				} catch (e) { return err((e as Error).message); }
			},
		},
		{
			name: 'add_slide',
			description: "Add a slide. `xml` is one <section>…</section> with absolute-px positioned elements on the deck canvas. `at` (1-based) inserts before that position; omit to append. Returns the new slide count + revision.",
			inputSchema: {
				type: 'object',
				properties: {
					slug: { type: 'string' },
					xml: { type: 'string', description: 'One <section> slide.' },
					at: { type: 'number', description: '1-based insert position; omit to append.' },
				},
				required: ['slug', 'xml'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const slug = asString(args.slug); const xml = asString(args.xml);
				if (!slug || !xml) { return err('Missing slug or xml.'); }
				try {
					const deck = (await readText(slug)) ?? '';
					const slides = splitSlides(xml);
					if (!slides.length) { return err('xml must contain at least one <section>…</section>.'); }
					const at = asNumber(args.at) ?? splitSlides(deck).length + 1;
					const next = insertSlidesAt(deck, slides, at);
					await writeText(slug, next);
					return json({ slug, slides: splitSlides(next).length, revision: await deckRevision(slug) });
				} catch (e) { return err((e as Error).message); }
			},
		},
		{
			name: 'update_slide',
			description: 'Replace slide `n` (1-based) with a new <section> markup.',
			inputSchema: {
				type: 'object',
				properties: { slug: { type: 'string' }, n: { type: 'number' }, xml: { type: 'string', description: 'One <section> slide.' } },
				required: ['slug', 'n', 'xml'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const slug = asString(args.slug); const n = asNumber(args.n); const xml = asString(args.xml);
				if (!slug || n === undefined || !xml) { return err('Missing slug, n or xml.'); }
				try {
					const slides = splitSlides((await readText(slug)) ?? '');
					if (n < 1 || n > slides.length) { return err(`Slide ${n} out of range (deck has ${slides.length}).`); }
					const one = splitSlides(xml);
					if (!one.length) { return err('xml must contain a <section>…</section>.'); }
					slides[n - 1] = one[0];
					const next = slides.join('\n');
					await writeText(slug, next);
					return json({ slug, slides: slides.length, revision: await deckRevision(slug) });
				} catch (e) { return err((e as Error).message); }
			},
		},
		{
			name: 'delete_slide',
			description: 'Delete slide `n` (1-based) from a deck.',
			inputSchema: {
				type: 'object',
				properties: { slug: { type: 'string' }, n: { type: 'number' } },
				required: ['slug', 'n'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const slug = asString(args.slug); const n = asNumber(args.n);
				if (!slug || n === undefined) { return err('Missing slug or n.'); }
				try {
					const slides = splitSlides((await readText(slug)) ?? '');
					if (n < 1 || n > slides.length) { return err(`Slide ${n} out of range (deck has ${slides.length}).`); }
					slides.splice(n - 1, 1);
					const next = slides.join('\n');
					await writeText(slug, next);
					return json({ slug, slides: slides.length, revision: await deckRevision(slug) });
				} catch (e) { return err((e as Error).message); }
			},
		},
		{
			name: 'set_deck_meta',
			description: "Update a deck's title / theme / aspect. Only the fields you pass change. Changing aspect re-lays the canvas (16:9 = 1920x1080, 4:3 = 1440x1080).",
			inputSchema: {
				type: 'object',
				properties: {
					slug: { type: 'string' },
					title: { type: 'string' },
					theme: { type: 'string' },
					aspect: { type: 'string', enum: ['16:9', '4:3'] },
				},
				required: ['slug'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const slug = asString(args.slug);
				if (!slug) { return err('Missing slug.'); }
				try {
					if (!(await deckExists(slug))) { return err(`No such deck: ${slug}`); }
					const meta = await readMeta(slug);
					const title = asString(args.title); if (title !== undefined) { meta.title = title; }
					const theme = asString(args.theme); if (theme !== undefined) { meta.theme = theme; }
					const aspect = asAspect(args.aspect); if (aspect !== undefined) { meta.aspect = aspect; }
					await writeMeta(slug, meta);
					return json({ slug, title: meta.title, theme: meta.theme ?? null, aspect: meta.aspect ?? '16:9' });
				} catch (e) { return err((e as Error).message); }
			},
		},
		{
			name: 'add_image',
			description: "Add an image to a deck's figure store and get its KEY to place with <img data-fig=\"KEY\">. Supply exactly one source: `path` (a file in the workspace), `data` (base64 or a data: URI, for an image not on disk), or `url` (downloaded and stored). Returns { key }.",
			inputSchema: {
				type: 'object',
				properties: {
					slug: { type: 'string' },
					path: { type: 'string', description: 'Local file path (absolute, or relative to the project).' },
					data: { type: 'string', description: 'Base64 image bytes, or a full data: URI.' },
					url: { type: 'string', description: 'Image URL to download.' },
					contentType: { type: 'string', description: "Optional mime, e.g. 'image/png' (inferred when omitted)." },
				},
				required: ['slug'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const slug = asString(args.slug);
				if (!slug) { return err('Missing slug.'); }
				try {
					if (!(await deckExists(slug))) { return err(`No such deck: ${slug}`); }
					let bytes: Uint8Array | undefined;
					let contentType = asString(args.contentType) ?? '';
					const p = asString(args.path);
					const data = asString(args.data);
					const url = asString(args.url);
					if (p) {
						const abs = path.isAbsolute(p) ? p : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', p);
						bytes = new Uint8Array(await fs.readFile(abs));
						if (!contentType) { contentType = mimeFromExt(abs); }
					} else if (data) {
						const m = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(data);
						if (m) {
							if (!contentType) { contentType = m[1] || 'image/png'; }
							bytes = new Uint8Array(Buffer.from(m[3], m[2] ? 'base64' : 'utf8'));
						} else {
							bytes = new Uint8Array(Buffer.from(data, 'base64'));
							if (!contentType) { contentType = 'image/png'; }
						}
					} else if (url) {
						const res = await fetch(url);
						if (!res.ok) { return err(`Download failed: ${res.status} ${res.statusText}`); }
						bytes = new Uint8Array(await res.arrayBuffer());
						if (!contentType) { contentType = res.headers.get('content-type') || mimeFromExt(url); }
					} else {
						return err('Provide one of: path, data, url.');
					}
					const { key } = await saveImage(slug, bytes, contentType || 'image/png');
					return json({ key, place: `<img data-fig="${key}">` });
				} catch (e) { return err((e as Error).message); }
			},
		},
		{
			name: 'list_images',
			description: "List a deck's figure keys (place one with <img data-fig=\"KEY\">).",
			inputSchema: {
				type: 'object',
				properties: { slug: { type: 'string' } },
				required: ['slug'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const slug = asString(args.slug);
				if (!slug) { return err('Missing slug.'); }
				try { return json(Object.keys(await readFigures(slug))); } catch (e) { return err((e as Error).message); }
			},
		},
		{
			name: 'duplicate_deck',
			description: 'Duplicate a deck (markup, images, meta) into a new one. Optional `title` for the copy.',
			inputSchema: {
				type: 'object',
				properties: { slug: { type: 'string' }, title: { type: 'string' } },
				required: ['slug'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const slug = asString(args.slug);
				if (!slug) { return err('Missing slug.'); }
				try {
					if (!(await deckExists(slug))) { return err(`No such deck: ${slug}`); }
					const dst = await duplicateDeck(slug, asString(args.title));
					return json({ slug: dst });
				} catch (e) { return err((e as Error).message); }
			},
		},
		{
			name: 'delete_deck',
			description: 'Permanently delete a deck (markup, images, meta). Confirm with the user first.',
			inputSchema: {
				type: 'object',
				properties: { slug: { type: 'string' } },
				required: ['slug'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const slug = asString(args.slug);
				if (!slug) { return err('Missing slug.'); }
				try {
					if (!(await deckExists(slug))) { return err(`No such deck: ${slug}`); }
					await deleteDeck(slug);
					return ok(`Deleted deck ${slug}.`);
				} catch (e) { return err((e as Error).message); }
			},
		},
	];
}

const MIME_BY_EXT: Record<string, string> = {
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
	'.webp': 'image/webp', '.svg': 'image/svg+xml',
};

function mimeFromExt(p: string): string {
	const ext = p.slice(p.lastIndexOf('.')).toLowerCase().replace(/[?#].*$/, '');
	return MIME_BY_EXT[ext] ?? 'image/png';
}
