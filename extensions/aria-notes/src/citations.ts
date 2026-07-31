/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Citations inside a research note.
 *
 * A citation is plain text in the note: `[@citekey]`, pandoc's citeproc syntax -
 * the same one the manuscript writer already uses (`manuscript.md` +
 * `citations.csl.json`), so a note promoted into a paper section carries its
 * citations over untouched, and a future export can hand the note straight to
 * pandoc.
 *
 * Nothing about a citation is stored beside the text. The reference list at the
 * bottom of a note, its numbering, and the hover cards are all DERIVED by
 * scanning the document, which is why inserting a citation in the middle never
 * needs anything renumbered: the document is the only source of truth.
 *
 * Two readers live here:
 *   - `collectCitations` walks the whole document (including tables) to build
 *     the reference list. Read-only, so it can afford to be broad.
 *   - `findAnchorMatches` / `insertCitation` operate only on blocks with a plain
 *     inline array, because that is where text can be spliced back safely.
 * Both skip code (a code block or an inline-code run), so a shell snippet like
 * `"${files[@]}"` is never mistaken for a citation.
 */

// --- block/inline access ----------------------------------------------------

interface StyledItem {
	type?: string;
	text?: string;
	styles?: Record<string, unknown>;
	content?: unknown;
}

interface BlockLike {
	id?: string;
	type?: string;
	content?: unknown;
	children?: unknown;
}

/** Blocks whose text is code, and therefore never carries citations. */
function isCodeBlock(block: BlockLike): boolean {
	return block.type === 'codeBlock';
}

/** The plain inline array of a block, when it has one. Table blocks store their
 *  content as an object instead, so they are excluded here (they are still read
 *  for the reference list, just never spliced into). */
function inlineArrayOf(block: BlockLike): unknown[] | undefined {
	return Array.isArray(block.content) ? block.content : undefined;
}

/** One contiguous run of prose inside a block's inline array, and where it sits
 *  in the block's flattened text. `path` navigates nested content (link children). */
interface InlineRun {
	path: number[];
	start: number;
	length: number;
}

/**
 * The block's prose as one string, plus a map back into the inline items.
 * Inline-code runs are omitted from BOTH, so an offset into `text` always lands
 * on real prose and can be mapped back unambiguously.
 */
export function flattenInline(content: unknown): { text: string; runs: InlineRun[] } {
	const runs: InlineRun[] = [];
	let text = '';
	const walk = (items: unknown, prefix: number[]): void => {
		if (!Array.isArray(items)) { return; }
		items.forEach((raw, i) => {
			const item = raw as StyledItem;
			if (!item || typeof item !== 'object') { return; }
			if (item.type === 'text' && typeof item.text === 'string') {
				if (item.styles && item.styles.code) { return; }   // inline code is not prose
				runs.push({ path: [...prefix, i], start: text.length, length: item.text.length });
				text += item.text;
			} else if (Array.isArray(item.content)) {
				// Links (and any other wrapper carrying inline children).
				walk(item.content, [...prefix, i]);
			}
		});
	};
	walk(content, []);
	return { text, runs };
}

/** Every text fragment in a value, for the read-only reference-list scan. Used
 *  for table content, whose shape (rows / cells) differs across BlockNote
 *  versions - walking generically is more durable than matching one shape. */
function collectText(value: unknown, out: string[]): void {
	if (Array.isArray(value)) {
		for (const v of value) { collectText(v, out); }
		return;
	}
	if (!value || typeof value !== 'object') { return; }
	const item = value as StyledItem;
	if (item.styles && item.styles.code) { return; }
	if (typeof item.text === 'string') {
		// `text` is the whole payload of a styled run; recursing further would
		// re-collect nothing useful.
		out.push(item.text);
		return;
	}
	for (const v of Object.values(value as Record<string, unknown>)) {
		if (v && typeof v === 'object') { collectText(v, out); }
	}
}

/** Blocks in reading order: each block, then its children (depth-first pre-order),
 *  which is the order the reference list numbers citations in. */
export function walkBlocks(blocks: unknown[], visit: (block: BlockLike) => void): void {
	for (const raw of blocks ?? []) {
		const block = raw as BlockLike;
		if (!block || typeof block !== 'object') { continue; }
		visit(block);
		if (Array.isArray(block.children)) { walkBlocks(block.children, visit); }
	}
}

