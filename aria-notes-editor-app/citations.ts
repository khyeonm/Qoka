/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Citation parsing for the note editor webview.
 *
 * Mirrors `extensions/aria-notes/src/citations.ts` - the same `[@citekey]` syntax
 * read from the same documents, but this bundle cannot import from the extension
 * (separate package, separate build). The two must agree on the rules below;
 * change one, change the other:
 *   - a citation group is `[...]` containing at least one `@key`
 *   - `\[@key]` is escaped and means literal text
 *   - code (a code block, or an inline-code run) is never scanned
 *   - only keys present in the paper library count as citations
 *   - numbering is by first appearance; a repeat reuses its number
 */

export interface CitablePaper {
	citekey: string;
	title: string;
	authors?: string[];
	year?: number;
	venue?: string;
}

export interface CitationEntry {
	citekey: string;
	number: number;
	occurrences: number;
	paper: CitablePaper;
}

const KEY_SOURCE = '[A-Za-z0-9_][A-Za-z0-9_:.#$%&+?<>~/-]*';

/** Citekeys inside one `[...]` group, in written order. */
export function keysInGroup(inner: string): string[] {
	const keys: string[] = [];
	for (const part of inner.split(';')) {
		const at = part.trim().replace(/^-/, '');       // `-@key` suppresses the author
		if (!at.startsWith('@')) { continue; }
		const match = new RegExp(`^${KEY_SOURCE}`).exec(at.slice(1));
		if (match) { keys.push(match[0]); }
	}
	return keys;
}

/** All citation groups in a string, with their positions. */
export function groupsInText(text: string): { start: number; end: number; inner: string; innerStart: number }[] {
	const out: { start: number; end: number; inner: string; innerStart: number }[] = [];
	const re = /(\\?)\[([^\]\n]*)\]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m[1]) { continue; }                         // escaped
		if (keysInGroup(m[2]).length === 0) { continue; }
		const start = m.index + m[1].length;
		out.push({ start, end: start + m[2].length + 2, inner: m[2], innerStart: start + 1 });
	}
	return out;
}

// --- document walking -------------------------------------------------------

interface BlockLike {
	id?: string;
	type?: string;
	content?: unknown;
	children?: unknown;
}

interface StyledItem {
	type?: string;
	text?: string;
	styles?: Record<string, unknown>;
	content?: unknown;
}

/** A block's prose, with inline-code runs omitted so code is never scanned. */
export function blockProse(block: BlockLike): string {
	if (block.type === 'codeBlock') { return ''; }
	const parts: string[] = [];
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const v of value) { walk(v); }
			return;
		}
		if (!value || typeof value !== 'object') { return; }
		const item = value as StyledItem;
		if (item.styles && item.styles.code) { return; }
		if (typeof item.text === 'string') { parts.push(item.text); return; }
		// Links, and table rows/cells, whose exact shape varies by version.
		for (const v of Object.values(value as Record<string, unknown>)) {
			if (v && (Array.isArray(v) || typeof v === 'object')) { walk(v); }
		}
	};
	walk(block.content);
	return parts.join('');
}

/** Depth-first pre-order, the reading order the reference list numbers by. */
export function walkBlocks(blocks: unknown[], visit: (block: BlockLike) => void): void {
	for (const raw of blocks ?? []) {
		const block = raw as BlockLike;
		if (!block || typeof block !== 'object') { continue; }
		visit(block);
		if (Array.isArray(block.children)) { walkBlocks(block.children, visit); }
	}
}

/**
 * The note's reference list: every cited paper once, numbered by first
 * appearance. Keys with no paper in the library are dropped rather than flagged -
 * they are indistinguishable from ordinary text a user happened to write, so
 * marking them would turn `[@todo]` into a false alarm. A citation that really
 * did break is caught where it breaks: deleting the paper from the library warns
 * which notes cite it.
 */
export function referenceList(blocks: unknown[], papers: Map<string, CitablePaper>): CitationEntry[] {
	const byKey = new Map<string, CitationEntry>();
	walkBlocks(blocks, block => {
		const text = blockProse(block);
		if (!text.includes('[@')) { return; }
		for (const group of groupsInText(text)) {
			for (const key of keysInGroup(group.inner)) {
				const paper = papers.get(key);
				if (!paper) { continue; }
				const existing = byKey.get(key);
				if (existing) {
					existing.occurrences++;
				} else {
					byKey.set(key, { citekey: key, number: byKey.size + 1, occurrences: 1, paper });
				}
			}
		}
	});
	return [...byKey.values()];
}

/** A citation the pointer or caret is on, and the exact character range it covers
 *  so the editor can paint it. For a multi-paper group the range narrows to the
 *  single `@key` under the cursor, which is what makes `[@a; @b]` readable. */
export interface CitationSpan {
	citekey: string;
	start: number;
	end: number;
}

