/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Mapping a place on screen (a hover, a caret, a click) to a place in the
 * document: `{ blockId, offset }`, where `offset` counts characters in the
 * block's PROSE - the same string `blockProse` builds, with inline code left out.
 *
 * Keeping both sides on one definition of "prose" is what lets a hover know
 * which citation it is over, and a click during citation placement land exactly
 * where the extension will splice.
 *
 * Nothing here mutates the DOM, so all of it works while the editor is read-only
 * (which is exactly when citation placement happens).
 */

export interface BlockPosition {
	blockId: string;
	offset: number;
}

/** BlockNote tags each block element with `data-id`. */
function blockElementOf(node: Node): HTMLElement | undefined {
	const start = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
	const el = start?.closest('[data-id]');
	return el instanceof HTMLElement ? el : undefined;
}

/** Where the block's own text lives, excluding any nested child blocks. */
function contentRootOf(blockEl: HTMLElement): Element {
	return blockEl.querySelector('.bn-block-content') ?? blockEl;
}

/**
 * Characters of prose before `target` within `root`, skipping inline code and
 * anything belonging to a nested block. Returns undefined when the target is not
 * reachable as prose (inside a code run, for instance).
 */
function proseOffset(root: Element, blockEl: HTMLElement, target: Node, targetOffset: number): number | undefined {
	let total = 0;
	let found: number | undefined;
	const visit = (node: Node): boolean => {
		if (node.nodeType === Node.TEXT_NODE) {
			const length = node.nodeValue?.length ?? 0;
			if (node === target) {
				found = total + Math.max(0, Math.min(targetOffset, length));
				return true;
			}
			total += length;
			return false;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) { return false; }
		const el = node as Element;
		if (el.tagName === 'CODE') { return false; }
		if (el !== blockEl && el.hasAttribute('data-id')) { return false; }
		for (const child of Array.from(el.childNodes)) {
			if (visit(child)) { return true; }
		}
		return false;
	};
	visit(root);
	return found;
}

/** Normalize an (element, childIndex) position to a text node where possible. */
function normalize(node: Node, offset: number): { node: Node; offset: number } {
	if (node.nodeType === Node.ELEMENT_NODE) {
		const child = node.childNodes[offset] ?? node.childNodes[node.childNodes.length - 1];
		if (child) { return { node: child, offset: child.nodeType === Node.TEXT_NODE ? (child.nodeValue?.length ?? 0) : 0 }; }
	}
	return { node, offset };
}

function positionOf(node: Node, offset: number): BlockPosition | undefined {
	const normalized = normalize(node, offset);
	const blockEl = blockElementOf(normalized.node);
	const blockId = blockEl?.getAttribute('data-id');
	if (!blockEl || !blockId) { return undefined; }
	const found = proseOffset(contentRootOf(blockEl), blockEl, normalized.node, normalized.offset);
	return found === undefined ? undefined : { blockId, offset: found };
}

/** Document position under the pointer. Used for hover cards and click-to-place. */
export function positionFromPoint(x: number, y: number): BlockPosition | undefined {
	const doc = document as Document & {
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
	};
	if (typeof doc.caretRangeFromPoint === 'function') {
		const range = doc.caretRangeFromPoint(x, y);
		return range ? positionOf(range.startContainer, range.startOffset) : undefined;
	}
	if (typeof doc.caretPositionFromPoint === 'function') {
		const caret = doc.caretPositionFromPoint(x, y);
		return caret ? positionOf(caret.offsetNode, caret.offset) : undefined;
	}
	return undefined;
}

/** Document position of the text caret. Used to highlight the reference row the
 *  user is currently standing on. */
export function positionFromSelection(): BlockPosition | undefined {
	const selection = document.getSelection();
	if (!selection || selection.rangeCount === 0 || !selection.focusNode) { return undefined; }
	return positionOf(selection.focusNode, selection.focusOffset);
}

/** The (text node, offset) that prose offset `target` lands on inside `root`. */
function nodeAtProseOffset(root: Element, blockEl: HTMLElement, target: number): { node: Node; offset: number } | undefined {
	let total = 0;
	let found: { node: Node; offset: number } | undefined;
	const visit = (node: Node): boolean => {
		if (node.nodeType === Node.TEXT_NODE) {
			const length = node.nodeValue?.length ?? 0;
			// `<=` so an offset sitting exactly at a run's end resolves here rather
			// than falling through to the next run.
			if (target <= total + length) {
				found = { node, offset: target - total };
				return true;
			}
			total += length;
			return false;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) { return false; }
		const el = node as Element;
		if (el.tagName === 'CODE') { return false; }
		if (el !== blockEl && el.hasAttribute('data-id')) { return false; }
		for (const child of Array.from(el.childNodes)) {
			if (visit(child)) { return true; }
		}
		return false;
	};
	visit(root);
	return found;
}

/**
 * A DOM Range covering `[start, end)` of a block's prose - the inverse of
 * `positionFromPoint`. Used to paint the citation the pointer is on, by measuring
 * the range's client rects; nothing in the document is touched, so it works while
 * the editor is read-only.
 */
export function rangeForProse(blockId: string, start: number, end: number): Range | undefined {
	const blockEl = document.querySelector(`[data-id="${CSS.escape(blockId)}"]`);
	if (!(blockEl instanceof HTMLElement)) { return undefined; }
	const root = contentRootOf(blockEl);
	const from = nodeAtProseOffset(root, blockEl, start);
	const to = nodeAtProseOffset(root, blockEl, end);
	if (!from || !to) { return undefined; }
	const range = document.createRange();
	try {
		range.setStart(from.node, from.offset);
		range.setEnd(to.node, to.offset);
	} catch {
		return undefined;                                // offsets moved under us
	}
	return range;
}
