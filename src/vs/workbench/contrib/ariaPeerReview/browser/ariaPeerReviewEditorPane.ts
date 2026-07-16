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
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { revealAiProviderChat } from '../../aria/browser/aiProviderChat.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { applyAriaScrollbar } from '../../aria/browser/ariaScrollbar.js';
import { AriaPeerReviewInput } from './ariaPeerReviewInput.js';

interface Concern { severity: 'major' | 'minor'; title: string; detail: string }
type PaperFormat = 'markdown' | 'docx' | 'latex';
interface ReviewMeta { execId: string; title: string; reviewers: string[]; paperId?: string; paperFormat?: PaperFormat; draftFile?: string; figureFiles?: string[]; supplementaryFiles?: string[]; createdAt: string; iteration: number }
interface ConcernsFile { iteration: number; reviewers: Record<string, { concerns: Concern[]; recordedAt: string }> }
interface Proposal { original: string; replacement: string; explanation: string }
// New shape carries `proposals` + `documentKey`; older records may be flat - normalize via proposalsOf().
interface Revision { documentKey?: string; proposals?: Proposal[]; recordedAt: string; original?: string; replacement?: string; explanation?: string }
interface PaperItem { id: string; title: string }

const REVIEW_FILTERS = ['md', 'markdown', 'txt', 'docx', 'pdf', 'tex', 'html', 'odt', 'rtf'];
const FORMAT_LABEL: Record<PaperFormat, string> = { markdown: 'Markdown (.md)', docx: 'Word (.docx)', latex: 'LaTeX (.tex)' };

/**
 * AI Peer Review tab.
 *  - new: pick ONE source (attach files, unclassified - the reviewer decides;
 *    or a Paper Writer manuscript via a dropdown), pick reviewers, copy the
 *    prompt into your AI chat. When concerns land, the run opens.
 *  - run: two columns with sticky headers - the paper body on the left (with a
 *    Save-paper menu), per-reviewer Major/Minor Concern cards on the right, each
 *    with Suggest Revision → Accept (applies to the paper, marks the concern
 *    resolved) and a Re-run button pinned in the comments header.
 */
export class AriaPeerReviewEditorPane extends EditorPane {

	static readonly ID = AriaPeerReviewInput.EDITOR_ID;

	private root: HTMLElement | undefined;
	private execId: string | undefined;
	private meta: ReviewMeta | undefined;
	private concerns: ConcernsFile | undefined;
	private revisions: Record<string, Revision> = {};
	private resolved = new Set<string>();
	private paperText = '';

	// new-review form state
	private sourceMode: 'file' | 'manuscript' = 'file';
	private draft: URI | undefined;
	private figures: URI[] = [];
	private supplementary: URI[] = [];
	private papers: PaperItem[] = [];
	private selectedPaperId = '';
	private selectedFormat: PaperFormat = 'markdown';
	private availableFormats: PaperFormat[] = ['markdown'];
	private reviewers: Record<string, boolean> = { claude: true };
	/** Each reviewer CLI present on this machine (gates that reviewer - the review
	 *  runs `claude --print` / `codex exec`, not the VS Code extension). Optimistic
	 *  default; refreshed async from the extension when the editor is shown. */
	private codexAvailable = true;
	private claudeAvailable = true;

	private activeReviewer = '';
	private docs: { key: string; name: string }[] = [];
	private activeDoc = 'main';
	private rightWidth = 440;
	private menuEl: HTMLElement | undefined;
	private readonly revWidgets = new Map<string, HTMLElement>();
	private readonly proposalIdx = new Map<string, number>();
	private seenRevs = new Map<string, string>();   // rev id → last-seen recordedAt
	private focusedSpan: string | undefined;         // docKey::anchor of the currently-focused edit
	private leftCol: HTMLElement | undefined;        // the paper column (for in-place body re-render)
	private bodyEl: HTMLElement | undefined;         // the paper body element

