/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// BlockNote-based note editor that runs INSIDE a VS Code webview.
// Built by build.mjs (esbuild) into
//   ../src/vs/workbench/contrib/ariaNotes/browser/media/notesEditor.{js,css}
// and loaded by AriaNoteEditorPane.

import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { BlockNoteView } from '@blocknote/mantine';
import { SuggestionMenuController, getDefaultReactSlashMenuItems, useCreateBlockNote } from '@blocknote/react';
import type { DefaultReactSuggestionItem } from '@blocknote/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { blockProse, citationAtOffset, formatReference, keyAtOffset, occurrencesOf, planInsertion, referenceList, walkBlocks } from './citations';
import type { CitablePaper, CitationEntry } from './citations';
import { positionFromPoint, positionFromSelection, rangeForProse } from './domPosition';

type Decorations = Record<string, 'add' | 'del'>;

/** A citation the user has been asked to position by clicking in the preview. */
interface Placement {
	/** Question handle - the same paper can be queued twice, so not the citekey. */
	id: string;
	citekey: string;
	title: string;
	anchor: string;
}

declare function acquireVsCodeApi(): {
	postMessage(msg: unknown): void;
	getState(): unknown;
	setState(s: unknown): void;
};
const vscode = acquireVsCodeApi();

/** Transient stand-in for a citation while the paper picker is open. Visible on
 *  purpose (an invisible marker that survived a crash would be undebuggable) and
 *  never written to disk: saving is suspended while a pick is in flight. */
const CITE_MARKER_PREFIX = '{{cite:';
let pickSeq = 0;

/** Reference-list sizing. The list is resizable by dragging its top edge; the
 *  chosen height is remembered per webview via `setState`. */
const REFERENCES_MIN_HEIGHT = 56;
const REFERENCES_DEFAULT_HEIGHT = 150;

/**
 * The one highlight colour, used for every "this is the citation I mean" cue:
 * the marker under the pointer, the reference row your caret is standing on, and
 * the markers of a reference you selected. A neutral grey rather than a colour,
 * because these are pointers into the user's own text, not warnings - and using
 * a single tone keeps the two directions (text -> list, list -> text) legible as
 * the same idea.
 */
function highlightBg(theme: 'light' | 'dark'): string {
	return theme === 'light' ? 'rgba(0,0,0,0.075)' : 'rgba(255,255,255,0.10)';
}

function detectTheme(): 'light' | 'dark' {
	const c = document.body.classList;
	return (c.contains('vscode-light') || c.contains('vscode-high-contrast-light')) ? 'light' : 'dark';
}

/** Follow the VS Code theme — webviews get a `vscode-light` / `vscode-dark` body
 *  class. Easy mode forces the Light Modern theme, so the editor renders light
 *  there instead of the previously hard-coded dark. Re-reads if the theme (or the
 *  easy/advanced mode) changes at runtime. */
function useVsCodeTheme(): 'light' | 'dark' {
	const [theme, setTheme] = useState<'light' | 'dark'>(detectTheme);
	useEffect(() => {
		const observer = new MutationObserver(() => setTheme(detectTheme()));
		observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
		return () => observer.disconnect();
	}, []);
	return theme;
}

// --- inline-content helpers -------------------------------------------------

interface StyledItem {
	type?: string;
	text?: string;
	styles?: Record<string, unknown>;
	content?: unknown;
}

/**
 * Blocks a citation can actually be spliced into: ordinary prose, i.e. a block
 * whose content is a plain inline array. Table cells and code blocks are read for
 * the reference list but cannot receive a citation, and the same rule lives in
 * the extension's `insertCitation`.
 */
function insertableBlockIds(blocks: unknown[]): Set<string> {
	const ids = new Set<string>();
	walkBlocks(blocks, block => {
		if (typeof block.id === 'string' && block.type !== 'codeBlock' && Array.isArray(block.content)) {
			ids.add(block.id);
		}
	});
	return ids;
}

