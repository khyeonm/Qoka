/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { asWebviewUri, webviewGenericCspSource } from '../../webview/common/webview.js';
import { IWebviewElement, IWebviewService } from '../../webview/browser/webview.js';
import { AriaNoteEditorInput } from './ariaNoteEditorInput.js';
import { NoteProposal, PendingCitation, clearNoteProposal, getNoteProposal, onDidProposeNote } from './ariaNotesProposals.js';
import { revealAiProviderChat } from '../../aria/browser/aiProviderChat.js';

const MEDIA_ROOT = FileAccess.asFileUri('vs/workbench/contrib/ariaNotes/browser/media');

/**
 * Editor pane for research notes. Hosts a webview running the bundled BlockNote
 * app (media/notesEditor.js). The note is stored as JSON; the pane loads it into
 * the webview and writes it back (debounced) on edits.
 *
 * When Claude Code proposes an edit (via the aria-notes MCP), the pane enters a
 * read-only REVIEW mode: it shows the proposed content with an Accept/Reject
 * banner and suspends auto-save. Accept commits the proposal to disk; Reject
 * restores the saved note.
 */
export class AriaNoteEditorPane extends EditorPane {

	static readonly ID = AriaNoteEditorInput.EDITOR_ID;

	private container: HTMLElement | undefined;
	private webviewHost: HTMLElement | undefined;
	private banner: HTMLElement | undefined;
	private bannerLabel: HTMLElement | undefined;
	private bannerPickButton: HTMLButtonElement | undefined;
	private bannerAcceptButton: HTMLButtonElement | undefined;
	private readonly webviewStore = this._register(new DisposableStore());
	private webview: IWebviewElement | undefined;

	private currentResource: URI | undefined;
	private pendingBlocks: unknown[] = [];
	private pendingEditable = true;
	private pendingDecorations: ReviewDecorations | undefined;
	private lastBlocks: unknown[] = [];
	private reviewing = false;
	private activeProposal: NoteProposal | undefined;
	private lastSelfWriteAt = 0;
	private readonly saveScheduler = this._register(new RunOnceScheduler(() => void this.save(), 600));

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@ICommandService private readonly commandService: ICommandService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super(AriaNoteEditorPane.ID, group, telemetryService, themeService, storageService);

		// A proposal arriving for the note currently open → enter review.
		this._register(onDidProposeNote(p => {
			if (this.currentResource && p.fileKey === this.currentResource.toString()) {
				this.enterReview(p);
			}
		}));

