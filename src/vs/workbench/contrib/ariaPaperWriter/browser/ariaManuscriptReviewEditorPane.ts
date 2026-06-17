/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { applyAriaScrollbar } from '../../aria/browser/ariaScrollbar.js';
import { AriaManuscriptReviewInput } from './ariaManuscriptReviewInput.js';

/** A token: one sentence, or a paragraph separator. */
interface Token { kind: 'sent' | 'sep'; text: string }
/** A diff segment: an unchanged run, or a change (current vs proposed). */
interface Segment { type: 'equal'; tokens: Token[] } interface ChangeSegment { type: 'change'; removed: Token[]; added: Token[]; index: number }
type Seg = Segment | ChangeSegment;

/**
 * Reviews a staged manuscript revision in its own tab. Splits the current
 * (manuscript.md) and proposed (manuscript.proposed.md) manuscripts into
 * sentences, diffs them, and renders each change with a highlighter look —
 * added = yellow, removed = red strikethrough — each with its own Accept /
 * Reject that applies IMMEDIATELY:
 *   Accept → writes the change into manuscript.md (the working copy).
 *   Reject → reverts that change in manuscript.proposed.md.
 * Either way the two files converge on that sentence and it leaves the diff.
 * The pane watches both files, so further proposals (or accepts) refresh live.
 * When no differences remain, the proposal file is deleted automatically.
 */
export class AriaManuscriptReviewEditorPane extends EditorPane {

	static readonly ID = AriaManuscriptReviewInput.EDITOR_ID;