/** Prose contributed by one inline item (its own text, or a link's children). */
function itemProse(item: StyledItem): string {
	if (item.styles && item.styles.code) { return ''; }
	if (typeof item.text === 'string') { return item.text; }
	if (Array.isArray(item.content)) {
		return (item.content as StyledItem[]).map(child => itemProse(child ?? {})).join('');
	}
	return '';
}

/**
 * Swap the placeholder for the real citation, applying the placement rules
 * (leading space, merge into an adjacent group). Returns the new inline content,
 * or undefined when this content does not hold the marker.
 */
function replaceMarker(content: unknown[], marker: string, citekey: string): unknown[] | undefined {
	let before = '';
	for (let i = 0; i < content.length; i++) {
		const item = content[i] as StyledItem;
		if (!item || typeof item !== 'object') { continue; }
		if (item.type === 'text' && typeof item.text === 'string' && !(item.styles && item.styles.code)) {
			const at = item.text.indexOf(marker);
			if (at < 0) { before += item.text; continue; }
			const globalAt = before.length + at;
			const plan = planInsertion(before + item.text, globalAt, citekey);
			let next: string;
			if (!plan) {
				next = item.text.replace(marker, '');                      // already cited here
			} else if (plan.at === globalAt) {
				next = item.text.replace(marker, plan.insert);
			} else if (at >= 1) {
				// Merge: `…]` immediately before the marker becomes `…; @key]`.
				next = item.text.slice(0, at - 1) + plan.insert + ']' + item.text.slice(at + marker.length);
			} else {
				// The `]` lives in a previous run (only possible with mid-citation
				// styling). Fall back to a separate bracket rather than guess.
				next = item.text.replace(marker, `[@${citekey}]`);
			}
			const copy = [...content];
			copy[i] = { ...item, text: next };
			return copy;
		}
		if (Array.isArray(item.content)) {
			const nested = replaceMarker(item.content as unknown[], marker, citekey);
			if (nested) {
				const copy = [...content];
				copy[i] = { ...item, content: nested };
				return copy;
			}
		}
		before += itemProse(item);
	}
	return undefined;
}

/** Remove the placeholder without inserting anything (the pick was cancelled). */
function stripMarker(content: unknown[], marker: string): unknown[] | undefined {
	for (let i = 0; i < content.length; i++) {
		const item = content[i] as StyledItem;
		if (!item || typeof item !== 'object') { continue; }
		if (typeof item.text === 'string' && item.text.includes(marker)) {
			const copy = [...content];
			copy[i] = { ...item, text: item.text.replace(marker, '') };
			return copy;
		}
		if (Array.isArray(item.content)) {
			const nested = stripMarker(item.content as unknown[], marker);
			if (nested) {
				const copy = [...content];
				copy[i] = { ...item, content: nested };
				return copy;
			}
		}
	}
	return undefined;
}

// --- reference list ---------------------------------------------------------

function ReferenceList({ entries, activeKey, selectedKey, onSelect, theme, height }: {
	entries: CitationEntry[];
	/** Where the caret is standing, followed passively. */
	activeKey?: string;
	/** What the user clicked, which points back into the text. */
	selectedKey?: string;
	onSelect: (citekey: string) => void;
	theme: 'light' | 'dark';
	height: number;
}) {
	if (entries.length === 0) { return null; }
	const activeBg = highlightBg(theme);
	const chipBg = theme === 'light' ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.10)';
	return (
		<div
			style={{
				flex: '0 0 auto', height: `${height}px`, overflowY: 'auto',
				padding: '4px 54px 16px 54px',
				fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)', fontSize: '12px',
				color: 'var(--vscode-foreground)',
			}}
		>
			<div style={{ fontSize: '11px', fontWeight: 600, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '6px' }}>
				References
			</div>
			{entries.map(entry => (
				<div
					key={entry.citekey}
					data-citekey={entry.citekey}
					// Clicking a reference points back at where it is used in the note.
					// Clicking it again clears, so the highlight is never stuck on.
					onClick={() => onSelect(entry.citekey)}
					title="Show where this is cited in the note"
					style={{
						display: 'flex', gap: '8px', alignItems: 'baseline', padding: '3px 6px', cursor: 'pointer',
						borderRadius: '4px',
						background: (entry.citekey === selectedKey || entry.citekey === activeKey) ? activeBg : 'transparent',
					}}
				>
					<span style={{ opacity: 0.6, minWidth: '22px' }}>[{entry.number}]</span>
					{/* The citekey is spelled out so the marker in the text and its entry
					    can be matched by eye, with no interaction at all. */}
					<span style={{ opacity: 0.75, minWidth: '78px', fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>
						{entry.citekey}
					</span>
					<span style={{ flex: 1, lineHeight: 1.5 }}>{formatReference(entry.paper)}</span>
					{/* Repeat count as a right-aligned chip rather than trailing text: it
					    stays out of the reference sentence, and since every row's chip
					    lands in the same column they can be scanned straight down. A
					    paper cited once shows nothing, so most rows stay clean. */}
					{entry.occurrences > 1 ? (
						<span
							title={`Cited ${entry.occurrences} times in this note`}
							style={{
								flexShrink: 0, fontSize: '10px', lineHeight: 1.4, padding: '1px 6px',
								borderRadius: '9px', background: chipBg, opacity: 0.8,
								fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
							}}
						>
							{`×${entry.occurrences}`}
						</span>
					) : null}
				</div>
			))}
		</div>
	);
}

