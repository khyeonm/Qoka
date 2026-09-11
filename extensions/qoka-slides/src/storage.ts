/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Deck storage, ported from whirick's server/decks.ts but stripped of the web
// app's auth / ownership / password / folder machinery. Qoka is local + single
// user, so a deck is just a directory of files under the workspace:
//
//   <workspace>/.qoka/slides/<slug>/
//     text.xml      slide markup (each slide = one <section>…</section>)
//     master.xml    optional shared master slide
//     meta.json     { title, theme, aspect, chrome }
//     images/       figure files, referenced from the markup by key (data-fig)
//
// text.xml is the single source of truth. The MCP tools and the manual editor
// both read/write it; the Slides tab watches it and re-renders.

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes, createHash } from 'crypto';

export const SLUG_RE = /^[a-zA-Z0-9._-]+$/;

export type Aspect = '16:9' | '4:3';

export interface DeckChrome {
	/** byline printed bottom-left of content slides; '' hides it. */
	byline?: string;
	/** page number printed bottom-right; '' hides it, e.g. '{n} / {total}'. */
	pageNumber?: string;
	/** the accent bar across the top of content slides */
	strip?: boolean;
	/** auto-inject the theme's brand logo onto content slides */
	logo?: boolean;
	/** accent colour, '#rgb' or '#rrggbb' */
	accent?: string;
	/** soft accent (fills/panels), '#rgb' or '#rrggbb' */
	accentSoft?: string;
}

export interface DeckMeta {
	title?: string;
	/** visual theme id (see themes/) - accent colours, fonts, backgrounds. */
	theme?: string;
	/** deck-level aspect ratio. Decoupled from the theme so one design works at
	 *  either ratio. Defaults to 16:9. */
	aspect?: Aspect;
	/** per-deck overrides for the master-slide chrome (byline / page number / …). */
	chrome?: DeckChrome;
}

/** Design canvas dimensions (px) for an aspect ratio. */
export function canvasFor(aspect: Aspect | undefined): { w: number; h: number } {
	return aspect === '4:3' ? { w: 1440, h: 1080 } : { w: 1920, h: 1080 };
}

/** <workspace>/.qoka/slides - throws when no folder is open (decks are per-project). */
export function slidesRoot(): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		throw new Error('Open a project folder first - slide decks are stored under the project.');
	}
	return path.join(folder.uri.fsPath, '.qoka', 'slides');
}

export function deckDir(slug: string): string {
	return path.join(slidesRoot(), slug);
}

export function figuresDir(slug: string): string {
	return path.join(deckDir(slug), 'images');
}

// A deck's slide markup lives in text.xml.
const TEXT_FILE = 'text.xml';
const MASTER_FILE = 'master.xml';
const STAGE_FILE = '.staging.xml';

async function exists(p: string): Promise<boolean> {
	try { await fs.access(p); return true; } catch { return false; }
}

/** Read a deck's slide markup, or null if the deck has no source file. */
export async function readText(slug: string): Promise<string | null> {
	const p = path.join(deckDir(slug), TEXT_FILE);
	return (await exists(p)) ? fs.readFile(p, 'utf-8') : null;
}

/** Overwrite a deck's slide markup (trailing newline normalised). */
export async function writeText(slug: string, xml: string): Promise<void> {
	await fs.mkdir(deckDir(slug), { recursive: true });
	await fs.writeFile(path.join(deckDir(slug), TEXT_FILE), xml.endsWith('\n') ? xml : xml + '\n');
}

/** Last-modified time (ms) of a deck's markup, for "recent" ordering. 0 if unknown. */
export async function deckModified(slug: string): Promise<number> {
	try { return (await fs.stat(path.join(deckDir(slug), TEXT_FILE))).mtimeMs; } catch { return 0; }
}