	private root: HTMLElement | undefined;
	private folder: URI | undefined;
	private current = '';
	private proposed = '';
	private segments: Seg[] = [];
	private lastSelfWriteAt = 0;
	private readonly inputStore = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(AriaManuscriptReviewEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const root = document.createElement('div');
		applyAriaScrollbar(root);
		Object.assign(root.style, { width: '100%', height: '100%', overflow: 'auto', padding: '18px 22px', boxSizing: 'border-box', fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)', color: 'var(--vscode-foreground)' });
		parent.appendChild(root);
		this.root = root;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof AriaManuscriptReviewInput)) { return; }
		this.inputStore.clear();
		this.folder = input.folderResource;
		await this.reload();
		if (token.isCancellationRequested) { return; }
		this.render();
		// Live-refresh when Claude stages more edits or our own accept/reject lands.
		this.inputStore.add(this.fileService.onDidFilesChange(e => {
			const folder = this.folder;
			if (!folder || Date.now() - this.lastSelfWriteAt < 400) { return; }
			if (e.affects(folder)) { void this.reload().then(() => this.render()); }
		}));
	}

	private async reload(): Promise<void> {
		const folder = this.folder;
		if (!folder) { return; }
		this.current = await this.readText(joinPath(folder, 'manuscript.md'));
		this.proposed = await this.readText(joinPath(folder, 'manuscript.proposed.md'));
		this.segments = diffTokens(tokenize(this.current), tokenize(this.proposed));
	}

	private async readText(uri: URI): Promise<string> {
		try { return (await this.fileService.readFile(uri)).value.toString(); } catch { return ''; }
	}

	private async writeText(name: string, content: string): Promise<void> {
		const folder = this.folder;
		if (!folder) { return; }
		this.lastSelfWriteAt = Date.now();
		await this.fileService.writeFile(joinPath(folder, name), VSBuffer.fromString(content));
		this.lastSelfWriteAt = Date.now();
	}

	private get paperId(): string { return this.folder ? basename(this.folder) : ''; }
	private changes(): ChangeSegment[] { return this.segments.filter((s): s is ChangeSegment => s.type === 'change'); }

	/** Reassemble the manuscript, choosing for each change either the proposed
	 *  ('added') or the current ('removed') side. */
	private assemble(choose: (changeIndex: number) => 'added' | 'removed'): string {
		const toks: Token[] = [];
		for (const s of this.segments) {
			if (s.type === 'equal') { toks.push(...s.tokens); }
			else { toks.push(...(choose(s.index) === 'added' ? s.added : s.removed)); }
		}
		return tokensToText(toks) + '\n';
	}

	private async acceptChange(i: number): Promise<void> {
		// Apply ONLY this change to the working copy; others stay current.
		await this.writeText('manuscript.md', this.assemble(k => (k === i ? 'added' : 'removed')));
		await this.reload();
		this.render();
	}

	private async rejectChange(i: number): Promise<void> {
		// Drop ONLY this change from the proposal; others stay proposed.
		await this.writeText('manuscript.proposed.md', this.assemble(k => (k === i ? 'removed' : 'added')));
		await this.reload();
		this.render();
	}

	private async acceptAll(): Promise<void> {
		await this.writeText('manuscript.md', this.proposed.trimEnd() + '\n');
		await this.clearProposal();
		await this.reload();
		this.render();
	}

	private async rejectAll(): Promise<void> {
		await this.clearProposal();
		await this.reload();
		this.render();
	}

	private async clearProposal(): Promise<void> {
		const folder = this.folder;
		if (!folder) { return; }
		this.lastSelfWriteAt = Date.now();
		try { await this.fileService.del(joinPath(folder, 'manuscript.proposed.md')); } catch { /* already gone */ }
		this.lastSelfWriteAt = Date.now();
	}

	// --- Rendering ----------------------------------------------------------

	private render(): void {
		const root = this.root;
		if (!root) { return; }
		clearNode(root);

		// No proposal staged (e.g. just accepted/rejected all, or it was deleted)
		// — show the done panel. Without this guard, diffing against an empty
		// proposed file reads as "the whole manuscript was removed".
		if (!this.proposed.trim()) {
			this.renderDone(root);
			return;
		}

		const changes = this.changes();
		if (changes.length === 0) {
			// Proposal identical to the working copy — nothing to review.
			void this.clearProposal();
			this.renderDone(root);
			return;
		}

		const h = append(root, $('div'));
		h.textContent = localize('aria.manuscriptReview.title', "Review proposed revision");
		Object.assign(h.style, { fontSize: '15px', fontWeight: '700', marginBottom: '4px' });
		const sub = append(root, $('div'));
		sub.textContent = localize('aria.manuscriptReview.subtitle', "{0} change(s). Yellow = added, red = removed. Accept or reject each — it applies immediately.", changes.length);
		Object.assign(sub.style, { fontSize: '12px', opacity: '0.7', marginBottom: '12px' });

		const bulk = append(root, $('div'));
		Object.assign(bulk.style, { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' });
		bulk.appendChild(this.button(localize('aria.manuscriptReview.acceptAll', "Accept all"), 'ghost', () => void this.acceptAll()));
		bulk.appendChild(this.button(localize('aria.manuscriptReview.rejectAll', "Reject all"), 'ghost', () => void this.rejectAll()));

		const body = append(root, $('div'));
		Object.assign(body.style, { fontSize: '13px', lineHeight: '1.6' });
		for (const s of this.segments) {
			if (s.type === 'equal') { this.renderContext(body, tokensToText(s.tokens)); }
			else { this.renderChange(body, s); }
		}
	}

	private renderDone(root: HTMLElement): void {
		const h = append(root, $('div'));
		h.textContent = localize('aria.manuscriptReview.doneTitle', "✓ All changes resolved");
		Object.assign(h.style, { fontSize: '15px', fontWeight: '700', marginBottom: '4px' });
		const sub = append(root, $('div'));
		sub.textContent = localize('aria.manuscriptReview.doneSub', "The manuscript (paper/{0}/manuscript.md) reflects every accepted edit. Re-export to refresh the output files.", this.paperId);
		Object.assign(sub.style, { fontSize: '12px', opacity: '0.7', marginBottom: '14px', lineHeight: '1.5' });

		const exp = append(root, $('div'));
		Object.assign(exp.style, { display: 'flex', flexWrap: 'wrap', gap: '8px' });
		exp.appendChild(this.button('Export MD', 'ghost', () => void this.export('markdown')));
		exp.appendChild(this.button('Export DOCX', 'ghost', () => void this.export('docx')));
		exp.appendChild(this.button('Export LaTeX', 'ghost', () => void this.export('latex')));
		exp.appendChild(this.button(localize('aria.manuscriptReview.close', "Close"), 'ghost', () => this.group.closeEditor(this.input ?? undefined)));
	}

	private renderContext(parent: HTMLElement, text: string): void {
		if (!text.trim()) { return; }
		const el = append(parent, $('div'));
		Object.assign(el.style, { whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: '0.6', margin: '4px 0' });
		el.textContent = text;
	}

	private renderChange(parent: HTMLElement, seg: ChangeSegment): void {
		const wrap = append(parent, $('div'));
		Object.assign(wrap.style, { border: '1px solid rgba(127,127,127,0.3)', borderRadius: '6px', padding: '8px 10px', margin: '8px 0' });

		const removed = tokensToText(seg.removed);
		const added = tokensToText(seg.added);
		if (removed.trim()) { this.renderBlock(wrap, removed, 'removed'); }
		if (added.trim()) { this.renderBlock(wrap, added, 'added'); }

		const actions = append(wrap, $('div'));
		Object.assign(actions.style, { display: 'flex', gap: '6px', marginTop: '6px' });
		actions.appendChild(this.button(localize('aria.manuscriptReview.accept', "Accept"), 'primary', () => void this.acceptChange(seg.index)));
		actions.appendChild(this.button(localize('aria.manuscriptReview.reject', "Reject"), 'ghost', () => void this.rejectChange(seg.index)));
	}

	private renderBlock(parent: HTMLElement, text: string, kind: 'added' | 'removed'): void {
		const el = append(parent, $('div'));
		const isHeading = /^#{1,6}\s/.test(text.trim());
		Object.assign(el.style, { whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '3px 6px', borderRadius: '3px', margin: '3px 0', fontWeight: isHeading ? '700' : '400' });
		if (kind === 'added') {
			el.style.background = 'rgba(240, 200, 0, 0.28)';
		} else {
			el.style.background = 'rgba(230, 70, 70, 0.22)';
			el.style.textDecoration = 'line-through';
			el.style.opacity = '0.8';
		}
		el.textContent = text;
	}

	private async export(format: 'markdown' | 'docx' | 'latex'): Promise<void> {
		try {
			const res = await this.commandService.executeCommand<string>('aria.paper.export', this.paperId, format);
			this.notificationService.info(res ?? localize('aria.manuscriptReview.exported', "Exported {0}.", format));
		} catch (e) {
			this.notificationService.error(localize('aria.manuscriptReview.exportFailed', "Export failed: {0}", (e as Error).message));
		}
	}

	private button(text: string, variant: 'primary' | 'ghost', onclick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.textContent = text;
		Object.assign(btn.style, { padding: '5px 13px', fontSize: '12.5px', borderRadius: '4px', cursor: 'pointer' });
		if (variant === 'primary') {
			Object.assign(btn.style, { background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: '1px solid transparent' });
		} else {
			Object.assign(btn.style, { background: 'transparent', color: 'var(--vscode-foreground)', border: '1px solid rgba(127,127,127,0.4)' });
		}
		btn.onclick = onclick;
		return btn;
	}

	override clearInput(): void {
		this.inputStore.clear();
		this.folder = undefined;
		super.clearInput();
	}

	override layout(_dimension: Dimension): void { /* scrollable block */ }
}

// --- Sentence-level diff ----------------------------------------------------

const ABBREVIATIONS = ['et al', 'e.g', 'i.e', 'cf', 'vs', 'Fig', 'Eq', 'Tab', 'No', 'Dr', 'Prof', 'approx', 'al', 'Ref', 'Sec', 'Eqs', 'Figs'];

/** Split a paragraph into sentences, protecting decimals, citation keys, and
 *  common abbreviations from being treated as sentence boundaries. Heuristic:
 *  ambiguous boundaries fall back to a slightly larger chunk. */
export function splitSentences(text: string): string[] {
	if (!text.trim()) { return []; }
	const marks: string[] = [];
	const stash = (m: string) => { marks.push(m); return ` ${marks.length - 1} `; };
	let s = text;
	s = s.replace(/(\d)\.(\d)/g, m => stash(m));                       // decimals: 0.05
	s = s.replace(/\[@[^\]]+\]/g, m => stash(m));                      // citations: [@key]
	for (const a of ABBREVIATIONS) {                                  // abbreviations: et al.
		s = s.replace(new RegExp(`\\b${a.replace(/\./g, '\\.')}\\.`, 'g'), m => stash(m));
	}
	const restore = (x: string) => x.replace(/ (\d+) /g, (_m, i) => marks[Number(i)]);
	return s.split(/(?<=[.!?。])\s+/).map(r => restore(r).trim()).filter(Boolean);
}