		// External change to the open note (e.g. Claude create/delete, or accept
		// writing the file) → reload, unless it was our own write or we're mid-review.
		this._register(this.fileService.onDidFilesChange(e => {
			// A paper saved while this note is open changes which [@key] markers
			// resolve, so refresh the webview's citekey map even during a review.
			const lib = this.libraryUri();
			if (lib && e.contains(lib)) {
				void this.sendPapers();
			}
			const r = this.currentResource;
			if (!r || this.reviewing || Date.now() - this.lastSelfWriteAt < 1500) {
				return;
			}
			if (e.contains(r)) {
				void this.reloadFromFile();
			}
		}));
	}

	protected createEditor(parent: HTMLElement): void {
		const container = document.createElement('div');
		container.style.width = '100%';
		container.style.height = '100%';
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.background = 'var(--vscode-editor-background, #1e1e1e)';

		const webviewHost = document.createElement('div');
		webviewHost.style.flex = '1 1 auto';
		webviewHost.style.position = 'relative';
		webviewHost.style.minHeight = '0';
		container.appendChild(webviewHost);
		this.webviewHost = webviewHost;

		// The Accept/Reject bar sits BELOW the note preview so the user reads the
		// (yellow-highlighted) change first, then decides.
		const banner = this.buildBanner();
		container.appendChild(banner);
		this.banner = banner;

		parent.appendChild(container);
		this.container = container;
	}

	private buildBanner(): HTMLElement {
		const bar = document.createElement('div');
		bar.style.display = 'none';
		bar.style.alignItems = 'center';
		bar.style.gap = '10px';
		bar.style.padding = '8px 14px';
		bar.style.flex = '0 0 auto';
		bar.style.background = 'var(--vscode-editorWidget-background, #252526)';
		bar.style.borderTop = '1px solid var(--vscode-focusBorder, #007acc)';
		bar.style.fontFamily = 'var(--vscode-font-family, system-ui, sans-serif)';

		const label = document.createElement('span');
		label.style.fontSize = '12.5px';
		label.style.flex = '1';
		label.style.color = 'var(--vscode-foreground, #ccc)';
		bar.appendChild(label);
		this.bannerLabel = label;

		// Shown only while citations still need a position. Accept stays disabled
		// until then, so the user never approves a preview that is missing part of
		// what the assistant proposed.
		const pick = this.bannerButton(localize('aria.notes.pickCitationLocation', "Pick location"), 'primary', () => void this.resolveNextCitation());
		bar.appendChild(pick);
		this.bannerPickButton = pick;

		const accept = this.bannerButton(localize('aria.notes.accept', "Accept"), 'primary', () => void this.accept());
		bar.appendChild(accept);
		this.bannerAcceptButton = accept;

		bar.appendChild(this.bannerButton(localize('aria.notes.reject', "Reject"), 'ghost', () => void this.reject()));
		return bar;
	}

	/** Citations the staged proposal still needs the user to position. */
	private get pendingCitations(): readonly PendingCitation[] {
		return this.activeProposal?.pendingCitations ?? [];
	}

	private bannerButton(text: string, variant: 'primary' | 'ghost', onclick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.textContent = text;
		btn.style.padding = '4px 12px';
		btn.style.fontSize = '12px';
		btn.style.borderRadius = '4px';
		btn.style.cursor = 'pointer';
		btn.style.fontFamily = 'inherit';
		if (variant === 'primary') {
			btn.style.background = 'var(--vscode-button-background, #0e639c)';
			btn.style.color = 'var(--vscode-button-foreground, #fff)';
			btn.style.border = '1px solid transparent';
		} else {
			btn.style.background = 'transparent';
			btn.style.color = 'var(--vscode-foreground, #ccc)';
			btn.style.border = '1px solid rgba(127,127,127,0.4)';
		}
		btn.addEventListener('click', onclick);
		return btn;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof AriaNoteEditorInput)) {
			return;
		}
		this.currentResource = input.fileResource;
		this.saveScheduler.cancel();

		let blocks: unknown[] = [];
		let title = '';
		try {
			const content = await this.fileService.readFile(input.fileResource);
			const parsed = JSON.parse(content.value.toString());
			blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
			title = typeof parsed.title === 'string' ? parsed.title : '';
		} catch {
			// New / empty note - start blank.
		}
		if (token.isCancellationRequested) {
			return;
		}

		// If Claude already staged a proposal for this note, open in review mode.
		const proposal = getNoteProposal(input.fileResource.toString());
		if (proposal) {
			this.reviewing = true;
			this.activeProposal = proposal;
			// Preview the proposed content diffed against the saved note: additions
			// yellow, removals red + struck. The clean proposal.blocks is written on
			// Accept.
			const review = this.buildReviewDisplay(blocks, proposal.blocks);
			this.pendingBlocks = review.blocks;
			this.pendingDecorations = review.decorations;
			this.pendingEditable = false;
			input.setName(proposal.title || title);
		} else {
			this.reviewing = false;
			this.activeProposal = undefined;
			this.pendingBlocks = blocks;
			this.pendingDecorations = undefined;
			this.pendingEditable = true;
			if (title) { input.setName(title); }
		}
		this.lastBlocks = blocks;
		this.mountWebview();
		this.updateBanner();
	}

	private mountWebview(): void {
		this.webviewStore.clear();
		this.webview = undefined;
		if (!this.webviewHost) {
			return;
		}
		const webview = this.webviewStore.add(this.webviewService.createWebviewElement({
			title: undefined,
			// Keep the service worker - it serves our local bundle (notesEditor.js/.css).
			options: {},
			contentOptions: { allowScripts: true, localResourceRoots: [MEDIA_ROOT] },
			extension: undefined,
		}));
		this.webview = webview;
		webview.mountTo(this.webviewHost, this.window);
		webview.setHtml(this.html());
		this.webviewStore.add(webview.onMessage(e => this.onWebviewMessage(e.message)));
	}

	private onWebviewMessage(message: unknown): void {
		const msg = message as {
			type?: string; blocks?: unknown[]; token?: string;
			id?: string; blockId?: string; offset?: number;
		} | undefined;
		if (!msg) {
			return;
		}
		if (msg.type === 'ready') {
			void this.webview?.postMessage({ type: 'load', blocks: this.pendingBlocks, editable: this.pendingEditable, decorations: this.pendingDecorations });
			void this.sendPapers();
		} else if (msg.type === 'save' && Array.isArray(msg.blocks)) {
			// Ignore saves while previewing a proposal (read-only).
			if (this.reviewing) {
				return;
			}
			this.lastBlocks = msg.blocks;
			this.saveScheduler.schedule();
		} else if (msg.type === 'cite:pick') {
			void this.pickCitation(typeof msg.token === 'string' ? msg.token : '');
		} else if (msg.type === 'cite:locationPicked') {
			if (typeof msg.id === 'string' && typeof msg.blockId === 'string' && typeof msg.offset === 'number') {
				void this.placeCitation(msg.id, msg.blockId, msg.offset);
			}
		} else if (msg.type === 'cite:locationSkipped') {
			if (typeof msg.id === 'string') {
				void this.skipCitation(msg.id);
			}
		}
	}

	/**
	 * `/cite` in the note: choose a paper from the library and send its citekey
	 * back for the webview to drop in at the placeholder it left behind.
	 *
	 * Papers already cited in this note are grouped first because re-citing the
	 * same source is by far the common case in a research note.
	 */
	private async pickCitation(token: string): Promise<void> {
		const cancel = () => void this.webview?.postMessage({ type: 'cite:cancel', token });
		if (this.reviewing) {
			cancel();
			return;
		}
		let papers: { citekey?: string; title?: string; authors?: string[]; year?: number; venue?: string }[] = [];
		try {
			const state = await this.commandService.executeCommand<{ papers?: typeof papers }>('aria.paperSearch.list');
			papers = Array.isArray(state?.papers) ? state!.papers! : [];
		} catch {
			papers = [];
		}
		const citable = papers.filter(p => typeof p.citekey === 'string' && p.citekey);

		const alreadyCited = new Set(citekeysInBlocks(this.lastBlocks));
		type PaperItem = IQuickPickItem & { citekey?: string; askAi?: boolean };
		const toItem = (p: typeof citable[number]): PaperItem => ({
			label: p.title ?? p.citekey!,
			description: p.citekey,
			detail: [
				(p.authors ?? []).slice(0, 3).join(', '),
				p.year ? String(p.year) : '',
				p.venue ?? '',
			].filter(Boolean).join(' · '),
			citekey: p.citekey,
		});

		const items: QuickPickInput<PaperItem>[] = [];
		const cited = citable.filter(p => alreadyCited.has(p.citekey!));
		const rest = citable.filter(p => !alreadyCited.has(p.citekey!));
		if (cited.length) {
			items.push({ type: 'separator', label: localize('aria.notes.citeInThisNote', "In this note") });
			items.push(...cited.map(toItem));
		}
		if (rest.length) {
			items.push({ type: 'separator', label: localize('aria.notes.citeLibrary', "Library") });
			items.push(...rest.map(toItem));
		}
		items.push({ type: 'separator' });
		items.push({
			label: localize('aria.notes.citeAskAi', "Ask the AI to find and cite a paper"),
			detail: localize('aria.notes.citeAskAiDetail', "Not in your library? Ask in the AI chat and it will find the paper, save it, and cite it here."),
			askAi: true,
		});

		const picked = await this.quickInputService.pick<PaperItem>(items, {
			placeHolder: localize('aria.notes.citePlaceholder', "Choose a paper to cite"),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!picked) {
			cancel();
			return;
		}
		if (picked.askAi) {
			cancel();
			// Bring up whichever provider chat the user installed, so "ask the AI"
			// is one click rather than an instruction to go find the chat.
			await revealAiProviderChat(this.commandService, this.configurationService);
			return;
		}
		if (!picked.citekey) {
			cancel();
			return;
		}
		void this.webview?.postMessage({ type: 'cite:insert', token, citekey: picked.citekey });
	}

	private postLoad(blocks: unknown[], editable: boolean, decorations?: ReviewDecorations): void {
		this.pendingBlocks = blocks;
		this.pendingEditable = editable;
		this.pendingDecorations = decorations;
		void this.webview?.postMessage({ type: 'load', blocks, editable, decorations });
	}

	private updateBanner(): void {
		if (!this.banner) { return; }
		this.banner.style.display = this.reviewing ? 'flex' : 'none';
		if (!this.reviewing) { return; }
		const pending = this.pendingCitations;
		if (this.bannerLabel) {
			this.bannerLabel.textContent = pending.length
				? localize(
					'aria.notes.citationsNeedLocation',
					"✦ {0} citation(s) still need a location. Place or skip each one, then Accept.",
					pending.length)
				: localize(
					'aria.notes.proposedBanner',
					"✦ The AI proposed changes - additions in yellow, removals struck through in red. Accept to apply, or Reject to discard.");
		}
		if (this.bannerPickButton) {
			this.bannerPickButton.style.display = pending.length ? '' : 'none';
		}
		if (this.bannerAcceptButton) {
			const blocked = pending.length > 0;
			this.bannerAcceptButton.disabled = blocked;
			this.bannerAcceptButton.style.opacity = blocked ? '0.45' : '1';
			this.bannerAcceptButton.style.cursor = blocked ? 'default' : 'pointer';
			this.bannerAcceptButton.title = blocked
				? localize('aria.notes.acceptBlocked', "Place or skip the remaining citations first.")
				: '';
		}
	}

	// --- citation questions -------------------------------------------------

	/**
	 * Walk the user through the next unplaced citation.
	 *
	 * `ambiguous` has real candidate positions, so it is a pick. `not_found` has
	 * none, so the webview goes into click-to-place mode and the user points at
	 * the spot in the preview - far better than choosing from a list of every
	 * paragraph in a long note.
	 */
	private async resolveNextCitation(): Promise<void> {
		const proposal = this.activeProposal;
		const next = this.pendingCitations[0];
		if (!proposal || !next) { return; }

		if (next.reason === 'ambiguous' && next.candidates?.length) {
			type CandidateItem = IQuickPickItem & { index: number };
			const items: CandidateItem[] = next.candidates.map((candidate, index) => ({
				label: candidate.context,
				description: localize('aria.notes.candidateOrdinal', "occurrence {0}", index + 1),
				index,
			}));
			items.push({ label: localize('aria.notes.skipCitation', "Skip this citation"), index: -1 });
			const picked = await this.quickInputService.pick<CandidateItem>(items, {
				placeHolder: localize(
					'aria.notes.pickOccurrence',
					"Where should [@{0}] go? \"{1}\" occurs {2} times.",
					next.citekey, next.anchor, next.candidates.length),
			});
			if (!picked) { return; }
			if (picked.index < 0) {
				await this.skipCitation(next.id);
				return;
			}
			const target = next.candidates[picked.index];
			await this.placeCitation(next.id, target.blockId, target.offset);
			return;
		}

		// not_found: ask the webview to collect a click position.
		void this.webview?.postMessage({
			type: 'cite:askLocation',
			id: next.id,
			citekey: next.citekey,
			title: next.title,
			anchor: next.anchor,
		});
	}

	private async placeCitation(id: string, blockId: string, offset: number): Promise<void> {
		const filePath = this.activeProposal?.filePath;
		if (!filePath) { return; }
		try {
			await this.commandService.executeCommand('aria.notes.resolveCitationLocation', filePath, id, blockId, offset);
		} catch {
			// The extension re-publishes the proposal on success; a failure just
			// leaves the question open for another try.
		}
	}

	private async skipCitation(id: string): Promise<void> {
		const filePath = this.activeProposal?.filePath;
		if (!filePath) { return; }
		try {
			await this.commandService.executeCommand('aria.notes.skipCitation', filePath, id);
		} catch { /* question stays open */ }
	}

	/** Tell the extension the staged edit is over, so it stops reporting open
	 *  questions and refusing the assistant's next call. */
	private clearStaging(): void {
		const filePath = this.activeProposal?.filePath;
		if (!filePath) { return; }
		try {
			void this.commandService.executeCommand('aria.notes.clearCitationStaging', filePath);
		} catch { /* best-effort */ }
	}

	// --- paper library feed --------------------------------------------------

	/** The project's paper library file, watched so the webview's citekey map does
	 *  not go stale when a paper is saved while a note is open. */
	private libraryUri(): URI | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		return folder ? joinPath(folder.uri, '.qoka', 'references', 'paper-library.json') : undefined;
	}

	/** Push the citable papers into the webview - it needs them for the reference
	 *  list, the hover cards, and to know which `[@key]` markers are real. */
	private async sendPapers(): Promise<void> {
		let papers: unknown[] = [];
		try {
			const state = await this.commandService.executeCommand<{ papers?: unknown[] }>('aria.paperSearch.list');
			papers = Array.isArray(state?.papers) ? state!.papers! : [];
		} catch {
			// Paper library extension not up yet - markers simply stay plain text
			// until the next refresh.
		}
		void this.webview?.postMessage({ type: 'papers:list', papers });
	}

	private enterReview(proposal: NoteProposal): void {
		this.saveScheduler.cancel();
		this.reviewing = true;
		this.activeProposal = proposal;
		if (this.input instanceof AriaNoteEditorInput) {
			this.input.setName(proposal.title || this.input.getName());
		}
		const review = this.buildReviewDisplay(this.lastBlocks, proposal.blocks);
		this.postLoad(review.blocks, false, review.decorations);
		this.updateBanner();
	}

	/**
	 * Builds the read-only preview: a diff of the saved note vs the proposal,
	 * with removed blocks kept in place. Each changed block gets a stable review
	 * id; `decorations` maps that id to 'add' (yellow) or 'del' (red + struck).
	 * The webview applies these as CSS classes by data-id, so the tint works for
	 * ALL block types (tables, images, …) - not just ones with a backgroundColor
	 * prop. Accept writes the clean proposal (no ids, no deletions).
	 */
	private buildReviewDisplay(current: unknown[], proposed: unknown[]): { blocks: unknown[]; decorations: ReviewDecorations } {
		const decorations: ReviewDecorations = {};
		let seq = 0;
		const blocks = diffBlocks(current, proposed).map(op => {
			if (op.kind === 'same') { return op.block; }
			const id = `aria-rev-${seq++}`;
			decorations[id] = op.kind;
			return withReviewId(op.block, id);
		});
		return { blocks, decorations };
	}

	private async accept(): Promise<void> {
		const proposal = this.activeProposal;
		const resource = this.currentResource;
		if (!proposal || !resource) {
			return;
		}
		// Every citation must be placed or skipped first, so what the user approves
		// is exactly what gets written.
		if (proposal.pendingCitations.length) {
			return;
		}
		this.clearStaging();
		const title = proposal.title || deriveTitle(proposal.blocks);
		await this.writeNote(resource, title, proposal.blocks);
		clearNoteProposal(proposal.fileKey);
		this.reviewing = false;
		this.activeProposal = undefined;
		this.lastBlocks = proposal.blocks;
		if (this.input instanceof AriaNoteEditorInput && title) {
			this.input.setName(title);
		}
		this.postLoad(proposal.blocks, true); // now committed + editable
		this.updateBanner();
	}

	private async reject(): Promise<void> {
		const proposal = this.activeProposal;
		const resource = this.currentResource;
		if (!proposal) {
			return;
		}
		this.clearStaging();
		clearNoteProposal(proposal.fileKey);
		this.reviewing = false;
		this.activeProposal = undefined;
		// Restore the saved note.
		let blocks: unknown[] = [];
		if (resource) {
			try {
				const content = await this.fileService.readFile(resource);
				const parsed = JSON.parse(content.value.toString());
				blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
			} catch {
				blocks = [];
			}
		}
		this.lastBlocks = blocks;
		this.postLoad(blocks, true);
		this.updateBanner();
	}

	private async reloadFromFile(): Promise<void> {
		const resource = this.currentResource;
		if (!resource) {
			return;
		}
		let blocks: unknown[] = [];
		let title = '';
		try {
			const content = await this.fileService.readFile(resource);
			const parsed = JSON.parse(content.value.toString());
			blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
			title = typeof parsed.title === 'string' ? parsed.title : '';
		} catch {
			return; // file gone/unreadable - leave current view
		}
		this.lastBlocks = blocks;
		if (this.input instanceof AriaNoteEditorInput && title) {
			this.input.setName(title);
		}
		this.postLoad(blocks, true);
	}

	private async save(): Promise<void> {
		const resource = this.currentResource;
		if (!resource || this.reviewing) {
			return;
		}
		await this.writeNote(resource, deriveTitle(this.lastBlocks), this.lastBlocks);
		if (this.input instanceof AriaNoteEditorInput) {
			this.input.setName(deriveTitle(this.lastBlocks));
		}
	}

	private async writeNote(resource: URI, title: string, blocks: unknown[]): Promise<void> {
		const payload = { version: 1, title: title || 'Untitled', blocks, updatedAt: new Date().toISOString() };
		this.lastSelfWriteAt = Date.now();
		try {
			await this.fileService.writeFile(resource, VSBuffer.fromString(JSON.stringify(payload, null, 2)));
			this.lastSelfWriteAt = Date.now();
		} catch {
			// Disk error - keep the in-webview content; next change retries.
		}
	}

	private html(): string {
		const csp = webviewGenericCspSource;
		const jsUri = asWebviewUri(URI.joinPath(MEDIA_ROOT, 'notesEditor.js')).toString(true);
		const cssUri = asWebviewUri(URI.joinPath(MEDIA_ROOT, 'notesEditor.css')).toString(true);
		return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} https: data: blob:; media-src ${csp} https: blob: data:; font-src ${csp} data:; style-src ${csp} 'unsafe-inline'; style-src-elem ${csp} 'unsafe-inline'; script-src ${csp} 'unsafe-eval'; script-src-elem ${csp};">
