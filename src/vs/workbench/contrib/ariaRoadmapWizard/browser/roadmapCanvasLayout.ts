/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure (DOM-free) geometry + tidy-tree layout for the roadmap canvas, shared by
 * the full interactive editor pane and the sidebar's mini thumbnail so both draw
 * the exact same shape.
 */

export const COLUMN_WIDTH = 220;
export const COLUMN_GAP = 40;
export const COLUMN_LEFT_PAD = 60;
export const NODE_VERTICAL_GAP = 24;
export const COLUMN_TOP_PAD = 60;
export const TREE_GAP = NODE_VERTICAL_GAP; // extra gap between separate root trees

// Node cards size to their wrapped, multi-line title.
export const NODE_MIN_HEIGHT = 48;
export const NODE_LINE_HEIGHT = 17;
export const NODE_VPAD = 14;
export const NODE_LABEL_PAD_X = 14;
export const NODE_LABEL_MAX_CHARS = 26;

export interface NodeInput {
	id: string;
	column: number;
	parent: string | null;
	label: string;
	description?: string;
}

export interface LaidOut {
	id: string;
	x: number;
	y: number;
	height: number;
	lines: string[];
	column: number;
	parent: string | null;
	label: string;
	description?: string;
	proposed: boolean;
}

/** X offset of a column. Columns extend arbitrarily deep (Detail and beyond). */
export function columnX(col: number): number {
	return COLUMN_LEFT_PAD + col * (COLUMN_WIDTH + COLUMN_GAP);
}

/** Greedy word-wrap a label to fit the card width; long words are hard-split. */
export function wrapLabel(label: string): string[] {
	const words = label.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) { return ['']; }
	const lines: string[] = [];
	let line = '';
	const pushWordChunked = (word: string) => {
		let w = word;
		while (w.length > NODE_LABEL_MAX_CHARS) {
			if (line) { lines.push(line); line = ''; }
			lines.push(w.slice(0, NODE_LABEL_MAX_CHARS));
			w = w.slice(NODE_LABEL_MAX_CHARS);
		}
		if (w) {
			if (!line) { line = w; }
			else if ((line + ' ' + w).length <= NODE_LABEL_MAX_CHARS) { line += ' ' + w; }
			else { lines.push(line); line = w; }
		}
	};
	for (const word of words) { pushWordChunked(word); }
	if (line) { lines.push(line); }
	return lines;
}

export function nodeHeightForLines(lineCount: number): number {
	return Math.max(NODE_MIN_HEIGHT, NODE_VPAD * 2 + lineCount * NODE_LINE_HEIGHT);
}

/**
 * Tidy bottom-up tree layout: leaves stack vertically in order, and every parent
 * is centered on the vertical span of its children. Committed nodes render above
 * proposed siblings. x is a function of column (depth).
 */
export function computeRoadmapLayout(committed: NodeInput[], proposed: NodeInput[]): LaidOut[] {
	const byId = new Map<string, { committed: boolean; n: NodeInput }>();
	const childrenOf = new Map<string | null, string[]>();
	const pushChild = (parent: string | null, id: string) => {
		const list = childrenOf.get(parent) ?? [];
		list.push(id);
		childrenOf.set(parent, list);
	};
	for (const c of committed) { byId.set(c.id, { committed: true, n: c }); }
	for (const c of committed) { pushChild(c.parent, c.id); }
	for (const p of proposed) { byId.set(p.id, { committed: false, n: p }); }
	for (const p of proposed) { pushChild(p.parent, p.id); }

	const out: LaidOut[] = [];
	let cursorY = COLUMN_TOP_PAD;
	const center = (n: LaidOut) => n.y + n.height / 2;
	const place = (id: string): LaidOut => {
		const entry = byId.get(id)!;
		const kids = childrenOf.get(id) ?? [];
		const lines = wrapLabel(entry.n.label);
		const height = nodeHeightForLines(lines.length);
		let y: number;
		if (kids.length === 0) {
			y = cursorY;
			cursorY += height + NODE_VERTICAL_GAP;
		} else {
			const laidKids = kids.map(k => place(k));
			const midCenter = (center(laidKids[0]) + center(laidKids[laidKids.length - 1])) / 2;
			y = midCenter - height / 2;
		}
		const laid: LaidOut = {
			id,
			x: columnX(entry.n.column),
			y,
			height,
			lines,
			column: entry.n.column,
			parent: entry.n.parent,
			label: entry.n.label,
			description: entry.n.description,
			proposed: !entry.committed,
		};
		out.push(laid);
		return laid;
	};

	for (const rootId of childrenOf.get(null) ?? []) {
		place(rootId);
		cursorY += TREE_GAP;
	}
	return out;
}

/** Bounding box of a laid-out tree (for fitting a thumbnail/viewBox). */
export function layoutBounds(laid: LaidOut[]): { width: number; height: number } {
	const maxX = laid.reduce((m, n) => Math.max(m, n.x + COLUMN_WIDTH), COLUMN_LEFT_PAD + COLUMN_WIDTH);
	const maxY = laid.reduce((m, n) => Math.max(m, n.y + n.height), COLUMN_TOP_PAD);
	return { width: maxX + COLUMN_LEFT_PAD, height: maxY + COLUMN_TOP_PAD };
}
