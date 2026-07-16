/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PaperLibrary, PaperLibraryEntry } from './types';

/**
 * Storage layer for the paper library.
 *
 * PER-PROJECT: each open project keeps its own library at
 * <workspace>/references/paper-library.json (the project's references folder), so
 * papers you save in one project don't leak into another. When no folder is open
 * (e.g. the empty picker window) we fall back to ~/.config/aria so calls never crash.
 *
 * Tiny synchronous reads/writes - the file rarely exceeds a few KB and
 * the in-memory copy stays simple. Atomic writes (tmpfile + rename,
 * mode 0600) keep the file from being corrupted by a crash mid-save.
 */

const SCHEMA_VERSION = 1;

/** Directory holding this project's library: <workspace>/references, or
 *  ~/.config/aria when no folder is open. Computed per call so it always tracks
 *  the current window's workspace. */
function libraryDir(): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder && folder.uri.scheme === 'file') {
		return path.join(folder.uri.fsPath, 'references');
	}
	return path.join(os.homedir(), '.config', 'aria');
}

export function libraryPath(): string {
	return path.join(libraryDir(), 'paper-library.json');
}

/**
 * Ensure the library file exists. Created with an empty papers array if
 * missing - calls into this module that don't change anything still
 * leave a valid file on disk so the sidebar can read it.
 */
export function ensureLibraryFile(): void {
	const libPath = libraryPath();
	if (fs.existsSync(libPath)) {
		return;
	}
	fs.mkdirSync(path.dirname(libPath), { recursive: true });
	const empty: PaperLibrary = { version: SCHEMA_VERSION, papers: [] };
	fs.writeFileSync(libPath, JSON.stringify(empty, null, 2) + '\n', { mode: 0o600 });
}

export function readLibrary(): PaperLibrary {
	ensureLibraryFile();
	try {
		const raw = fs.readFileSync(libraryPath(), 'utf8');
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.papers)) {
			return { version: SCHEMA_VERSION, papers: [] };
		}
		return parsed as PaperLibrary;
	} catch {
		return { version: SCHEMA_VERSION, papers: [] };
	}
}

function writeLibrary(lib: PaperLibrary): void {
	const libPath = libraryPath();
	const tmpPath = `${libPath}.tmp`;
	fs.mkdirSync(path.dirname(libPath), { recursive: true });
	fs.writeFileSync(tmpPath, JSON.stringify(lib, null, 2) + '\n', { mode: 0o600 });
	fs.renameSync(tmpPath, libPath);
}

/**
 * Generate the stable ID we key papers under. DOI wins because two
 * different scholarly databases will share it; without a DOI we hash
 * the URL or title so re-saves dedupe.
 */
export function makeId(input: { doi?: string; url?: string; title: string }): string {
	if (input.doi) {
		return `doi-${input.doi.toLowerCase().replace(/[^a-z0-9.-/]/g, '-')}`;
	}
	if (input.url) {
		const hash = crypto.createHash('sha256').update(input.url).digest('hex').slice(0, 16);
		return `url-${hash}`;
	}
	const hash = crypto.createHash('sha256').update(input.title).digest('hex').slice(0, 16);
	return `title-${hash}`;
}

export interface SavePaperInput {
	title: string;
	authors: string[];
	doi?: string;
	url?: string;
	pdfUrl?: string;
	year?: number;
	venue?: string;
	abstract?: string;
	source?: PaperLibraryEntry['source'];
	note?: string;
	tags?: string[];
}

/**
 * Insert (or upsert) a paper. Returns the stored entry. If a paper with
 * the same ID already exists, the existing note + tags are preserved
 * (so re-saving from Claude doesn't wipe user edits) but the metadata
 * is refreshed.
 */
export function savePaper(input: SavePaperInput): PaperLibraryEntry {
	const lib = readLibrary();
	const id = makeId({ doi: input.doi, url: input.url, title: input.title });
	const existing = lib.papers.find(p => p.id === id);
	const now = new Date().toISOString();
	const entry: PaperLibraryEntry = {
		id,
		title: input.title,
		authors: input.authors,
		year: input.year,
		venue: input.venue,
		doi: input.doi,
		url: input.url,
		pdfUrl: input.pdfUrl,
		abstract: input.abstract,
		source: input.source ?? 'other',
		savedAt: existing?.savedAt ?? now,
		note: existing?.note ?? input.note ?? '',
		tags: existing?.tags ?? input.tags ?? [],
	};
	if (existing) {
		const idx = lib.papers.indexOf(existing);
		lib.papers[idx] = entry;
	} else {
		lib.papers.unshift(entry);
	}
	writeLibrary(lib);
	return entry;
}

export interface ListPapersFilter {
	query?: string;
	tag?: string;
}

/** Return the full list, optionally filtered by query (matches title/
 *  authors/abstract/note) and/or tag (exact match). */
export function listPapers(filter: ListPapersFilter = {}): PaperLibraryEntry[] {
	const lib = readLibrary();
	let results = lib.papers;
	if (filter.tag) {
		const t = filter.tag.toLowerCase();
		results = results.filter(p => p.tags.some(tag => tag.toLowerCase() === t));
	}
	if (filter.query) {
		const q = filter.query.toLowerCase();
		results = results.filter(p => {
			const hay = [
				p.title,
				p.authors.join(' '),
				p.abstract ?? '',
				p.venue ?? '',
				p.note,
				p.tags.join(' '),
			].join(' ').toLowerCase();
			return hay.includes(q);
		});
	}
	return results;
}

/** Distinct tags currently in use across the library, alphabetical. */
export function allTags(): string[] {
	const lib = readLibrary();
	const set = new Set<string>();
	for (const p of lib.papers) {
		for (const t of p.tags) {
			set.add(t);
		}
	}
	return [...set].sort();
}

export function deletePaper(id: string): boolean {
	const lib = readLibrary();
	const before = lib.papers.length;
	lib.papers = lib.papers.filter(p => p.id !== id);
	if (lib.papers.length === before) {
		return false;
	}
	writeLibrary(lib);
	return true;
}

export function updateNote(id: string, note: string): boolean {
	const lib = readLibrary();
	const paper = lib.papers.find(p => p.id === id);
	if (!paper) {
		return false;
	}
	paper.note = note;
	writeLibrary(lib);
	return true;
}

export function updateTags(id: string, tags: string[]): boolean {
	const lib = readLibrary();
	const paper = lib.papers.find(p => p.id === id);
	if (!paper) {
		return false;
	}
	// Normalize: trim, drop blanks, dedupe (case-insensitive), preserve
	// the first casing we saw for each tag.
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of tags) {
		const trimmed = t.trim();
		if (!trimmed) {
			continue;
		}
		const key = trimmed.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(trimmed);
	}
	paper.tags = out;
	writeLibrary(lib);
	return true;
}