/** The individual `@key` parts of a group, each with the range it occupies. */
function partsOfGroup(group: { inner: string; innerStart: number }, papers: Map<string, CitablePaper>): CitationSpan[] {
	const parts: CitationSpan[] = [];
	let cursor = group.innerStart;
	for (const part of group.inner.split(';')) {
		const partEnd = cursor + part.length;
		const at = part.trim().replace(/^-/, '');
		if (at.startsWith('@')) {
			const match = new RegExp(`^${KEY_SOURCE}`).exec(at.slice(1));
			if (match && papers.has(match[0])) {
				// The written part (`@key`, plus any locator), not the bare key, so the
				// painted range lines up with what is on screen.
				const leading = part.length - part.trimStart().length;
				const trailing = part.length - part.trimEnd().length;
				parts.push({ citekey: match[0], start: cursor + leading, end: partEnd - trailing });
			}
		}
		cursor = partEnd + 1;                            // the ';'
	}
	return parts;
}

/** How far `offset` sits outside a span (0 when inside it). */
function distanceTo(span: CitationSpan, offset: number): number {
	if (offset < span.start) { return span.start - offset; }
	if (offset > span.end) { return offset - span.end; }
	return 0;
}

/**
 * The citation at `offset` inside `text`, if the offset sits on one.
 *
 * Always resolves to exactly ONE citation, even inside `[@a; @b]`. The offset
 * can legitimately land on a character that belongs to no key - the brackets,
 * the separator, or past the end of the line - and returning the whole group
 * there would light up two citations while the hover card described only one.
 * Those positions snap to the NEAREST key instead, so what is painted is always
 * what the card is talking about. A lone citation still paints its brackets,
 * since there is nothing to tell apart.
 */
export function citationAtOffset(text: string, offset: number, papers: Map<string, CitablePaper>): CitationSpan | undefined {
	for (const group of groupsInText(text)) {
		if (offset < group.start || offset > group.end) { continue; }
		const parts = partsOfGroup(group, papers);
		if (parts.length === 0) { continue; }
		if (parts.length === 1) {
			return { citekey: parts[0].citekey, start: group.start, end: group.end };
		}
		return parts.reduce((best, part) => (distanceTo(part, offset) < distanceTo(best, offset) ? part : best));
	}
	return undefined;
}

/** Where in the document a paper is cited, so selecting it in the reference list
 *  can point at the places it is used. */
export interface CitationOccurrence {
	blockId: string;
	start: number;
	end: number;
}

export function occurrencesOf(blocks: unknown[], citekey: string, papers: Map<string, CitablePaper>): CitationOccurrence[] {
	const out: CitationOccurrence[] = [];
	walkBlocks(blocks, block => {
		if (typeof block.id !== 'string') { return; }
		const text = blockProse(block);
		if (!text.includes('[@')) { return; }
		for (const group of groupsInText(text)) {
			const parts = partsOfGroup(group, papers);
			if (parts.length === 0) { continue; }
			for (const part of parts) {
				if (part.citekey !== citekey) { continue; }
				// A lone citation highlights its brackets, matching what hovering it does.
				const span = parts.length === 1 ? { start: group.start, end: group.end } : part;
				out.push({ blockId: block.id as string, start: span.start, end: span.end });
			}
		}
	});
	return out;
}

/** The citekey at `offset`, when only the key matters. */
export function keyAtOffset(text: string, offset: number, papers: Map<string, CitablePaper>): string | undefined {
	return citationAtOffset(text, offset, papers)?.citekey;
}

// --- insertion planning -----------------------------------------------------

/**
 * What to write for a citation at `offset`, applying the two placement rules
 * (kept identical to the extension's `planInsertion`):
 *   - a leading space when the previous character is not whitespace
 *   - merging into an adjacent `[@kim2024]` as `[@kim2024; @lu2026]` instead of
 *     stacking two brackets
 * Returns null when the key is already in that adjacent group.
 */
export function planInsertion(text: string, offset: number, citekey: string): { at: number; insert: string } | null {
	const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
	const group = /\[([^\]\n]*)\]$/.exec(before);
	if (group && keysInGroup(group[1]).length > 0) {
		if (keysInGroup(group[1]).includes(citekey)) { return null; }
		return { at: before.length - 1, insert: `; @${citekey}` };
	}
	const needsSpace = before.length > 0 && !/\s$/.test(before);
	return { at: before.length, insert: `${needsSpace ? ' ' : ''}[@${citekey}]` };
}

/** One-line reference, matching what the extension reports for the same paper. */
export function formatReference(paper: CitablePaper): string {
	const authors = paper.authors?.length
		? (paper.authors.length > 3 ? `${paper.authors.slice(0, 3).join(', ')} et al.` : paper.authors.join(', '))
		: 'Unknown author';
	const year = paper.year ? ` (${paper.year})` : '';
	const venue = paper.venue ? ` ${paper.venue}.` : '';
	return `${authors}${year}. ${paper.title}.${venue}`;
}