/** Drag handle between the note and its reference list. Mirrors the Project
 *  Overview's divider: an overlay covers the pane during the drag so text
 *  selection inside the editor cannot hijack the pointer stream. */
function ResizeDivider({ height, onChange, containerRef }: {
	height: number;
	onChange: (next: number) => void;
	containerRef: { current: HTMLDivElement | null };
}) {
	const onMouseDown = (e: ReactMouseEvent) => {
		e.preventDefault();
		const startY = e.clientY;
		const startHeight = height;
		const total = containerRef.current?.getBoundingClientRect().height ?? window.innerHeight;
		const overlay = document.createElement('div');
		Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '60', cursor: 'row-resize' });
		document.body.appendChild(overlay);
		const onMove = (ev: MouseEvent) => {
			// Drag up = taller list. Always leave room for the note itself.
			const max = Math.max(REFERENCES_MIN_HEIGHT, total - 160);
			onChange(Math.min(Math.max(REFERENCES_MIN_HEIGHT, startHeight + (startY - ev.clientY)), max));
		};
		const onUp = () => {
			document.removeEventListener('mousemove', onMove, true);
			document.removeEventListener('mouseup', onUp, true);
			overlay.remove();
		};
		document.addEventListener('mousemove', onMove, true);
		document.addEventListener('mouseup', onUp, true);
	};
	return (
		<div
			onMouseDown={onMouseDown}
			title="Drag to resize the reference list"
			style={{
				flex: '0 0 auto', height: '9px', cursor: 'row-resize', position: 'relative',
				borderTop: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.3))',
			}}
		>
			<div
				style={{
					position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
					width: '40px', height: '3px', borderRadius: '2px', background: 'rgba(127,127,127,0.45)',
				}}
			/>
		</div>
	);
}

/** One painted rectangle over a `[@key]` marker. Overlaid rather than styled into
 *  the document, so nothing about the note changes and it works read-only. */
function MarkerHighlight({ rect, theme, z }: { rect: DOMRect; theme: 'light' | 'dark'; z: number }) {
	return (
		<div
			style={{
				position: 'fixed', left: rect.left - 1, top: rect.top - 1,
				width: rect.width + 2, height: rect.height + 2,
				background: highlightBg(theme), borderRadius: '3px',
				pointerEvents: 'none', zIndex: z,
			}}
		/>
	);
}

// --- hover card -------------------------------------------------------------