// --- parsing ----------------------------------------------------------------

/** A whole citation group, e.g. `[@a]` or `[@a; @b]`, optionally escaped by a
 *  preceding backslash so a note can talk about the syntax itself. */
const GROUP_RE = /(\\?)\[([^\]\n]*)\]/g;
/** A citekey: starts alphanumeric, then pandoc's permitted key characters. */
const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_:.#$%&+?<>~/-]*/;

/** The citekeys inside one `[...]` group, in written order. Non-citation
 *  brackets (`[see below]`, a markdown link label) yield nothing. */
export function keysInGroup(inner: string): string[] {
	const keys: string[] = [];
	for (const part of inner.split(';')) {
		// `-@key` suppresses the author in pandoc; `@key, p. 33` carries a locator.
		const at = part.trim().replace(/^-/, '');
		if (!at.startsWith('@')) { continue; }
		const match = KEY_RE.exec(at.slice(1));
		if (match) { keys.push(match[0]); }
	}
	return keys;
}

/** Every citekey in a piece of prose, in order, duplicates included. */
export function keysInText(text: string): string[] {
	const keys: string[] = [];
	GROUP_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = GROUP_RE.exec(text)) !== null) {
		if (m[1]) { continue; }                     // escaped: \[@name] is literal text
		keys.push(...keysInGroup(m[2]));
	}
	return keys;
}

export interface CitationUse {
	citekey: string;
	/** 1-based position in the reference list, by first appearance. */
	number: number;
	/** How many times the note cites it. */
	occurrences: number;
}

/**
 * The note's citations in reference-list order. A repeated citation reuses its
 * number and does NOT get a second entry, which is what numeric styles (IEEE,
 * Vancouver) do and what pandoc will produce on export.
 */
export function collectCitations(blocks: unknown[]): CitationUse[] {
	const byKey = new Map<string, CitationUse>();
	walkBlocks(blocks, block => {
		if (isCodeBlock(block)) { return; }
		const parts: string[] = [];
		const inline = inlineArrayOf(block);
		if (inline) {
			parts.push(flattenInline(inline).text);
		} else if (block.content !== undefined) {
			collectText(block.content, parts);          // tables and other shapes
		}
		for (const key of keysInText(parts.join('\n'))) {
			const existing = byKey.get(key);
			if (existing) {
				existing.occurrences++;
			} else {
				byKey.set(key, { citekey: key, number: byKey.size + 1, occurrences: 1 });
			}
		}
	});
	return [...byKey.values()];
}

// --- anchors ----------------------------------------------------------------

export interface AnchorMatch {
	blockId: string;
	/** Offset in the block's flattened prose where the citation would land. */
	offset: number;
	/** Surrounding prose, so the user can tell candidate positions apart. */
	context: string;
}

const CONTEXT_RADIUS = 45;

/**
 * Every place `anchor` occurs, as a position just AFTER it (where the citation
 * goes). An anchor must sit inside a single block: matching across block
 * boundaries would give a position no splice can act on.
 */
export function findAnchorMatches(blocks: unknown[], anchor: string): AnchorMatch[] {
	const needle = anchor.trim();
	const matches: AnchorMatch[] = [];
	if (!needle) { return matches; }
	walkBlocks(blocks, block => {
		if (isCodeBlock(block) || typeof block.id !== 'string') { return; }
		const inline = inlineArrayOf(block);
		if (!inline) { return; }
		const { text } = flattenInline(inline);
		let from = 0;
		for (; ;) {
			const at = text.indexOf(needle, from);
			if (at < 0) { break; }
			const end = at + needle.length;
			matches.push({
				blockId: block.id as string,
				offset: end,
				context: contextAround(text, at, end),
			});
			from = at + 1;
		}
	});
	return matches;
}