	private readonly inputStore = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExtensionService private readonly extensionService: IExtensionService,
	) {
		super(AriaPeerReviewEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const root = document.createElement('div');
		Object.assign(root.style, { width: '100%', height: '100%', boxSizing: 'border-box', fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)', color: 'var(--vscode-foreground)' });
		parent.appendChild(root);
		this.root = root;
		void this.refreshCliAvailability();
		// A provider extension (Claude / Codex) can be installed while this pane is
		// already open - e.g. the user picks a new AI from the account menu. Re-probe
		// on any extension change so the reviewer checkbox flips from "CLI not
		// installed" to enabled immediately, without needing a window reload.
		this._register(this.extensionService.onDidChangeExtensions(() => void this.refreshCliAvailability()));
	}

	/** Ask the extension whether each reviewer CLI is installed, then re-render so
	 *  the reviewer checkboxes reflect it. Best-effort - assumes available on
	 *  failure so we never wrongly block a working setup. */
	private async refreshCliAvailability(): Promise<void> {
		// Gate each reviewer on whether its PROVIDER EXTENSION is installed. The
		// review runs through that extension's chat (sendToChat), so "extension
		// installed" is the accurate, reliably-detectable "can I review with this
		// AI" signal - unlike login (Claude stores it in the macOS keychain) or a
		// bare CLI probe. Aria installs each provider's CLI alongside its extension.
		const claude = !!(await this.extensionService.getExtension('anthropic.claude-code'));
		const codex = !!(await this.extensionService.getExtension('openai.chatgpt'));
		const changed = claude !== this.claudeAvailable || codex !== this.codexAvailable;
		this.claudeAvailable = claude;
		this.codexAvailable = codex;
		if (!this.codexAvailable) { this.reviewers.codex = false; }
		if (!this.claudeAvailable) { this.reviewers.claude = false; }
		// Only repaint when availability actually flipped - onDidChangeExtensions
		// fires often during startup and a blind render() would drop focus from the
		// form the user may be filling in.
		if (this.root && changed) {
			this.render();
		}
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof AriaPeerReviewInput)) { return; }
		this.inputStore.clear();
		this.execId = input.execId;
		this.draft = undefined; this.figures = []; this.supplementary = [];
		this.selectedPaperId = '';
		this.reviewers = { claude: true };
		this.revisions = {};
		this.resolved = new Set();
		this.proposalIdx.clear();
		this.activeDoc = 'main';

		if (this.execId) {
			await this.reloadRun();
			// Seed "seen" so we don't auto-jump to already-present revisions on open.
			this.seenRevs = new Map(this.pendingRevIds().map(id => [id, this.revisions[id].recordedAt]));
			this.paperText = await this.loadPaperText(this.activeDoc);
			if (this.meta?.title && input instanceof AriaPeerReviewInput) { input.setName(this.meta.title); }
			const dir = this.reviewDir();
			if (dir) {
				this.inputStore.add(this.fileService.onDidFilesChange(e => {
					if (e.affects(dir)) { void this.refreshRun(); }
				}));
			}
		} else {
			this.papers = await this.loadPapers();
			this.sourceMode = 'file';
		}
		if (token.isCancellationRequested) { return; }
		this.render();
		// Re-probe the codex CLI each time the tab is shown (the editor pane instance
		// is reused across reopens, so createEditor alone would keep a stale result).
		void this.refreshCliAvailability();
	}

	// --- data ---------------------------------------------------------------

	private folderUri(): URI | undefined { return this.workspaceContextService.getWorkspace().folders[0]?.uri; }
	private reviewDir(): URI | undefined { const f = this.folderUri(); return f && this.execId ? joinPath(f, 'reviews', this.execId) : undefined; }
	private async readJson<T>(uri: URI): Promise<T | undefined> { try { return JSON.parse((await this.fileService.readFile(uri)).value.toString()) as T; } catch { return undefined; } }
	private async readText(uri: URI): Promise<string> { try { return (await this.fileService.readFile(uri)).value.toString(); } catch { return ''; } }

	private async reloadRun(): Promise<void> {
		const dir = this.reviewDir();
		if (!dir) { return; }
		this.meta = await this.readJson<ReviewMeta>(joinPath(dir, 'meta.json'));
		this.concerns = await this.readJson<ConcernsFile>(joinPath(dir, 'concerns.json'));
		this.revisions = (await this.readJson<Record<string, Revision>>(joinPath(dir, 'revisions.json'))) ?? {};
		const st = await this.readJson<{ resolved?: string[] }>(joinPath(dir, 'state.json'));
		this.resolved = new Set(st?.resolved ?? []);
		if (this.meta && !this.activeReviewer) { this.activeReviewer = this.meta.reviewers[0] ?? 'claude'; }
		this.docs = this.buildDocs();
		if (!this.docs.some(d => d.key === this.activeDoc)) { this.activeDoc = 'main'; }
	}

	/** Ids of revisions that are proposed and not yet resolved. */
	private pendingRevIds(): string[] {
		return Object.keys(this.revisions).filter(id => !this.resolved.has(id) && this.proposalsOf(this.revisions[id]).length > 0);
	}

	/** Reload after a file change; when a revision is newly proposed OR re-proposed
	 *  (recordedAt changed), reset its carousel and focus it (switching document if
	 *  needed). Focus stays put when the target span is unchanged (see scrollToRevision). */
	private async refreshRun(): Promise<void> {
		await this.reloadRun();
		const pending = this.pendingRevIds();
		const freshIds: string[] = [];
		for (const id of pending) {
			if (this.seenRevs.get(id) !== this.revisions[id].recordedAt) { freshIds.push(id); this.proposalIdx.delete(id); }
			this.seenRevs.set(id, this.revisions[id].recordedAt);
		}
		for (const id of [...this.seenRevs.keys()]) { if (!(id in this.revisions)) { this.seenRevs.delete(id); } }
		let focusId: string | undefined;
		if (freshIds.length) {
			focusId = freshIds.sort((a, b) => this.revisions[a].recordedAt.localeCompare(this.revisions[b].recordedAt)).pop();
			const dk = this.revisions[focusId!].documentKey ?? 'main';
			if (dk !== this.activeDoc) { this.activeDoc = dk; }
		}
		this.paperText = await this.loadPaperText(this.activeDoc);
		this.render();
		if (focusId) { this.scrollToRevision(focusId); }
	}

	/** The concern a revision id refers to, if it is a concern-tied id (`reviewer#i`). */
	private concernById(id: string): Concern | undefined {
		const m = /^(.+)#(\d+)$/.exec(id);
		if (!m) { return undefined; }
		return this.concerns?.reviewers?.[m[1]]?.concerns[Number(m[2])];
	}

	/** The document tabs for the left pane: main draft + each supplementary. */
	private buildDocs(): { key: string; name: string }[] {
		const m = this.meta;
		if (!m) { return [{ key: 'main', name: 'Draft' }]; }
		const mainName = m.paperId ? m.title : (m.draftFile ? (m.draftFile.split('/').pop() ?? 'Draft') : m.title);
		const docs = [{ key: 'main', name: mainName }];
		(m.supplementaryFiles ?? []).forEach((rel, i) => docs.push({ key: `suppl-${i + 1}`, name: rel.split('/').pop() ?? `suppl-${i + 1}` }));
		return docs;
	}

	/** extracted / working URIs for a document key. */
	private docPathUris(docKey: string): { extracted: URI; working: URI } | undefined {
		const dir = this.reviewDir();
		if (!dir) { return undefined; }
		const base = joinPath(dir, 'docs');
		return { extracted: joinPath(base, `${docKey}.extracted.md`), working: joinPath(base, `${docKey}.working.md`) };
	}
	private async setActiveDoc(key: string): Promise<void> {
		this.activeDoc = key;
		this.paperText = await this.loadPaperText(key);
		this.render();
	}
	private async focusRevision(id: string): Promise<void> {
		const dk = this.revisions[id]?.documentKey ?? 'main';
		if (dk !== this.activeDoc) { await this.setActiveDoc(dk); }
		this.scrollToRevision(id);
	}
	private async persistResolved(): Promise<void> {
		const dir = this.reviewDir();
		if (!dir) { return; }
		await this.fileService.writeFile(joinPath(dir, 'state.json'), VSBuffer.fromString(JSON.stringify({ resolved: [...this.resolved] }, null, 2)));
	}
	private async loadPaperText(docKey: string): Promise<string> {
		const pp = this.docPathUris(docKey);
		if (pp) {
			const working = await this.readText(pp.working);
			if (working.trim()) { return working; }
			const ex = await this.readText(pp.extracted);
			if (ex.trim()) { return ex; }
		}
		// Fallback for the main manuscript before the agent has extracted it.
		const f = this.folderUri();
		if (docKey === 'main' && f && this.meta?.paperId) { return this.readText(joinPath(f, 'paper', this.meta.paperId, 'manuscript.md')); }
		return '';
	}
	private async loadPapers(): Promise<PaperItem[]> {
		const f = this.folderUri();
		if (!f) { return []; }
		const out: PaperItem[] = [];
		try {
			const stat = await this.fileService.resolve(joinPath(f, 'paper'));
			for (const c of stat.children ?? []) {
				if (!c.isDirectory) { continue; }
				const meta = await this.readJson<{ id?: string; title?: string }>(joinPath(c.resource, 'meta.json'));
				out.push({ id: meta?.id ?? basename(c.resource), title: (meta?.title && meta.title.trim()) || basename(c.resource) });
			}
		} catch { /* none */ }
		return out;
	}
	/** Which stored formats of a paper exist: markdown (always) + any exports. */
	private async loadFormats(paperId: string): Promise<PaperFormat[]> {
		const f = this.folderUri();
		if (!f || !paperId) { return ['markdown']; }
		const out: PaperFormat[] = ['markdown'];
		const exp = joinPath(f, 'paper', paperId, 'export');
		if (await this.fileService.exists(joinPath(exp, 'paper.docx'))) { out.push('docx'); }
		if (await this.fileService.exists(joinPath(exp, 'paper.tex'))) { out.push('latex'); }
		return out;
	}

	// --- render root switch -------------------------------------------------

	private render(): void {
		const root = this.root;
		if (!root) { return; }
		if (this.menuEl) { this.menuEl.remove(); this.menuEl = undefined; }
		clearNode(root);
		if (this.execId && this.meta) {
			Object.assign(root.style, { padding: '0', display: 'flex', overflow: 'hidden' });
			this.renderRun(root);
		} else {
			Object.assign(root.style, { padding: '18px 22px', display: 'block', overflow: 'auto' });
			applyAriaScrollbar(root);
			this.renderNew(root);
		}
	}

	// --- small helpers ------------------------------------------------------

	private button(text: string, variant: 'primary' | 'ghost', onclick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.textContent = text;
		Object.assign(btn.style, { padding: '6px 13px', fontSize: '13px', borderRadius: '4px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' });
		if (variant === 'primary') { Object.assign(btn.style, { background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: '1px solid transparent' }); }
		else { Object.assign(btn.style, { background: 'transparent', color: 'var(--vscode-foreground)', border: '1px solid rgba(127,127,127,0.4)' }); }
		btn.onclick = onclick;
		return btn;
	}
	private opt(text: string, value: string, selected = false, disabled = false): HTMLOptionElement {
		const o = document.createElement('option');
		o.text = text; o.value = value; o.selected = selected; o.disabled = disabled;
		return o;
	}
	private label(parent: HTMLElement, text: string): void {
		const l = append(parent, $('div')); l.textContent = text;
		Object.assign(l.style, { fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: '0.65', margin: '2px 0 10px' });
	}

	/** A bordered box that visually groups one numbered step of the New Review
	 *  form (1 · What to review, 2 · Reviewers). */
	private section(parent: HTMLElement): HTMLElement {
		const box = append(parent, $('div'));
		Object.assign(box.style, {
			border: '1px solid rgba(127,127,127,0.28)', borderRadius: '10px',
			padding: '14px 16px 16px', marginTop: '16px',
			background: 'rgba(127,127,127,0.03)',
			boxSizing: 'border-box', maxWidth: '100%', overflow: 'hidden',
		});
		return box;
	}

	// --- new-review form ----------------------------------------------------

	private renderNew(root: HTMLElement): void {
		const h = append(root, $('div')); h.textContent = localize('aria.peerReview.newTitle', "AI Peer Review");
		Object.assign(h.style, { fontSize: '20px', fontWeight: '600', margin: '2px 0 4px' });
		const sub = append(root, $('div')); sub.textContent = localize('aria.peerReview.newSub', "Pick ONE source to review, choose reviewers, then run independent AI reviewers to surface major concerns - without fabricating anything.");
		Object.assign(sub.style, { fontSize: '13px', opacity: '0.7', marginBottom: '4px' });

		const s1 = this.section(root);
		this.label(s1, localize('aria.peerReview.source', "1 · What to review"));
		const cards = append(s1, $('div'));
		Object.assign(cards.style, { display: 'flex', gap: '12px', flexWrap: 'wrap' });
		cards.appendChild(this.sourceCard('file', localize('aria.peerReview.optFile', "Upload a file"), localize('aria.peerReview.optFileHint', "A paper on your computer (.md, .txt, .docx, .pdf, .tex). Add supplementary files too."), true));
		const hasPapers = this.papers.length > 0;
		cards.appendChild(this.sourceCard('manuscript', localize('aria.peerReview.optManuscript', "A paper written in Paper Writer"), hasPapers ? localize('aria.peerReview.optManuscriptHint', "Review a manuscript you drafted in the Paper Writer tab.") : localize('aria.peerReview.optManuscriptNone', "No Paper Writer manuscripts yet - create one in the Paper Writer tab first."), hasPapers));

		// selected-source detail
		const detail = append(s1, $('div')); detail.style.marginTop = '12px';
		if (this.sourceMode === 'file') {
			// Three slots so the reviewer knows exactly which file is the main text.
			this.fileSlot(detail, localize('aria.peerReview.draft', "Draft (main manuscript)"), localize('aria.peerReview.draftHint', "The paper text to review (.md, .txt, .docx, .pdf, .tex). Required - this is what's previewed and revised."),
				this.draft ? [this.draft] : [], false,
				() => void this.pickDraft(),
				() => { this.draft = undefined; this.render(); });
			this.fileSlot(detail, localize('aria.peerReview.figures', "Figures (optional)"), localize('aria.peerReview.figuresHint', "Figure images the paper references. Passed to the reviewer by name."),
				this.figures, true,
				() => void this.pickInto('figures'),
				(i) => { this.figures.splice(i, 1); this.render(); });
			this.fileSlot(detail, localize('aria.peerReview.suppl', "Supplementary (optional)"), localize('aria.peerReview.supplHint', "Extra data / supplementary documents. Extracted to text as context for the reviewer."),
				this.supplementary, true,
				() => void this.pickInto('supplementary'),
				(i) => { this.supplementary.splice(i, 1); this.render(); });
		} else {
			// dropdown of Paper Writer manuscripts + which stored format to review
			const row = append(detail, $('div'));
			Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' });
			const sel = document.createElement('select');
			Object.assign(sel.style, { padding: '7px 10px', fontSize: '13.5px', borderRadius: '4px', minWidth: '260px', maxWidth: '420px', background: 'var(--vscode-dropdown-background, var(--vscode-input-background))', color: 'var(--vscode-dropdown-foreground, var(--vscode-foreground))', border: '1px solid var(--vscode-dropdown-border, rgba(127,127,127,0.4))', fontFamily: 'inherit' });
			sel.add(this.opt(localize('aria.peerReview.pickManuscript', "Pick a manuscript…"), '', !this.selectedPaperId, true));
			for (const p of this.papers) {
				sel.add(this.opt(p.title, p.id, p.id === this.selectedPaperId));
			}
			sel.onchange = async () => {
				this.selectedPaperId = sel.value;
				this.availableFormats = await this.loadFormats(this.selectedPaperId);
				if (!this.availableFormats.includes(this.selectedFormat)) { this.selectedFormat = 'markdown'; }
				this.render();
			};
			row.appendChild(sel);

			if (this.selectedPaperId) {
				const flabel = append(row, $('span')); flabel.textContent = localize('aria.peerReview.format', "Format:");
				Object.assign(flabel.style, { fontSize: '12.5px', opacity: '0.7' });
				const fsel = document.createElement('select');
				Object.assign(fsel.style, { padding: '7px 10px', fontSize: '13px', borderRadius: '4px', background: 'var(--vscode-dropdown-background, var(--vscode-input-background))', color: 'var(--vscode-dropdown-foreground, var(--vscode-foreground))', border: '1px solid var(--vscode-dropdown-border, rgba(127,127,127,0.4))', fontFamily: 'inherit' });
				for (const fmt of this.availableFormats) {
					fsel.add(this.opt(FORMAT_LABEL[fmt], fmt, fmt === this.selectedFormat));
				}
				fsel.onchange = () => { this.selectedFormat = fsel.value as PaperFormat; };
				row.appendChild(fsel);
			}

			if (this.availableFormats.length === 1) {
				const hint = append(detail, $('div')); hint.textContent = localize('aria.peerReview.onlyMd', "Only the Markdown source exists. Export the paper to .docx/.tex in Paper Writer if you want to review a specific format.");
				Object.assign(hint.style, { fontSize: '12px', opacity: '0.6', marginTop: '8px' });
			}
		}

		// reviewers
		const s2 = this.section(root);
		this.label(s2, localize('aria.peerReview.reviewers', "2 · Reviewers"));
		const rw = append(s2, $('div'));
		Object.assign(rw.style, { display: 'flex', flexDirection: 'column', gap: '6px' });
		rw.appendChild(this.reviewerCheckbox('claude', this.claudeAvailable ? 'Claude' : localize('aria.peerReview.claudeMissing', "Claude - CLI not installed"), this.claudeAvailable));
		rw.appendChild(this.reviewerCheckbox('codex', this.codexAvailable ? 'Codex' : localize('aria.peerReview.codexMissing', "Codex - CLI not installed"), this.codexAvailable));

		// copy prompt
		const bar = append(root, $('div'));
		Object.assign(bar.style, { marginTop: '24px', display: 'flex', alignItems: 'center', gap: '10px' });
		bar.appendChild(this.button(localize('aria.peerReview.copyPrompt', "Review with AI"), 'primary', () => void this.startReview()));
		const note = append(root, $('div')); note.textContent = localize('aria.peerReview.copyNote', "Paste it into your AI chat and press Enter. When the reviewers finish, this tab opens the results.");
		Object.assign(note.style, { fontSize: '12px', opacity: '0.6', marginTop: '8px' });
	}

	private sourceCard(mode: 'file' | 'manuscript', title: string, hint: string, enabled: boolean): HTMLElement {
		const active = this.sourceMode === mode;
		const card = document.createElement('div');
		// flex-basis 160px with minWidth:0 lets the cards SHRINK (and wrap) instead
		// of overflowing the section box on a narrow panel; box-sizing + maxWidth
		// keep each card's padding/border inside its column.
		Object.assign(card.style, { flex: '1 1 160px', minWidth: '0', maxWidth: '100%', boxSizing: 'border-box', padding: '14px 16px', borderRadius: '8px', cursor: enabled ? 'pointer' : 'default', opacity: enabled ? '1' : '0.5', border: active ? '2px solid var(--vscode-focusBorder, #4c8bf5)' : '1px solid rgba(127,127,127,0.3)', background: active ? 'rgba(76,139,245,0.08)' : 'rgba(127,127,127,0.04)' });
		const t = append(card, $('div')); t.textContent = title;
		Object.assign(t.style, { fontWeight: '600', fontSize: '14px', marginBottom: '4px' });
		const h = append(card, $('div')); h.textContent = hint;
		Object.assign(h.style, { fontSize: '12px', opacity: '0.7', lineHeight: '1.45' });
		if (enabled) {
			card.onclick = async () => {
				this.sourceMode = mode;
				if (mode === 'manuscript') {
					this.papers = await this.loadPapers();
					if (!this.selectedPaperId && this.papers.length) { this.selectedPaperId = this.papers[0].id; }
					if (this.selectedPaperId) {
						this.availableFormats = await this.loadFormats(this.selectedPaperId);
						if (!this.availableFormats.includes(this.selectedFormat)) { this.selectedFormat = 'markdown'; }
					}
				}
				this.render();
			};
		}
		return card;
	}

	/** A VSCode-styled checkbox (square, checkbox theme colors, codicon check). */
	private checkbox(checked: boolean, enabled = true): HTMLElement {
		const box = document.createElement('div');
		box.setAttribute('role', 'checkbox');
		box.setAttribute('aria-checked', String(checked));
		Object.assign(box.style, {
			width: '18px', height: '18px', borderRadius: '3px', boxSizing: 'border-box',
			border: '1px solid var(--vscode-checkbox-border, rgba(127,127,127,0.5))',
			background: 'var(--vscode-checkbox-background, transparent)',
			color: 'var(--vscode-checkbox-foreground)',
			display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: '0',
			opacity: enabled ? '1' : '0.5',
		});
		const ic = append(box, $('span.codicon.codicon-check'));
		Object.assign(ic.style, { fontSize: '14px', lineHeight: '1', visibility: checked ? 'visible' : 'hidden' });
		return box;
	}

	private reviewerCheckbox(id: string, text: string, enabled: boolean): HTMLElement {
		const wrap = document.createElement('div');
		Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', cursor: enabled ? 'pointer' : 'default' });
		const box = this.checkbox(!!this.reviewers[id] && enabled, enabled);
		box.style.opacity = enabled ? '1' : '0.55';
		wrap.appendChild(box);
		if (enabled) { wrap.onclick = () => { this.reviewers[id] = !this.reviewers[id]; this.render(); }; }
		const t = append(wrap, $('span')); t.textContent = text; t.style.opacity = enabled ? '1' : '0.55';
		// When a reviewer's CLI is missing, offer a belated install right here - a
		// plain underlined link (not a button, so it isn't confused with the
		// actions below). It installs only this provider's CLI.
		if (!enabled && (id === 'claude' || id === 'codex')) {
			const install = append(wrap, $('span'));
			install.textContent = localize('aria.peerReview.installCli', "Install");
			Object.assign(install.style, { cursor: 'pointer', textDecoration: 'underline', color: 'var(--vscode-textLink-foreground)' });
			install.onclick = (e) => { e.stopPropagation(); void this.installReviewerCli(id); };
		}
		return wrap;
	}

	/** Belated CLI install for a reviewer whose CLI is missing. Runs the shared
	 *  installer (auto Node bootstrap + provider install, in a visible terminal)
	 *  for ONLY this provider, then polls availability so the checkbox re-enables
	 *  once the CLI lands - no reload needed. */
	private async installReviewerCli(provider: 'claude' | 'codex'): Promise<void> {
		try {
			await this.commandService.executeCommand('aria.provider.installCli', provider);
		} catch {
			// The installer surfaces its own errors in the terminal / notifications.
		}
		// The install runs asynchronously in a terminal; re-probe for a while so
		// the reviewer checkbox flips on automatically when it finishes.
		for (let i = 0; i < 20 && this.root; i++) {
			await new Promise(resolve => setTimeout(resolve, 3000));
			if (!this.root) { break; }
			await this.refreshCliAvailability();
			if (provider === 'codex' ? this.codexAvailable : this.claudeAvailable) { break; }
		}
	}

	/** A labelled file slot: title, hint, current file rows (with ✕), and an add/select button. */
	private fileSlot(parent: HTMLElement, title: string, hint: string, files: URI[], multi: boolean, add: () => void, remove: (i: number) => void): void {
		this.label(parent, title);
		const h = append(parent, $('div')); h.textContent = hint;
		Object.assign(h.style, { fontSize: '12px', opacity: '0.6', marginTop: '-4px', marginBottom: '8px' });
		if (files.length) {
			const list = append(parent, $('div'));
			Object.assign(list.style, { display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '520px', marginBottom: '8px' });
			files.forEach((u, i) => {
				const row = append(list, $('div'));
				Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(127,127,127,0.2)' });
				const name = append(row, $('span')); name.textContent = basename(u); name.style.flex = '1';
				const del = append(row, $('span')); del.textContent = '✕';
				Object.assign(del.style, { cursor: 'pointer', opacity: '0.6', padding: '0 4px' });
				del.title = localize('aria.peerReview.remove', "Remove");
				del.onclick = () => remove(i);
			});
		}
		const label = files.length
			? (multi ? localize('aria.peerReview.addMore', "+ Add more") : localize('aria.peerReview.replace', "Replace"))
			: (multi ? localize('aria.peerReview.addFiles', "+ Add files") : localize('aria.peerReview.selectFile', "Select file"));
		parent.appendChild(this.button(label, files.length ? 'ghost' : 'primary', add));
	}

	private async pickDraft(): Promise<void> {
		const uris = await this.fileDialogService.showOpenDialog({
			canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
			openLabel: localize('aria.peerReview.select', "Select"),
			filters: [{ name: localize('aria.peerReview.paperFiles', "Papers"), extensions: REVIEW_FILTERS }],
		});
		if (uris && uris.length) { this.draft = uris[0]; this.render(); }
	}

	private async pickInto(kind: 'figures' | 'supplementary'): Promise<void> {
		const uris = await this.fileDialogService.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: localize('aria.peerReview.select', "Select") });
		if (!uris || !uris.length) { return; }
		const target = kind === 'figures' ? this.figures : this.supplementary;
		const seen = new Set(target.map(u => u.toString()));
		for (const u of uris) { if (!seen.has(u.toString())) { target.push(u); } }
		this.render();
	}

	private async startReview(): Promise<void> {
		const folder = this.folderUri();
		if (!folder) { this.notificationService.error(localize('aria.peerReview.noFolder', "Open a project folder first.")); return; }
		const reviewers = Object.keys(this.reviewers).filter(k => this.reviewers[k]);
		if (reviewers.length === 0) { this.notificationService.error(localize('aria.peerReview.noReviewer', "Select at least one reviewer.")); return; }

		const execId = 'rev-' + generateUuid().slice(0, 8);
		const dir = joinPath(folder, 'reviews', execId);
		await this.fileService.createFolder(dir);
		const now = new Date().toISOString();
		let meta: ReviewMeta;
		let title: string;

		if (this.sourceMode === 'manuscript') {
			if (!this.selectedPaperId) { this.notificationService.error(localize('aria.peerReview.noManuscript', "Pick a manuscript.")); return; }
			title = this.papers.find(p => p.id === this.selectedPaperId)?.title ?? this.selectedPaperId;
			meta = { execId, title, reviewers, paperId: this.selectedPaperId, paperFormat: this.selectedFormat, createdAt: now, iteration: 1 };
		} else {
			if (!this.draft) { this.notificationService.error(localize('aria.peerReview.noDraft', "Select the draft (main manuscript) first.")); return; }
			const filesDir = joinPath(dir, 'files');
			await this.fileService.createFolder(filesDir);
			const copy = async (u: URI): Promise<string> => {
				const name = basename(u);
				await this.fileService.writeFile(joinPath(filesDir, name), (await this.fileService.readFile(u)).value);
				return 'files/' + name;
			};
			const draftFile = await copy(this.draft);
			const figureFiles: string[] = [];
			for (const u of this.figures) { figureFiles.push(await copy(u)); }
			const supplementaryFiles: string[] = [];
			for (const u of this.supplementary) { supplementaryFiles.push(await copy(u)); }
			title = basename(this.draft).replace(/\.[^.]+$/, '');
			meta = { execId, title, reviewers, draftFile, figureFiles, supplementaryFiles, createdAt: now, iteration: 1 };
		}

		await this.fileService.writeFile(joinPath(dir, 'meta.json'), VSBuffer.fromString(JSON.stringify(meta, null, 2)));
		await this.sendToChat(this.reviewPrompt(execId, title, reviewers));

		// Open the run when concerns land (the user reviews in the chat).
		const concernsUri = joinPath(dir, 'concerns.json');
		const watcher = this.fileService.onDidFilesChange(async e => {
			if (!e.affects(dir)) { return; }
			if (await this.fileService.exists(concernsUri)) {
				watcher.dispose();
				await this.editorService.openEditor(new AriaPeerReviewInput(execId), { pinned: true });
			}
		});
		this.inputStore.add(watcher);
	}

	private reviewPrompt(execId: string, _title: string, reviewers: string[]): string {
		return `Using the Aria peer reviewer, run an AI peer review for review run "${execId}". Follow the iterative-paper-defense skill: call get_review("${execId}"), then for each reviewer run it independently - you are the driver, so review with your own model directly and run any other reviewer's model headless via its CLI - and record each reviewer's Major/Minor concerns with record_review. Reviewers: ${reviewers.join(', ')}.`;
	}

	private revisePrompt(concernId: string, c: Concern): string {
		return `Using the Aria peer reviewer, suggest revisions for concern "${concernId}" ("${c.title}") in review run "${this.execId}". Follow the iterative-paper-defense skill: call get_review("${this.execId}"), devise up to 3 alternative strategies (each an Argument / Edit footprint / Risk), and record them together in ONE record_revision call as the proposals array. Set documentKey to the document you are editing - "main" for the manuscript, or a supplementary key like "suppl-1".`;
	}

	private async sendToChat(query: string): Promise<void> {
		// Copy-and-paste is the primary path: copy the prompt, reveal whichever
		// AI provider chat the user installed (Claude / Codex / Gemini), and tell
		// the user to paste it and press Enter.
		await this.clipboardService.writeText(query);
		await revealAiProviderChat(this.commandService, this.configurationService);
		this.notificationService.info(localize('aria.peerReview.promptCopied', "Prompt copied - paste it into your AI chat (Ctrl/Cmd+V) and press Enter."));
	}

	// --- run results (two columns, sticky headers) --------------------------

	private renderRun(root: HTMLElement): void {
		const meta = this.meta!;
		const bg = 'var(--vscode-editor-background)';

		// Both column headers share HEADER_H (kept short) so their bottom borders
		// line up and the Save-paper / Re-run buttons sit on one horizontal line.
		const HEADER_H = '54px';

		// LEFT - paper body, sticky header with title/date/id + Save menu.
		const left = append(root, $('div'));
		this.leftCol = left;
		Object.assign(left.style, { flex: '1', minWidth: '0', overflow: 'auto' });
		applyAriaScrollbar(left);
		const lhead = append(left, $('div'));
		Object.assign(lhead.style, { position: 'sticky', top: '0', zIndex: '2', background: bg, height: HEADER_H, boxSizing: 'border-box', padding: '0 22px', borderBottom: '1px solid rgba(127,127,127,0.2)', display: 'flex', alignItems: 'center', gap: '12px' });
		const lheadText = append(lhead, $('div'));
		Object.assign(lheadText.style, { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', justifyContent: 'center' });
		const pt = append(lheadText, $('div')); pt.textContent = meta.title;
		Object.assign(pt.style, { fontSize: '15px', fontWeight: '600', marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
		const pm = append(lheadText, $('div')); pm.textContent = `${new Date(meta.createdAt).toLocaleString()} · ${meta.execId}`;
		Object.assign(pm.style, { fontSize: '11px', opacity: '0.55', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
		lhead.appendChild(this.saveMenu());

		// Document tabs (Draft · Suppl 1 · …) - mirror of the reviewer tabs on the right.
		if (this.docs.length > 1) {
			const dtabs = append(left, $('div'));
			Object.assign(dtabs.style, { position: 'sticky', top: HEADER_H, zIndex: '1', background: bg, display: 'flex', gap: '4px', padding: '6px 18px 0', borderBottom: '1px solid rgba(127,127,127,0.18)', overflowX: 'auto' });
			for (const d of this.docs) {
				const active = d.key === this.activeDoc;
				const t = append(dtabs, $('div'));
				t.textContent = d.key === 'main' ? localize('aria.peerReview.docMain', "{0} (main)", d.name) : d.name;
				Object.assign(t.style, { padding: '6px 11px', fontSize: '12.5px', cursor: 'pointer', whiteSpace: 'nowrap', borderBottom: active ? '2px solid var(--vscode-focusBorder, #4c8bf5)' : '2px solid transparent', fontWeight: active ? '600' : '400', opacity: active ? '1' : '0.7' });
				t.onclick = () => void this.setActiveDoc(d.key);
			}
		}

		this.renderPaperBody(left);

		// DIVIDER - draggable sash to resize the two columns.
		const divider = append(root, $('div'));
		Object.assign(divider.style, { width: '6px', flexShrink: '0', cursor: 'col-resize', borderLeft: '1px solid rgba(127,127,127,0.2)', boxSizing: 'border-box', zIndex: '3' });
		divider.onmouseenter = () => { divider.style.borderLeftColor = 'var(--vscode-focusBorder, #4c8bf5)'; };
		divider.onmouseleave = () => { divider.style.borderLeftColor = 'rgba(127,127,127,0.2)'; };

		// RIGHT - comments; short sticky header (title + Re-run), tabs below.
		const right = append(root, $('div'));
		Object.assign(right.style, { width: `${this.rightWidth}px`, flexShrink: '0', overflow: 'auto' });
		applyAriaScrollbar(right);
		const rhead = append(right, $('div'));
		Object.assign(rhead.style, { position: 'sticky', top: '0', zIndex: '2', background: bg, height: HEADER_H, boxSizing: 'border-box', padding: '0 18px', borderBottom: '1px solid rgba(127,127,127,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' });
		const rh = append(rhead, $('div')); rh.textContent = localize('aria.peerReview.comments', "Review Comments");
		Object.assign(rh.style, { fontSize: '15px', fontWeight: '600' });
		rhead.appendChild(this.button(localize('aria.peerReview.rerun', "Re-run on revised"), 'ghost', () => void this.rerun()));

		this.wireResize(root, divider, right);

		// reviewer tabs (Claude · Codex) - sticky under the header, mirror of the left document tabs.
		if (meta.reviewers.length > 1 || this.concerns) {
			const tabs = append(right, $('div'));
			Object.assign(tabs.style, { position: 'sticky', top: HEADER_H, zIndex: '1', background: bg, display: 'flex', gap: '4px', padding: '6px 18px 0', borderBottom: '1px solid rgba(127,127,127,0.18)', overflowX: 'auto' });
			for (const r of meta.reviewers) {
				const rec2 = this.concerns?.reviewers?.[r];
				const count = rec2?.concerns?.length ?? 0;
				const tab = append(tabs, $('div'));
				const active = r === this.activeReviewer;
				tab.textContent = `${this.reviewerName(r)}${rec2 ? ` (${count})` : ''}`;
				Object.assign(tab.style, { padding: '6px 11px', fontSize: '13px', cursor: 'pointer', whiteSpace: 'nowrap', borderBottom: active ? '2px solid var(--vscode-focusBorder, #4c8bf5)' : '2px solid transparent', fontWeight: active ? '600' : '400', opacity: active ? '1' : '0.7' });
				tab.onclick = () => { this.activeReviewer = r; this.render(); };
			}
		}

		const rbody = append(right, $('div'));
		Object.assign(rbody.style, { padding: '14px 18px 20px' });
		const rec = this.concerns?.reviewers?.[this.activeReviewer];
		if (!rec) {
			const wait = append(rbody, $('div'));
			Object.assign(wait.style, { fontSize: '13px', opacity: '0.75', padding: '16px 0', lineHeight: '1.5' });
			wait.textContent = localize('aria.peerReview.waiting', "Reviewing… concerns appear here when this reviewer finishes.");
			const paste = append(rbody, $('div'));
			Object.assign(paste.style, { fontSize: '12.5px', opacity: '0.6', lineHeight: '1.5' });
			paste.textContent = localize('aria.peerReview.pasteToStart', "Paste the copied prompt into your AI chat and press Enter to start.");
		} else {
			const withIdx = rec.concerns.map((c, i) => ({ c, id: `${this.activeReviewer}#${i}` }));
			const major = withIdx.filter(x => x.c.severity === 'major');
			const minor = withIdx.filter(x => x.c.severity === 'minor');
			this.renderConcernGroup(rbody, localize('aria.peerReview.major', "Major Concerns"), major, '#e05a4e', localize('aria.peerReview.noMajor', "No major concerns - looking good!"));
			this.renderConcernGroup(rbody, localize('aria.peerReview.minor', "Minor Concerns"), minor, '#e0b040', localize('aria.peerReview.noMinor', "No minor concerns."));
		}
	}

	/** Render the paper text, splicing in an inline revision widget (edit +
	 *  Accept / Re-suggest) at each pending revision's location, and scroll to the
	 *  newest one. */
	private renderPaperBody(parent: HTMLElement): void {
		this.revWidgets.clear();
		const body = append(parent, $('div'));
		this.bodyEl = body;
		Object.assign(body.style, { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '13px', lineHeight: '1.7', fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)', margin: '0', padding: '16px 22px' });
		const text = this.paperText;
		if (!text) { body.textContent = localize('aria.peerReview.noBody', "(The paper body appears once a reviewer loads it.)"); return; }

		// Every pending (proposed, unresolved) revision for the CURRENT document -
		// both concern-tied and standalone (user-requested) - placed at the FIRST
		// proposal's span. Keep only non-overlapping ones, in order.
		const pend: { id: string; rev: Revision; index: number; len: number }[] = [];
		for (const [id, rev] of Object.entries(this.revisions)) {
			if (this.resolved.has(id)) { continue; }
			if ((rev.documentKey ?? 'main') !== this.activeDoc) { continue; }
			const props = this.proposalsOf(rev);
			if (!props.length) { continue; }
			// Place the widget over the SELECTED proposal's span so surrounding text
			// (e.g. "I have " before "a doll") renders correctly for each strategy.
			const p = props[this.selectedIndex(id, props.length)];
			const index = p.original ? text.indexOf(p.original) : -1;
			if (index >= 0) { pend.push({ id, rev, index, len: p.original.length }); }
		}
		// When spans overlap, the NEWEST revision wins (a direct "just delete it"
		// supersedes an earlier suggestion at the same place).
		pend.sort((a, b) => (b.rev.recordedAt || '').localeCompare(a.rev.recordedAt || ''));
		const placed: typeof pend = [];
		for (const p of pend) {
			if (!placed.some(q => p.index < q.index + q.len && q.index < p.index + p.len)) { placed.push(p); }
		}
		placed.sort((a, b) => a.index - b.index);

		if (placed.length === 0) { body.textContent = text; return; }

		let cursor = 0;
		for (const p of placed) {
			if (p.index > cursor) { body.appendChild(document.createTextNode(text.slice(cursor, p.index))); }
			const widget = this.revisionWidget(p.id, p.rev);
			this.revWidgets.set(p.id, widget);
			body.appendChild(widget);
			cursor = p.index + p.len;
		}
		if (cursor < text.length) { body.appendChild(document.createTextNode(text.slice(cursor))); }
	}

	/** Re-render just the paper body (e.g. after switching carousel strategy) while
	 *  preserving the column's scroll position, so different-span strategies show
	 *  the correct surrounding text without the viewport jumping. */
	private rerenderPaperBody(): void {
		if (!this.leftCol) { return; }
		const st = this.leftCol.scrollTop;
		if (this.bodyEl) { this.bodyEl.remove(); this.bodyEl = undefined; }
		this.renderPaperBody(this.leftCol);
		this.leftCol.scrollTop = st;
	}

	private scrollToRevision(id: string): void {
		const w = this.revWidgets.get(id);
		if (!w) { return; }
		// Only move the viewport when the target span differs from the current focus -
		// re-suggesting / editing the SAME sentence keeps the view put (just pulses).
		const rev = this.revisions[id];
		const anchor = rev ? (this.proposalsOf(rev)[0]?.original ?? '') : '';
		const key = `${rev?.documentKey ?? 'main'}::${anchor.slice(0, 120)}`;
		const sameSpot = key === this.focusedSpan;
		this.focusedSpan = key;
		// Defer to the next frame so the freshly-built body has laid out.
		const win = w.ownerDocument.defaultView;
		const run = () => {
			if (!sameSpot) { w.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
			const prev = w.style.boxShadow;
			w.style.boxShadow = '0 0 0 3px var(--vscode-focusBorder, #4c8bf5)';
			win?.setTimeout(() => { w.style.boxShadow = prev; }, 900);
		};
		if (win) { win.requestAnimationFrame(run); } else { run(); }
	}

	private proposalsOf(rev: Revision): Proposal[] {
		if (rev.proposals && rev.proposals.length) { return rev.proposals; }
		if (rev.original) { return [{ original: rev.original, replacement: rev.replacement ?? '', explanation: rev.explanation ?? '' }]; }
		return [];
	}
	private selectedIndex(id: string, count: number): number {
		return Math.max(0, Math.min(this.proposalIdx.get(id) ?? 0, count - 1));
	}

	/** Inline in-paper widget showing one strategy of a "< N/3 >" carousel.
	 *  Switching strategies rebuilds only this node in place (no scroll). */
	private revisionWidget(id: string, rev: Revision): HTMLElement {
		const w = document.createElement('span');
		Object.assign(w.style, { display: 'inline-block', border: '1px solid var(--vscode-focusBorder, #4c8bf5)', borderRadius: '6px', padding: '7px 9px', margin: '2px 0', background: 'rgba(76,139,245,0.10)', verticalAlign: 'text-top', maxWidth: '100%' });
		this.fillWidget(w, id, rev);
		return w;
	}

	private navBtn(icon: string, enabled: boolean, onclick: () => void): HTMLButtonElement {
		const b = document.createElement('button');
		Object.assign(b.style, { padding: '2px 7px', borderRadius: '4px', cursor: enabled ? 'pointer' : 'default', background: 'transparent', color: 'var(--vscode-foreground)', border: '1px solid rgba(127,127,127,0.4)', opacity: enabled ? '1' : '0.35', display: 'inline-flex', alignItems: 'center', fontFamily: 'inherit' });
		const ic = append(b, $(`span.codicon.${icon}`)); ic.style.fontSize = '13px';
		if (enabled) { b.onclick = onclick; } else { b.disabled = true; }
		return b;
	}

	private fillWidget(w: HTMLElement, id: string, rev: Revision): void {
		clearNode(w);
		const props = this.proposalsOf(rev);
		const sel = this.selectedIndex(id, props.length);
		const p = props[sel];
		const c = this.concernById(id);   // undefined for standalone (user-requested) edits

		const diff = append(w, $('div'));
		Object.assign(diff.style, { whiteSpace: 'pre-wrap', wordBreak: 'break-word' });
		const del = append(diff, $('span')); del.textContent = p.original;
		Object.assign(del.style, { textDecoration: 'line-through', color: '#e05a4e', opacity: '0.75' });
		const arrow = append(diff, $('span')); arrow.textContent = ' → '; arrow.style.opacity = '0.55';
		const add = append(diff, $('span')); add.textContent = p.replacement;
		Object.assign(add.style, { color: '#4bbf73', fontWeight: '500' });
		if (p.explanation) {
			const ex = append(w, $('div')); ex.textContent = p.explanation;
			Object.assign(ex.style, { fontSize: '11.5px', opacity: '0.7', marginTop: '5px', fontStyle: 'italic' });
		}

		// actions row: Accept / Re-suggest on the left, "< N/M >" carousel on the right.
		const actions = append(w, $('div'));
		Object.assign(actions.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginTop: '7px' });
		const leftg = append(actions, $('div'));
		Object.assign(leftg.style, { display: 'flex', gap: '6px' });
		leftg.appendChild(this.button(localize('aria.peerReview.accept', "Accept"), 'primary', () => void this.acceptRevision(id)));
		if (c) {
			leftg.appendChild(this.button(localize('aria.peerReview.reSuggest', "Re-suggest"), 'ghost', () => void this.sendToChat(this.revisePrompt(id, c))));
		} else {
			// standalone (user-requested) edit - no concern to re-suggest against
			leftg.appendChild(this.button(localize('aria.peerReview.discard', "Discard"), 'ghost', () => void this.discardRevision(id)));
		}
		if (props.length > 1) {
			const rightg = append(actions, $('div'));
			Object.assign(rightg.style, { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: '0' });
			rightg.appendChild(this.navBtn('codicon-chevron-left', sel > 0, () => { this.proposalIdx.set(id, sel - 1); this.rerenderPaperBody(); }));
			const cnt = append(rightg, $('span')); cnt.textContent = `${sel + 1}/${props.length}`;
			Object.assign(cnt.style, { fontSize: '11.5px', opacity: '0.75', minWidth: '26px', textAlign: 'center' });
			rightg.appendChild(this.navBtn('codicon-chevron-right', sel < props.length - 1, () => { this.proposalIdx.set(id, sel + 1); this.rerenderPaperBody(); }));
		}
	}

	private saveMenu(): HTMLElement {
		const btn = document.createElement('button');
		Object.assign(btn.style, { padding: '6px 11px', fontSize: '13px', borderRadius: '4px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: '0', background: 'transparent', color: 'var(--vscode-foreground)', border: '1px solid rgba(127,127,127,0.4)', display: 'inline-flex', alignItems: 'center', gap: '6px' });
		const lbl = append(btn, $('span')); lbl.textContent = localize('aria.peerReview.savePaper', "Save paper");
		const chev = append(btn, $('span.codicon.codicon-chevron-down')); chev.style.fontSize = '13px';
		btn.onclick = () => this.openSaveMenu(btn);
		return btn;
	}

	private openSaveMenu(anchor: HTMLElement): void {
		const doc = anchor.ownerDocument;
		const win = doc.defaultView;
		if (this.menuEl) { this.menuEl.remove(); this.menuEl = undefined; }
		const rect = anchor.getBoundingClientRect();
		const menu = doc.createElement('div');
		Object.assign(menu.style, { position: 'fixed', top: `${rect.bottom + 4}px`, left: `${rect.left}px`, width: 'max-content', fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)', background: 'var(--vscode-menu-background, var(--vscode-dropdown-background, #2b2b2b))', color: 'var(--vscode-menu-foreground, var(--vscode-dropdown-foreground, #f0f0f0))', border: '1px solid var(--vscode-menu-border, var(--vscode-dropdown-border, rgba(127,127,127,0.4)))', borderRadius: '5px', boxShadow: '0 2px 12px rgba(0,0,0,0.45)', zIndex: '2000', padding: '4px' });
		const items: [string, string][] = [['markdown', localize('aria.peerReview.saveMd', "Markdown (.md)")], ['docx', localize('aria.peerReview.saveDocx', "Word (.docx)")], ['latex', localize('aria.peerReview.saveTex', "LaTeX (.tex)")]];
		const close = () => { menu.remove(); if (this.menuEl === menu) { this.menuEl = undefined; } doc.removeEventListener('mousedown', onDoc, true); };
		const onDoc = (e: MouseEvent) => { if (!menu.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) { close(); } };
		for (const [val, text] of items) {
			const it = append(menu, $('div')); it.textContent = text;
			Object.assign(it.style, { padding: '6px 12px', fontSize: '13px', cursor: 'pointer', borderRadius: '4px', whiteSpace: 'nowrap' });
			it.onmouseenter = () => { it.style.background = 'var(--vscode-menu-selectionBackground, rgba(127,127,127,0.18))'; };
			it.onmouseleave = () => { it.style.background = 'transparent'; };
			it.onclick = () => { close(); void this.exportPaper(val); };
		}
		doc.body.appendChild(menu);
		this.menuEl = menu;
		win?.requestAnimationFrame(() => doc.addEventListener('mousedown', onDoc, true));
	}

	/** Drag the divider to resize the two columns. */
	private wireResize(root: HTMLElement, divider: HTMLElement, right: HTMLElement): void {
		divider.onmousedown = (e: MouseEvent) => {
			e.preventDefault();
			const win = root.ownerDocument.defaultView;
			if (!win) { return; }
			const startX = e.clientX;
			const startW = this.rightWidth;
			const rootW = root.getBoundingClientRect().width;
			const onMove = (ev: MouseEvent) => {
				const w = Math.max(280, Math.min(rootW - 360, startW - (ev.clientX - startX)));
				this.rightWidth = w;
				right.style.width = `${w}px`;
			};
			const onUp = () => { win.removeEventListener('mousemove', onMove); win.removeEventListener('mouseup', onUp); };
			win.addEventListener('mousemove', onMove);
			win.addEventListener('mouseup', onUp);
		};
	}

	private async exportPaper(format: string): Promise<void> {
		if (!this.execId) { return; }
		// Save ALL documents (main + supplementary) in the chosen format - the user
		// may have revised supplementary docs too.
		const saved: string[] = [];
		for (const d of this.docs) {
			try {
				const out = await this.commandService.executeCommand<string>('aria.peerReview.exportPaper', this.execId, format, d.key);
				if (out) { saved.push(out); }
			} catch { /* a document with no text yet - skip it */ }
		}
		if (!saved.length) { this.notificationService.error(localize('aria.peerReview.saveNone', "Nothing to save yet - run the review first.")); return; }
		this.notificationService.info(localize('aria.peerReview.savedN', "Saved {0} document(s) to the review's export/ folder.", saved.length));
	}

	private renderConcernGroup(root: HTMLElement, heading: string, items: { c: Concern; id: string }[], color: string, emptyText: string): void {
		const h = append(root, $('div')); h.textContent = `${heading} (${items.length})`;
		Object.assign(h.style, { fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em', color, margin: '14px 0 8px' });
		if (items.length === 0) {
			const e = append(root, $('div')); e.textContent = emptyText;
			Object.assign(e.style, { fontSize: '13px', opacity: '0.6', fontStyle: 'italic', marginBottom: '6px' });
			return;
		}
		for (const { c, id } of items) {
			const resolved = this.resolved.has(id);
			const rev = this.revisions[id];
			const highlight = !!rev && !resolved;
			const card = append(root, $('div'));
			Object.assign(card.style, {
				border: highlight ? '1px solid var(--vscode-focusBorder, #4c8bf5)' : '1px solid rgba(127,127,127,0.25)',
				borderRadius: '8px', padding: '11px 13px', marginBottom: '10px',
				background: highlight ? 'rgba(76,139,245,0.08)' : 'rgba(127,127,127,0.05)',
				opacity: resolved ? '0.5' : '1',
			});
			const t = append(card, $('div')); t.textContent = c.title;
			Object.assign(t.style, { fontWeight: '600', fontSize: '13.5px', marginBottom: '6px', textDecoration: resolved ? 'line-through' : 'none' });
			const d = append(card, $('div')); d.textContent = c.detail;
			Object.assign(d.style, { fontSize: '12.5px', lineHeight: '1.55', opacity: '0.9' });

			// When a revision is proposed, the edit + Accept/Re-suggest live in the
			// paper on the left. The card just points there and scrolls to it on click.
			if (rev && !resolved) {
				const link = append(card, $('div'));
				Object.assign(link.style, { marginTop: '9px', fontSize: '12px', color: 'var(--vscode-textLink-foreground, #4c8bf5)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px' });
				const ic = append(link, $('span.codicon.codicon-arrow-left')); ic.style.fontSize = '13px';
				const nProps = this.proposalsOf(rev).length;
				const lt = append(link, $('span'));
				lt.textContent = nProps > 1
					? localize('aria.peerReview.seeInPaperN', "{0} revision strategies - review them in the paper", nProps)
					: localize('aria.peerReview.seeInPaper', "Revision proposed - review it in the paper");
				link.onclick = () => void this.focusRevision(id);
				card.style.cursor = 'pointer';
				card.onclick = ev => { if (!(ev.target instanceof HTMLElement) || ev.target.tagName !== 'BUTTON') { void this.focusRevision(id); } };
			}

			// footer: Suggest Revision (left) + Resolved checkbox (right)
			const foot = append(card, $('div'));
			Object.assign(foot.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginTop: '10px' });
			if (!resolved && !rev) {
				foot.appendChild(this.button(localize('aria.peerReview.suggest', "Suggest Revision"), 'ghost', () => void this.sendToChat(this.revisePrompt(id, c))));
			} else {
				const sp = append(foot, $('span')); sp.textContent = ''; sp.style.flex = '1';
			}
			const rc = append(foot, $('div'));
			Object.assign(rc.style, { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', cursor: 'pointer', opacity: '0.85' });
			rc.appendChild(this.checkbox(resolved));
			const cl = append(rc, $('span')); cl.textContent = localize('aria.peerReview.resolved', "Resolved");
			rc.onclick = () => { if (this.resolved.has(id)) { this.resolved.delete(id); } else { this.resolved.add(id); } void this.persistResolved(); this.render(); };
		}
	}

	private async acceptRevision(id: string): Promise<void> {
		const rev = this.revisions[id];
		const dir = this.reviewDir();
		if (!rev || !dir) { return; }
		const props = this.proposalsOf(rev);
		if (!props.length) { return; }
		const p = props[this.selectedIndex(id, props.length)];
		const docKey = rev.documentKey ?? 'main';
		const pp = this.docPathUris(docKey);
		if (!pp) { return; }
		let text = await this.readText(pp.working);
		if (!text.trim()) { text = await this.readText(pp.extracted); }
		if (p.original && text.includes(p.original)) {
			text = text.replace(p.original, p.replacement);
			await this.fileService.writeFile(pp.working, VSBuffer.fromString(text));
			if (docKey === this.activeDoc) { this.paperText = text; }
		} else if (p.original) {
			this.notificationService.warn(localize('aria.peerReview.applyMiss', "Couldn't find the exact original text to replace (the paper may have changed)."));
		}
		if (this.concernById(id)) {
			// concern-tied: keep the concern, mark it resolved (card dims + checks)
			this.resolved.add(id);
			await this.persistResolved();
		} else {
			// standalone (user-requested) edit: it's applied, drop the proposal
			await this.deleteRevision(id);
		}
		this.render();
	}

	private async discardRevision(id: string): Promise<void> {
		await this.deleteRevision(id);
		this.render();
	}
	private async deleteRevision(id: string): Promise<void> {
		const dir = this.reviewDir();
		if (!dir) { return; }
		delete this.revisions[id];
		this.proposalIdx.delete(id);
		this.seenRevs.delete(id);
		await this.fileService.writeFile(joinPath(dir, 'revisions.json'), VSBuffer.fromString(JSON.stringify(this.revisions, null, 2)));
	}

	private async rerun(): Promise<void> {
		const dir = this.reviewDir();
		if (!dir || !this.meta) { return; }
		// Fresh iteration on the current (possibly revised) paper.
		for (const f of ['concerns.json', 'revisions.json', 'state.json']) {
			try { await this.fileService.del(joinPath(dir, f)); } catch { /* may not exist */ }
		}
		this.meta.iteration = (this.meta.iteration ?? 1) + 1;
		await this.fileService.writeFile(joinPath(dir, 'meta.json'), VSBuffer.fromString(JSON.stringify(this.meta, null, 2)));
		this.concerns = undefined; this.revisions = {}; this.resolved = new Set(); this.proposalIdx.clear();
		this.render();
		await this.sendToChat(this.reviewPrompt(this.meta.execId, this.meta.title, this.meta.reviewers));
	}

	private reviewerName(id: string): string { return id === 'claude' ? 'Claude' : id === 'codex' ? 'Codex' : id; }

	override clearInput(): void {
		this.inputStore.clear();
		if (this.menuEl) { this.menuEl.remove(); this.menuEl = undefined; }
		this.execId = undefined; this.meta = undefined; this.concerns = undefined; this.revisions = {}; this.resolved = new Set(); this.proposalIdx.clear(); this.paperText = '';
		super.clearInput();
	}

	override layout(_dimension: Dimension): void { /* columns handle their own scroll */ }
}