function HoverCard({ paper, x, y }: { paper: CitablePaper; x: number; y: number }) {
	const authors = paper.authors?.length
		? (paper.authors.length > 3 ? `${paper.authors.slice(0, 3).join(', ')} et al.` : paper.authors.join(', '))
		: 'Unknown author';
	return (
		<div
			style={{
				position: 'fixed', left: Math.min(x, window.innerWidth - 340), top: y + 18,
				maxWidth: '320px', zIndex: 40, pointerEvents: 'none',
				background: 'var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background))',
				color: 'var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground))',
				border: '1px solid var(--vscode-editorHoverWidget-border, rgba(127,127,127,0.35))',
				borderRadius: '6px', padding: '8px 10px', boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
				fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)', fontSize: '12px', lineHeight: 1.45,
			}}
		>
			<div style={{ fontWeight: 600, marginBottom: '3px' }}>{paper.title}</div>
			<div style={{ opacity: 0.8 }}>{authors}{paper.year ? ` · ${paper.year}` : ''}</div>
		</div>
	);
}

// --- editor -----------------------------------------------------------------

function Editor({ blocks, editable, decorations, papers, placement, panelHeight, onPanelHeightChange }: {
	blocks: unknown[];
	editable: boolean;
	decorations?: Decorations;
	papers: Map<string, CitablePaper>;
	placement?: Placement;
	panelHeight: number;
	onPanelHeightChange: (next: number) => void;
}) {
	const editor = useCreateBlockNote({
		initialContent: blocks && blocks.length ? (blocks as never) : undefined,
	});
	const ref = useRef<HTMLDivElement>(null);
	const outerRef = useRef<HTMLDivElement>(null);
	const theme = useVsCodeTheme();
	// Bumped on every document change so the reference list recomputes from the
	// live document rather than the initial content.
	const [docVersion, setDocVersion] = useState(0);
	const [hover, setHover] = useState<{ citekey: string; blockId: string; start: number; end: number; x: number; y: number } | undefined>(undefined);
	// Client rects of the hovered `[@key]`, painted so it is obvious WHICH marker
	// the card is describing (several can sit in one sentence).
	const [hoverRects, setHoverRects] = useState<DOMRect[]>([]);
	const [activeKey, setActiveKey] = useState<string | undefined>(undefined);
	// A reference the user clicked: its markers in the text are painted so they can
	// see where the paper is actually used. Independent of `activeKey`, which just
	// follows the caret.
	const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
	const [selectedRects, setSelectedRects] = useState<DOMRect[]>([]);
	// While the paper picker is open the document holds a placeholder; suspending
	// saves keeps that placeholder from ever reaching disk.
	const pendingPick = useRef<string | undefined>(undefined);

	// Tint changed blocks by data-id (set by the pane). Done in the DOM rather
	// than via BlockNote props so it works for ALL block types — tables, images,
	// etc. don't support a backgroundColor prop. Retries across frames until the
	// blocks have rendered.
	useEffect(() => {
		const root = ref.current;
		if (!root || !decorations) {
			return;
		}
		const entries = Object.entries(decorations);
		if (!entries.length) {
			return;
		}
		let raf = 0;
		let tries = 0;
		const apply = () => {
			let applied = 0;
			for (const [id, kind] of entries) {
				const el = root.querySelector(`[data-id="${id}"]`);
				if (el) {
					el.classList.add(kind === 'del' ? 'aria-review-del' : 'aria-review-add');
					applied++;
				}
			}
			if (applied < entries.length && tries++ < 30) {
				raf = requestAnimationFrame(apply);
			}
		};
		raf = requestAnimationFrame(apply);
		return () => cancelAnimationFrame(raf);
	}, [decorations]);

	/** Prose of every block, keyed by id - the string offsets from the DOM index into. */
	const proseByBlock = useMemo(() => {
		const map = new Map<string, string>();
		walkBlocks(editor.document as unknown[], block => {
			if (typeof block.id === 'string') { map.set(block.id, blockProse(block)); }
		});
		return map;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor, docVersion]);

	const references = useMemo(
		() => referenceList(editor.document as unknown[], papers),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[editor, docVersion, papers],
	);

	// Hover card. Read-only inspection, so it never touches the document and
	// works the same in review mode.
	const onMouseMove = useCallback((e: ReactMouseEvent) => {
		if (placement) { return; }                       // placing takes over the pointer
		const position = positionFromPoint(e.clientX, e.clientY);
		const prose = position && proseByBlock.get(position.blockId);
		const span = (position && prose !== undefined)
			? citationAtOffset(prose, position.offset, papers)
			: undefined;
		setHover(span && position
			? { citekey: span.citekey, blockId: position.blockId, start: span.start, end: span.end, x: e.clientX, y: e.clientY }
			: undefined);
	}, [proseByBlock, papers, placement]);

	// Measure the hovered marker. Keyed on the SPAN, not the pointer, so moving
	// the mouse within one citation does not re-measure on every frame.
	const hoverBlockId = hover?.blockId;
	const hoverStart = hover?.start;
	const hoverEnd = hover?.end;
	useEffect(() => {
		if (hoverBlockId === undefined || hoverStart === undefined || hoverEnd === undefined) {
			setHoverRects([]);
			return;
		}
		const range = rangeForProse(hoverBlockId, hoverStart, hoverEnd);
		setHoverRects(range ? Array.from(range.getClientRects()) : []);
	}, [hoverBlockId, hoverStart, hoverEnd]);

	/** Re-measure the selected reference's markers. Called on select, on scroll and
	 *  on edits, since all three move the text under the overlay. */
	const measureSelected = useCallback(() => {
		if (!selectedKey) { setSelectedRects([]); return; }
		const rects: DOMRect[] = [];
		for (const occurrence of occurrencesOf(editor.document as unknown[], selectedKey, papers)) {
			const range = rangeForProse(occurrence.blockId, occurrence.start, occurrence.end);
			if (range) { rects.push(...Array.from(range.getClientRects())); }
		}
		setSelectedRects(rects);
	}, [selectedKey, editor, papers]);

	useEffect(() => { measureSelected(); }, [measureSelected, docVersion]);

	/** Select a reference (or clear it by clicking the same one again) and bring
	 *  its first use into view - a highlight below the fold helps nobody. */
	const onSelectReference = useCallback((citekey: string) => {
		if (citekey === selectedKey) { setSelectedKey(undefined); return; }
		setSelectedKey(citekey);
		const first = occurrencesOf(editor.document as unknown[], citekey, papers)[0];
		if (!first) { return; }
		const blockEl = document.querySelector(`[data-id="${CSS.escape(first.blockId)}"]`);
		blockEl?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}, [selectedKey, editor, papers]);

	// Caret-follow: standing on (or next to) a citation highlights its entry in
	// the reference list, with no clicking.
	useEffect(() => {
		const onSelectionChange = () => {
			const position = positionFromSelection();
			if (!position) { setActiveKey(undefined); return; }
			const prose = proseByBlock.get(position.blockId);
			if (prose === undefined) { setActiveKey(undefined); return; }
			// Check the caret and the character just before it, so sitting at either
			// edge of `[@lu2026]` counts as being on it.
			setActiveKey(keyAtOffset(prose, position.offset, papers) ?? keyAtOffset(prose, Math.max(0, position.offset - 1), papers));
		};
		document.addEventListener('selectionchange', onSelectionChange);
		return () => document.removeEventListener('selectionchange', onSelectionChange);
	}, [proseByBlock, papers]);

	// Clicking in the note either answers a placement question or, normally, just
	// dismisses the reference selection so its highlight is not left stuck on.
	const onClickPlace = useCallback((e: ReactMouseEvent) => {
		if (!placement) { setSelectedKey(undefined); return; }
		const position = positionFromPoint(e.clientX, e.clientY);
		if (!position) { return; }
		// Only ordinary prose can hold a citation. Refusing the click here (rather
		// than letting it round-trip and fail) keeps the question open and the
		// crosshair up, so the user simply tries somewhere else.
		if (!insertableBlockIds(editor.document as unknown[]).has(position.blockId)) { return; }
		e.preventDefault();
		vscode.postMessage({
			type: 'cite:locationPicked',
			id: placement.id,
			blockId: position.blockId,
			offset: position.offset,
		});
	}, [placement, editor]);

	// --- /cite -------------------------------------------------------------

	const startPick = useCallback(() => {
		const token = `p${++pickSeq}`;
		const marker = `${CITE_MARKER_PREFIX}${token}}}`;
		pendingPick.current = marker;
		editor.insertInlineContent([{ type: 'text', text: marker, styles: {} }] as never);
		vscode.postMessage({ type: 'cite:pick', token });
	}, [editor]);

	/** Swap the placeholder for the citation, or strip it when the pick was cancelled. */
	const finishPick = useCallback((citekey: string | undefined) => {
		const marker = pendingPick.current;
		pendingPick.current = undefined;
		if (!marker) { return; }
		let done = false;
		const visit = (list: unknown[]): void => {
			for (const raw of list) {
				if (done) { return; }
				const block = raw as { id?: string; content?: unknown; children?: unknown };
				if (Array.isArray(block.content) && typeof block.id === 'string') {
					const next = citekey
						? replaceMarker(block.content, marker, citekey)
						: stripMarker(block.content, marker);
					if (next) {
						editor.updateBlock(block.id, { content: next as never });
						done = true;
						return;
					}
				}
				if (Array.isArray(block.children)) { visit(block.children); }
			}
		};
		visit(editor.document as unknown[]);
		// Saving was suspended while the picker was open; push the result now.
		if (editable) { vscode.postMessage({ type: 'save', blocks: editor.document }); }
		setDocVersion(v => v + 1);
	}, [editor, editable]);

	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			const m = e.data;
			if (!m) { return; }
			if (m.type === 'cite:insert' && typeof m.citekey === 'string') { finishPick(m.citekey); }
			if (m.type === 'cite:cancel') { finishPick(undefined); }
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [finishPick]);

	// The default slash menu plus "Cite a paper". Filtering is done here rather
	// than with BlockNote's helper so the menu behaves the same for both.
	const slashItems = useCallback(async (query: string): Promise<DefaultReactSuggestionItem[]> => {
		const citeItem: DefaultReactSuggestionItem = {
			title: 'Cite a paper',
			subtext: 'Insert a citation from your Paper Library',
			aliases: ['cite', 'citation', 'reference', 'bib'],
			group: 'Research',
			onItemClick: startPick,
		};
		const all: DefaultReactSuggestionItem[] = [...getDefaultReactSlashMenuItems(editor), citeItem];
		const q = query.trim().toLowerCase();
		if (!q) { return all; }
		return all.filter(item => {
			const title = item.title.toLowerCase();
			const aliases = (item.aliases ?? []).map(a => a.toLowerCase());
			return title.includes(q) || aliases.some(a => a.includes(q));
		});
	}, [editor, startPick]);

	const hoveredPaper = hover ? papers.get(hover.citekey) : undefined;

	return (
		<div ref={outerRef} style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
			{placement ? (
				<div
					style={{
						flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 14px',
						background: 'rgba(255,193,7,0.18)', borderBottom: '1px solid var(--vscode-editorWarning-foreground, #cca700)',
						fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)', fontSize: '12.5px',
						color: 'var(--vscode-foreground)',
					}}
				>
					<span style={{ flex: 1 }}>
						{`Click where [@${placement.citekey}] should go: ${placement.title}`}
						{placement.anchor ? <span style={{ opacity: 0.7 }}>{`  (the AI aimed for "${placement.anchor}")`}</span> : null}
					</span>
					<button
						onClick={() => vscode.postMessage({ type: 'cite:locationSkipped', id: placement.id })}
						style={{
							padding: '3px 10px', fontSize: '12px', borderRadius: '4px', cursor: 'pointer',
							background: 'transparent', color: 'var(--vscode-foreground)',
							border: '1px solid rgba(127,127,127,0.4)', fontFamily: 'inherit',
						}}
					>
						Skip
					</button>
				</div>
			) : null}
			<div
				ref={ref}
				style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', cursor: placement ? 'crosshair' : undefined }}
				onMouseMove={onMouseMove}
				onMouseLeave={() => setHover(undefined)}
				// Measured rects are viewport-relative. The transient hover highlight is
				// simply dropped on scroll; the selected reference's highlight is meant
				// to persist while you look for it, so it is re-measured instead.
				onScroll={() => { setHover(undefined); measureSelected(); }}
				onClickCapture={onClickPlace}
			>
				<BlockNoteView
					editor={editor}
					theme={theme}
					editable={editable}
					slashMenu={false}
					onChange={() => {
						setDocVersion(v => v + 1);
						// Read-only preview (a proposal) must never write back, and a
						// placeholder mid-pick must never be persisted.
						if (editable && !pendingPick.current) {
							vscode.postMessage({ type: 'save', blocks: editor.document });
						}
					}}
				>
					<SuggestionMenuController triggerCharacter="/" getItems={slashItems} />
				</BlockNoteView>
			</div>
			{references.length ? (
				<ResizeDivider height={panelHeight} onChange={onPanelHeightChange} containerRef={outerRef} />
			) : null}
			<ReferenceList
				entries={references}
				activeKey={activeKey}
				selectedKey={selectedKey}
				onSelect={onSelectReference}
				theme={theme}
				height={panelHeight}
			/>
			{/* Markers of the reference selected in the list. Painted under the hover
			    highlight so pointing at one of them still reads normally. */}
			{selectedRects.map((rect, i) => (
				<MarkerHighlight key={`sel-${i}`} rect={rect} theme={theme} z={38} />
			))}
			{hoveredPaper && hover ? (
				<>
					{hoverRects.map((rect, i) => (
						<MarkerHighlight key={`hov-${i}`} rect={rect} theme={theme} z={39} />
					))}
					<HoverCard paper={hoveredPaper} x={hover.x} y={hover.y} />
				</>
			) : null}
		</div>
	);
}