function contextAround(text: string, from: number, to: number): string {
	const start = Math.max(0, from - CONTEXT_RADIUS);
	const end = Math.min(text.length, to + CONTEXT_RADIUS);
	return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/** Prose text of one block by id, for positioning a citation the user clicks. */
export function blockText(blocks: unknown[], blockId: string): string | undefined {
	let found: string | undefined;
	walkBlocks(blocks, block => {
		if (found !== undefined || block.id !== blockId) { return; }
		const inline = inlineArrayOf(block);
		if (inline) { found = flattenInline(inline).text; }
	});
	return found;
}

// --- insertion --------------------------------------------------------------

/**
 * What to splice in at `offset` for a citation, following the two placement
 * rules:
 *   - leading space: `tissue` + `[@lu2026]` becomes `tissue [@lu2026]`, never
 *     `tissue[@lu2026]`.
 *   - adjacent merge: inserting right after an existing `[@kim2024]` extends it
 *     into `[@kim2024; @lu2026]` rather than stacking two brackets, which is
 *     both what authors mean and what pandoc expects.
 * Returns null when the citation is already there, so a repeat is a no-op
 * instead of a duplicate inside one bracket.
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

/** Replace the item at `path` with up to three items: the text before the split,
 *  the inserted (unstyled) text, and the text after. Styling is preserved on the
 *  original halves so the citation itself never inherits bold/italic. */
function spliceRun(content: unknown[], path: number[], localOffset: number, insert: string): unknown[] {
	const clone = [...content];
	const index = path[0];
	const item = clone[index] as StyledItem | undefined;
	if (!item) { return clone; }
	if (path.length > 1 && Array.isArray(item.content)) {
		clone[index] = { ...item, content: spliceRun(item.content, path.slice(1), localOffset, insert) };
		return clone;
	}
	const text = typeof item.text === 'string' ? item.text : '';
	const head = text.slice(0, localOffset);
	const tail = text.slice(localOffset);
	const hasStyles = !!item.styles && Object.keys(item.styles).length > 0;
	if (!hasStyles) {
		clone[index] = { ...item, text: head + insert + tail };
		return clone;
	}
	const pieces: unknown[] = [];
	if (head) { pieces.push({ ...item, text: head }); }
	pieces.push({ type: 'text', text: insert, styles: {} });
	if (tail) { pieces.push({ ...item, text: tail }); }
	clone.splice(index, 1, ...pieces);
	return clone;
}

export interface InsertResult {
	blocks: unknown[];
	/**
	 * - `inserted`    the citation was written
	 * - `duplicate`   it was already in the group at that spot, so nothing to do
	 * - `unsupported` the target block cannot hold a citation (a table cell, a code
	 *   block, or an id that no longer exists). Callers must NOT treat this as
	 *   done: dropping it here is how a citation disappears without a trace.
	 */
	outcome: 'inserted' | 'duplicate' | 'unsupported';
}

/**
 * Put `citekey` into the block `blockId` at `offset` in its prose. Returns a new
 * block tree; the input is not mutated, so a staged proposal and the saved note
 * never share structure.
 */
export function insertCitation(blocks: unknown[], blockId: string, offset: number, citekey: string): InsertResult {
	let outcome: InsertResult['outcome'] = 'unsupported';
	const rewrite = (list: unknown[]): unknown[] => list.map(raw => {
		const block = raw as BlockLike;
		if (!block || typeof block !== 'object') { return raw; }
		let next: BlockLike = block;
		if (block.id === blockId && !isCodeBlock(block)) {
			const inline = inlineArrayOf(block);
			if (inline) {
				const { text, runs } = flattenInline(inline);
				const plan = planInsertion(text, offset, citekey);
				if (!plan) {
					outcome = 'duplicate';
				} else {
					// The run containing the split point. `at` can sit exactly on a run
					// boundary, where both the run ending there and the one starting
					// there qualify; taking the FIRST match appends to the run that ends
					// there, keeping the citation attached to the text it follows.
					const run = runs.find(r => plan.at >= r.start && plan.at <= r.start + r.length)
						?? runs[runs.length - 1];
					if (run) {
						next = { ...block, content: spliceRun(inline, run.path, plan.at - run.start, plan.insert) };
						outcome = 'inserted';
					}
				}
			}
		}
		if (Array.isArray(next.children) && next.children.length) {
			next = { ...next, children: rewrite(next.children) };
		}
		return next;
	});
	return { blocks: rewrite(blocks), outcome };
}