export function sha256Hex(s: string): string {
	return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * A short content hash of a deck's markup - the token a client passes back when
 * it writes, so the server can tell "you edited what is actually on disk" apart
 * from "you edited a stale copy". Content-based (not a timestamp) so re-writing
 * identical markup is not a conflict; line endings / trailing blank lines are
 * normalised away first.
 */
export function revisionOf(xml: string): string {
	return sha256Hex(xml.replace(/\r\n?/g, '\n').replace(/\n+$/, '')).slice(0, 12);
}

/** Current revision of a deck's stored markup ('empty' when it has none). */
export async function deckRevision(slug: string): Promise<string> {
	const xml = await readText(slug);
	return xml === null ? 'empty' : revisionOf(xml);
}

export async function readMeta(slug: string): Promise<DeckMeta> {
	try {
		return JSON.parse(await fs.readFile(path.join(deckDir(slug), 'meta.json'), 'utf-8')) as DeckMeta;
	} catch {
		return {};
	}
}

export async function writeMeta(slug: string, meta: DeckMeta): Promise<void> {
	await fs.mkdir(deckDir(slug), { recursive: true });
	await fs.writeFile(path.join(deckDir(slug), 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}

export async function deckExists(slug: string): Promise<boolean> {
	return exists(path.join(deckDir(slug), TEXT_FILE));
}

/** Every deck slug under the slides root (directories with a valid slug name). */
export async function allDeckSlugs(): Promise<string[]> {
	try {
		return (await fs.readdir(slidesRoot(), { withFileTypes: true }))
			.filter(d => d.isDirectory() && SLUG_RE.test(d.name))
			.map(d => d.name);
	} catch {
		return []; // no slides dir yet
	}
}

/** Deck list for the sidebar: slug + meta + last-modified, newest first. */
export async function listDecks(): Promise<{ slug: string; meta: DeckMeta; modified: number }[]> {
	const slugs = await allDeckSlugs();
	const decks = await Promise.all(slugs.map(async slug => ({
		slug,
		meta: await readMeta(slug),
		modified: await deckModified(slug),
	})));
	return decks.sort((a, b) => b.modified - a.modified);
}

/**
 * Map each figure key (image filename without extension) to its file NAME.
 * The webview turns each name into a webview URI (asWebviewUri) against the
 * deck's images/ dir; the MCP layer only ever deals in keys.
 */
export async function readFigures(slug: string): Promise<Record<string, string>> {
	const figures: Record<string, string> = {};
	try {
		for (const file of await fs.readdir(figuresDir(slug))) {
			figures[file.replace(/\.[^.]+$/, '')] = file;
		}
	} catch {
		// no images/ dir
	}
	return figures;
}

/** Split deck markup into its individual <section>…</section> slide strings. */
export function splitSlides(xml: string): string[] {
	return xml.match(/<section\b[\s\S]*?<\/section>/gi) ?? [];
}

// --- master slide ------------------------------------------------------------

export async function readMaster(slug: string): Promise<string | null> {
	try { return await fs.readFile(path.join(deckDir(slug), MASTER_FILE), 'utf-8'); } catch { return null; }
}

/** Replace a deck's master slide. Empty markup deletes it, reverting to the theme. */
export async function writeMaster(slug: string, xml: string): Promise<void> {
	const p = path.join(deckDir(slug), MASTER_FILE);
	if (!xml.trim()) { await fs.rm(p, { force: true }); return; }
	await fs.writeFile(p, xml.endsWith('\n') ? xml : xml + '\n');
}

// --- staged markup upload (large decks streamed in chunks) --------------------

export async function stageAppend(slug: string, chunk: string, reset: boolean): Promise<number> {
	await fs.mkdir(deckDir(slug), { recursive: true });
	const p = path.join(deckDir(slug), STAGE_FILE);
	if (reset) { await fs.writeFile(p, chunk); } else { await fs.appendFile(p, chunk); }
	return (await fs.stat(p)).size;
}

export async function stageRead(slug: string): Promise<string> {
	return fs.readFile(path.join(deckDir(slug), STAGE_FILE), 'utf8');
}

export async function stageDiscard(slug: string): Promise<void> {
	await fs.rm(path.join(deckDir(slug), STAGE_FILE), { force: true });
}

// --- lifecycle ---------------------------------------------------------------

/** Permanently delete a deck directory (markup, images, meta). */
export async function deleteDeck(slug: string): Promise<void> {
	await fs.rm(deckDir(slug), { recursive: true, force: true });
}

/** Turn a free-form base (a title) into a fresh, unused, human-readable slug. */
export async function newSlug(base: string): Promise<string> {
	const clean = base
		.replace(/[^a-zA-Z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase() || 'deck';
	for (let i = 0; i < 20; i++) {
		const slug = `${clean}-${randomBytes(3).toString('hex')}`;
		if (!(await deckExists(slug))) { return slug; }
	}
	return `deck-${randomBytes(6).toString('hex')}`;
}

/** Create a new deck directory (with an empty images/ dir), its meta and seed markup. */
export async function createDeck(slug: string, meta: DeckMeta, xml: string): Promise<void> {
	await fs.mkdir(figuresDir(slug), { recursive: true });
	await writeMeta(slug, meta);
	await writeText(slug, xml);
}

/** Duplicate a whole deck (markup, master, images, meta) into a fresh slug. Returns it. */
export async function duplicateDeck(slug: string, title?: string): Promise<string> {
	const meta = await readMeta(slug);
	const copyMeta: DeckMeta = { ...meta, title: title?.trim() || `${meta.title ?? slug} (copy)` };
	const dst = await newSlug(copyMeta.title || 'deck');
	await createDeck(dst, copyMeta, (await readText(slug)) ?? '');
	const master = await readMaster(slug);
	if (master) { await writeMaster(dst, master); }
	try {
		await fs.cp(figuresDir(slug), figuresDir(dst), { recursive: true });
	} catch {
		// source deck has no images/ dir
	}
	return dst;
}

// --- images ------------------------------------------------------------------

const EXT_BY_TYPE: Record<string, string> = {
	'image/webp': 'webp',
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/svg+xml': 'svg',
};

/** Copy one figure from one deck into another under a fresh key. Bytes copied verbatim. */
export async function copyFigure(from: string, to: string, key: string): Promise<{ key: string } | null> {
	let file: string | undefined;
	try {
		file = (await fs.readdir(figuresDir(from))).find(f => f.replace(/\.[^.]+$/, '') === key);
	} catch {
		return null;
	}
	if (!file) { return null; }
	const ext = file.includes('.') ? file.slice(file.lastIndexOf('.')) : '';
	await fs.mkdir(figuresDir(to), { recursive: true });
	const newKey = `img-${randomBytes(6).toString('hex')}`;
	await fs.copyFile(path.join(figuresDir(from), file), path.join(figuresDir(to), newKey + ext));
	return { key: newKey };
}

/**
 * Persist raw image bytes into the deck's images/ dir under a fresh key; returns
 * the figure key (filename without extension). Accepts a content type to pick an
 * extension. Downscale/WebP optimisation (sharp) is deferred to a later phase -
 * for now bytes are stored as-is.
 */
export async function saveImage(slug: string, bytes: Uint8Array, contentType: string): Promise<{ key: string }> {
	const ext = EXT_BY_TYPE[contentType] ?? 'bin';
	const key = `img-${randomBytes(6).toString('hex')}`;
	await fs.mkdir(figuresDir(slug), { recursive: true });
	await fs.writeFile(path.join(figuresDir(slug), `${key}.${ext}`), bytes);
	return { key };
}