function App() {
	// `rev` bumps on every load so the editor remounts with fresh content
	// (used when switching between the saved note and a proposal preview).
	const [state, setState] = useState<{ blocks: unknown[]; editable: boolean; decorations?: Decorations; rev: number } | null>(null);
	const [papers, setPapers] = useState<Map<string, CitablePaper>>(new Map());
	const [placement, setPlacement] = useState<Placement | undefined>(undefined);
	// Lives here, not in Editor: Editor remounts on every load (a proposal, an
	// answered citation question), which would snap the list back to its default.
	const [panelHeight, setPanelHeight] = useState<number>(() => {
		const saved = (vscode.getState() as { referencesHeight?: unknown } | undefined)?.referencesHeight;
		return typeof saved === 'number' && saved >= REFERENCES_MIN_HEIGHT ? saved : REFERENCES_DEFAULT_HEIGHT;
	});
	const onPanelHeightChange = useCallback((next: number) => {
		setPanelHeight(next);
		const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
		vscode.setState({ ...prev, referencesHeight: next });
	}, []);
	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			const m = e.data;
			if (!m) { return; }
			if (m.type === 'load') {
				setState(prev => ({
					blocks: Array.isArray(m.blocks) ? m.blocks : [],
					editable: m.editable !== false,
					decorations: m.decorations && typeof m.decorations === 'object' ? m.decorations : undefined,
					rev: (prev?.rev ?? 0) + 1,
				}));
				// A fresh document means the previous placement question was answered
				// (the extension re-publishes after every answer).
				setPlacement(undefined);
			} else if (m.type === 'papers:list' && Array.isArray(m.papers)) {
				const next = new Map<string, CitablePaper>();
				for (const raw of m.papers as CitablePaper[]) {
					if (raw && typeof raw.citekey === 'string' && raw.citekey) { next.set(raw.citekey, raw); }
				}
				setPapers(next);
			} else if (m.type === 'cite:askLocation' && typeof m.id === 'string') {
				setPlacement({
					id: m.id,
					citekey: String(m.citekey ?? ''),
					title: String(m.title ?? ''),
					anchor: String(m.anchor ?? ''),
				});
			}
		};
		window.addEventListener('message', onMessage);
		vscode.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', onMessage);
	}, []);

	if (!state) {
		return <div style={{ padding: 16, opacity: 0.6, fontFamily: 'sans-serif' }}>Loading…</div>;
	}
	return (
		<Editor
			key={state.rev}
			blocks={state.blocks}
			editable={state.editable}
			decorations={state.decorations}
			papers={papers}
			placement={placement}
			panelHeight={panelHeight}
			onPanelHeightChange={onPanelHeightChange}
		/>
	);
}

createRoot(document.getElementById('root')!).render(<App />);