/** Tokenize a manuscript into sentences plus paragraph separators. Structural
 *  blocks (headings, code, tables, lists) are kept whole — not sentence-split. */
export function tokenize(md: string): Token[] {
	const blocks = md.split(/\n{2,}/);
	const tokens: Token[] = [];
	let first = true;
	for (const raw of blocks) {
		const b = raw.trim();
		if (!b) { continue; }
		if (!first) { tokens.push({ kind: 'sep', text: '' }); }
		first = false;
		if (/^(```|\||>|[-*+]\s|\d+\.\s|#{1,6}\s)/.test(b)) {
			tokens.push({ kind: 'sent', text: b });
		} else {
			for (const sentence of splitSentences(b)) { tokens.push({ kind: 'sent', text: sentence }); }
		}
	}
	return tokens;
}

/** Rebuild manuscript text from tokens: sentences join with a space within a
 *  paragraph; separators become blank lines. */
export function tokensToText(tokens: Token[]): string {
	const paras: string[][] = [[]];
	for (const t of tokens) {
		if (t.kind === 'sep') { paras.push([]); }
		else { paras[paras.length - 1].push(t.text); }
	}
	return paras.map(p => p.join(' ').trim()).filter(Boolean).join('\n\n');
}

function tokenEq(a: Token, b: Token): boolean { return a.kind === b.kind && a.text === b.text; }

/** LCS diff over tokens, grouping consecutive changes into single review hunks. */
export function diffTokens(a: Token[], b: Token[]): Seg[] {
	const n = a.length, m = b.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = tokenEq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const segments: Seg[] = [];
	let eqRun: Token[] = [], rem: Token[] = [], add: Token[] = [];
	const flushEq = () => { if (eqRun.length) { segments.push({ type: 'equal', tokens: eqRun }); eqRun = []; } };
	const flushChange = () => { if (rem.length || add.length) { segments.push({ type: 'change', removed: rem, added: add, index: 0 }); rem = []; add = []; } };
	let i = 0, j = 0;
	while (i < n && j < m) {
		if (tokenEq(a[i], b[j])) { flushChange(); eqRun.push(a[i]); i++; j++; }
		else if (dp[i + 1][j] >= dp[i][j + 1]) { flushEq(); rem.push(a[i++]); }
		else { flushEq(); add.push(b[j++]); }
	}
	while (i < n) { flushEq(); rem.push(a[i++]); }
	while (j < m) { flushEq(); add.push(b[j++]); }
	flushEq(); flushChange();
	let ci = 0;
	for (const s of segments) { if (s.type === 'change') { s.index = ci++; } }
	return segments;
}