<link rel="stylesheet" href="${cssUri}">
<style>
html,body,#root{height:100%;margin:0;padding:0;background:var(--vscode-editor-background);}
/* Review decorations (applied by data-id in the webview app). Highlighter-like
   tints that work for ALL block types - yellow = added, red = removed. */
.aria-review-add{background-color:rgba(255,221,64,0.6) !important;border-radius:3px;}
.aria-review-del{background-color:rgba(255,86,86,0.6) !important;border-radius:3px;text-decoration:line-through;}
.aria-review-del *{text-decoration:line-through;}
/* Tables paint their own cell backgrounds, which would otherwise hide the block
   tint. Clear them so the SINGLE block tint shows through uniformly - tinting the
   cells too would stack alpha and look darker than the rest of the block. */
.aria-review-add table,.aria-review-add th,.aria-review-add td,
.aria-review-del table,.aria-review-del th,.aria-review-del td{background-color:transparent !important;}
</style>
</head>
<body>
<div id="root"></div>
<script src="${jsUri}"></script>
</body>
</html>`;
	}

	override clearInput(): void {
		this.saveScheduler.cancel();
		this.webviewStore.clear();
		this.webview = undefined;
		this.currentResource = undefined;
		this.reviewing = false;
		this.activeProposal = undefined;
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this.webview?.focus();
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}
}

/** Best-effort note title from the first block that carries text. */
function deriveTitle(blocks: unknown[]): string {
	for (const block of blocks) {
		const text = textOf(block);
		if (text) {
			return text.slice(0, 80);
		}
	}
	return 'Untitled';
}

/** Maps a review block id → how it changed. Applied as CSS classes by the webview. */
type ReviewDecorations = Record<string, 'add' | 'del'>;

interface BlockDiffOp { kind: 'same' | 'add' | 'del'; block: unknown; }

/**
 * Line-style diff of two block lists (LCS over a per-block type+text signature),
 * preserving order. `same` blocks are unchanged, `add` are only in `proposed`
 * (new content), `del` are only in `current` (removed content, kept in place so
 * the user sees what disappears). Handles append (tail = add), delete, rewrite.
 */
function diffBlocks(current: unknown[], proposed: unknown[]): BlockDiffOp[] {
	const a = current, b = proposed;
	const n = a.length, m = b.length;
	const sa = a.map(blockSignature), sb = b.map(blockSignature);
	// lcs[i][j] = length of LCS of a[i..] and b[j..]
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i][j] = sa[i] === sb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const ops: BlockDiffOp[] = [];
	let i = 0, j = 0;
	while (i < n && j < m) {
		if (sa[i] === sb[j]) { ops.push({ kind: 'same', block: b[j] }); i++; j++; }
		else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ kind: 'del', block: a[i] }); i++; }
		else { ops.push({ kind: 'add', block: b[j] }); j++; }
	}
	while (i < n) { ops.push({ kind: 'del', block: a[i++] }); }
	while (j < m) { ops.push({ kind: 'add', block: b[j++] }); }
	return ops;
}

function blockSignature(block: unknown): string {
	const b = block as { type?: unknown } | undefined;
	const type = b && typeof b.type === 'string' ? b.type : '?';
	return `${type}|${textOf(block)}`;
}

/** Display-only copy of a block with a known id so the webview can decorate it. */
function withReviewId(block: unknown, id: string): unknown {
	const b = (block ?? {}) as Record<string, unknown>;
	return { ...b, id };
}

/**
 * Citekeys the note already cites, used to float those papers to the top of the
 * `/cite` picker. Deliberately loose (any `[@key]` anywhere in the text): this
 * only affects ordering, so a stray match costs nothing and the exact,
 * code-aware scan stays in the webview where the reference list is built.
 */
function citekeysInBlocks(blocks: unknown[]): string[] {
	const keys: string[] = [];
	const walk = (list: unknown[]): void => {
		for (const raw of list ?? []) {
			const block = raw as { children?: unknown } | undefined;
			if (!block || typeof block !== 'object') { continue; }
			const text = textOf(block);
			const re = /\[([^\]\n]*)\]/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(text)) !== null) {
				for (const part of m[1].split(';')) {
					const at = part.trim().replace(/^-/, '');
					if (!at.startsWith('@')) { continue; }
					const key = /^[A-Za-z0-9_][A-Za-z0-9_:.#$%&+?<>~/-]*/.exec(at.slice(1));
					if (key) { keys.push(key[0]); }
				}
			}
			if (Array.isArray(block.children)) { walk(block.children); }
		}
	};
	walk(blocks);
	return keys;
}

function textOf(block: unknown): string {
	const b = block as { content?: unknown } | undefined;
	if (!b) { return ''; }
	const content = b.content;
	if (typeof content === 'string') {
		return content.trim();
	}
	if (Array.isArray(content)) {
		return content
			.map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
			.join('')
			.trim();
	}
	return '';
}
