/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, $, clearNode } from '../../../../base/browser/dom.js';
import { IAction } from '../../../../base/common/actions.js';
import { IActionViewItem } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IDropdownMenuActionViewItemOptions } from '../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureAriaPaneScrollbarStyle } from '../../ariaSkills/browser/ariaSkillsView.js';
import { renderAriaTabSummary, createAriaHelpTitleActionViewItem } from '../../aria/browser/ariaHelpEditor.js';

/**
 * Paper Library sidebar view. Renders the project's saved papers from
 * <workspace>/references/paper-library.json (per-project). New entries land via
 * Claude Code calling the `save_paper` MCP tool; this view handles browsing,
 * filtering, note editing, tag editing, and delete.
 */

interface PaperLibraryEntry {
	id: string;
	/** How this paper is cited in a research note, as `[@citekey]`. */
	citekey?: string;
	/** Where the metadata came from; `assistant` (or absent) = unverified. */
	metadataSource?: 'crossref' | 'datacite' | 'pubmed' | 'arxiv' | 'assistant';
	title: string;
	authors: string[];
	year: number | undefined;
	venue: string | undefined;
	doi: string | undefined;
	url: string | undefined;
	pdfUrl: string | undefined;
	abstract: string | undefined;
	source: string;
	savedAt: string;
	note: string;
	tags: string[];
}

interface PaperLibraryState {
	papers: PaperLibraryEntry[];
	tags: string[];
}

// --- PDF <-> library cross-linking ------------------------------------------
// The save-paper-pdf skill names files `<short-title>-<first-author>.pdf`. We link
// a file to a library entry by comparing that stem against a normalized key built
// from the entry's title (first words) + first author's last name. Best-effort: an
// unmatched PDF still shows in the "Downloaded PDFs" section as a standalone file.

function tokenize(s: string): string[] {
	return s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
}

/** True if a downloaded PDF filename plausibly belongs to a library entry: the first
 *  author's last name matches (when present) and at least two significant title words
 *  are shared. Token-based, so it is robust to the skill dropping stop-words (with,
 *  the, ...) from the filename. */
function pdfMatchesEntry(fileName: string, p: PaperLibraryEntry): boolean {
	const fileTokens = new Set(tokenize(fileName.replace(/\.[^.]*$/, '')));
	if (fileTokens.size === 0) { return false; }
	const first = (p.authors[0] ?? '').trim();
	const last = (first.split(/\s+/).filter(Boolean).pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
	if (last.length >= 3 && !fileTokens.has(last)) { return false; }
	let shared = 0;
	for (const t of tokenize(p.title)) {
		if (fileTokens.has(t)) { shared++; }
	}
	return shared >= 2;
}

/** A human-readable title for a PDF file with no matching library entry. */
function prettyPdfName(name: string): string {
	return name.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim();
}

export class AriaPaperSearchView extends ViewPane {

	static readonly ID = 'aria.paperSearch.main';

	private viewBody: HTMLElement | undefined;
	private listContainer: HTMLElement | undefined;
	private statsEl: HTMLElement | undefined;
	private tagSelect: HTMLSelectElement | undefined;

	private latestState: PaperLibraryState = { papers: [], tags: [] };
	private searchQuery = '';
	private tagFilter = '';
	private expanded = new Set<string>();
	/** True once the extension command has returned a real state at least
	 *  once. Used to stop the cold-start activation-race retry loop. */
	private loadedOnce = false;

	// Downloaded PDFs live in their own view (AriaDownloadedPdfsView). This view only
	// keeps a light index so a saved paper that has a matching PDF gets an "Open PDF"
	// link on its card.
	/** Library entry id -> its downloaded PDF, for the "Open PDF" link on a card. */
	private pdfByEntryId = new Map<string, URI>();

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// Re-fetch whenever the view becomes visible again (covers reopen and
		// the case where the extension activated after the first empty paint).
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				void this.refresh();
			}
		}));

		// Auto-refresh when the on-disk library changes (a paper saved via the
		// MCP save_paper tool), so new entries appear without a manual refresh.
		void this.setupLibraryWatcher();
	}

	/** Watch the project's library file for external writes (MCP saves) so new
	 *  papers appear without a manual refresh. The library is PER-PROJECT at
	 *  <workspace>/.qoka/references/paper-library.json (matches library.ts in the
	 *  extension); with no folder open it falls back to ~/.config/aria.
	 *  writeLibrary() does a tmp-file + rename, so we watch the containing
	 *  directory to catch the rename rather than the file inode. */
	private async setupLibraryWatcher(): Promise<void> {
		try {
			const folder = this.workspaceContextService.getWorkspace().folders[0];
			const dirUri = folder && folder.uri.scheme === 'file'
				? URI.joinPath(folder.uri, '.qoka', 'references')
				: URI.joinPath(await this.pathService.userHome(), '.config', 'aria');
			const libUri = URI.joinPath(dirUri, 'paper-library.json');
			const pdfsUri = URI.joinPath(dirUri, 'pdfs');
			this._register(this.fileService.watch(dirUri));
			this._register(this.fileService.watch(pdfsUri));
			this._register(this.fileService.onDidFilesChange(e => {
				if (e.contains(libUri)) {
					void this.refresh();
				} else if (e.affects(pdfsUri)) {
					// A PDF was added/removed by the save-paper-pdf skill.
					void this.refreshPdfs();
				}
			}));
		} catch { /* watching is best-effort */ }
	}

	override createActionViewItem(action: IAction, options?: IDropdownMenuActionViewItemOptions): IActionViewItem | undefined {
		// Render the "How to use?" title-bar action as a blue text link.
		return createAriaHelpTitleActionViewItem(action, 'paper-library', options ?? {})
			?? super.createActionViewItem(action, options);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		ensureAriaPaneScrollbarStyle();
		const root = append(container, $('div'));
		root.classList.add('aria-themed-scrollable');
		root.style.padding = '12px';
		root.style.color = 'var(--vscode-foreground)';
		root.style.fontSize = '12px';
		root.style.boxSizing = 'border-box';
		root.style.overflowY = 'auto';
		root.style.overflowX = 'hidden';
		this.viewBody = root;

		// Full-width one-line summary under the title bar (below the "How to use?"
		// link). The refresh icon sits at the right end of this summary row.
		const summaryActions = renderAriaTabSummary(root, 'paper-library');
		if (summaryActions) {
			const refreshBtn = append(summaryActions, $('span.codicon.codicon-refresh')) as HTMLElement;
			refreshBtn.title = 'Refresh';
			refreshBtn.style.cursor = 'pointer';
			refreshBtn.style.opacity = '0.75';
			refreshBtn.style.padding = '2px 4px';
			refreshBtn.onclick = () => { void this.refresh(); };
		}

		// Filter toolbar.
		const toolbar = append(root, $('div'));
		toolbar.style.display = 'flex';
		toolbar.style.flexDirection = 'column';
		toolbar.style.gap = '6px';
		toolbar.style.marginBottom = '10px';

		const searchInput = append(toolbar, $('input')) as HTMLInputElement;
		searchInput.type = 'search';
		searchInput.placeholder = 'Search saved papers...';
		this.styleInput(searchInput);
		searchInput.oninput = () => {
			this.searchQuery = searchInput.value;
			this.renderList();
		};

		const tagSelect = append(toolbar, $('select')) as HTMLSelectElement;
		this.styleInput(tagSelect);
		const allOpt = append(tagSelect, $('option')) as HTMLOptionElement;
		allOpt.value = '';
		allOpt.textContent = 'All tags';
		tagSelect.onchange = () => {
			this.tagFilter = tagSelect.value;
			this.renderList();
		};
		this.tagSelect = tagSelect;

		// Stats row - "N papers" / "N of M filtered". (Refresh moved up to the
		// summary row, at the right of the one-line description.)
		const statsRow = append(root, $('div'));
		statsRow.style.display = 'flex';
		statsRow.style.alignItems = 'center';
		statsRow.style.gap = '6px';
		statsRow.style.margin = '0 0 8px 0';

		const stats = append(statsRow, $('div'));
		stats.style.fontSize = '11px';
		stats.style.opacity = '0.65';
		stats.style.flex = '1';
		stats.style.minWidth = '0';
		this.statsEl = stats;

		// Papers list container (clearNode-able - two levels deep).
		const list = append(root, $('div'));
		list.style.display = 'flex';
		list.style.flexDirection = 'column';
		list.style.gap = '8px';
		this.listContainer = list;

		void this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.viewBody) {
			this.viewBody.style.height = `${height}px`;
			this.viewBody.style.width = `${width}px`;
		}
	}

	private async refresh(attempt = 0): Promise<void> {
		let state: PaperLibraryState | undefined;
		try {
			state = await this.commandService.executeCommand<PaperLibraryState>('aria.paperSearch.list');
		} catch { /* extension still booting */ }
		if (state) {
			this.latestState = state;
			this.loadedOnce = true;
		} else if (!this.loadedOnce && attempt < 20 && !this._store.isDisposed) {
			// Cold start: the aria-paper-search extension has not activated yet,
			// so its `aria.paperSearch.list` command is not registered. Retry
			// briefly (up to ~10s) until it comes up, instead of leaving the
			// view showing "No papers saved yet." for the whole session.
			setTimeout(() => { void this.refresh(attempt + 1); }, 500);
		}
		this.syncTagOptions();
		this.renderList();
		void this.refreshPdfs();
	}

	/** The <workspace>/.qoka/references/pdfs directory, or undefined off-disk. */
	private pdfsDirUri(): URI | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return undefined;
		}
		// Any scheme (file / remote) - fileService.resolve handles both.
		return URI.joinPath(folder.uri, '.qoka', 'references', 'pdfs');
	}

	/** Scan the PDFs folder and index which saved papers have a matching PDF, so the
	 *  paper cards can show an "Open PDF" link. The PDF list itself lives in the
	 *  separate Downloaded PDFs view. */
	private async refreshPdfs(): Promise<void> {
		const dir = this.pdfsDirUri();
		const files: { name: string; uri: URI }[] = [];
		if (dir) {
			try {
				const stat = await this.fileService.resolve(dir);
				for (const child of stat.children ?? []) {
					if (!child.isDirectory && child.name.toLowerCase().endsWith('.pdf')) {
						files.push({ name: child.name, uri: child.resource });
					}
				}
			} catch { /* folder may not exist yet - no PDFs */ }
		}
		this.pdfByEntryId = new Map();
		for (const f of files) {
			const entry = this.latestState.papers.find(p => pdfMatchesEntry(f.name, p));
			if (entry) { this.pdfByEntryId.set(entry.id, f.uri); }
		}
		// Repaint cards so linked papers show their "Open PDF" link.
		this.renderList();
	}

	private syncTagOptions(): void {
		const sel = this.tagSelect;
		if (!sel) {
			return;
		}
		const previous = this.tagFilter;
		clearNode(sel);
		const allOpt = append(sel, $('option')) as HTMLOptionElement;
		allOpt.value = '';
		allOpt.textContent = 'All tags';
		for (const t of this.latestState.tags) {
			const o = append(sel, $('option')) as HTMLOptionElement;
			o.value = t;
			o.textContent = t;
			if (t === previous) {
				o.selected = true;
			}
		}
		if (!this.latestState.tags.includes(previous)) {
			this.tagFilter = '';
		}
	}

	private filteredPapers(): PaperLibraryEntry[] {
		const q = this.searchQuery.trim().toLowerCase();
		return this.latestState.papers.filter(p => {
			if (this.tagFilter && !p.tags.some(t => t.toLowerCase() === this.tagFilter.toLowerCase())) {
				return false;
			}
			if (q) {
				const hay = [p.title, p.authors.join(' '), p.abstract ?? '', p.venue ?? '', p.note, p.tags.join(' ')]
					.join(' ').toLowerCase();
				if (!hay.includes(q)) {
					return false;
				}
			}
			return true;
		});
	}

	private renderList(): void {
		const container = this.listContainer;
		if (!container) {
			return;
		}
		clearNode(container);

		const papers = this.filteredPapers();
		const total = this.latestState.papers.length;
		if (this.statsEl) {
			if (total === 0) {
				this.statsEl.textContent = '';
			} else if (papers.length === total) {
				this.statsEl.textContent = `${total} paper(s) in your library`;
			} else {
				this.statsEl.textContent = `${papers.length} of ${total} paper(s) match the filter`;
			}
		}

		if (total === 0) {
			const empty = append(container, $('div'));
			empty.textContent = 'No papers saved yet.';
			empty.style.padding = '20px';
			empty.style.textAlign = 'center';
			empty.style.opacity = '0.6';
			empty.style.fontSize = '12px';
			empty.style.background = 'rgba(127, 127, 127, 0.05)';
			empty.style.border = '1px dashed rgba(127, 127, 127, 0.25)';
			empty.style.borderRadius = '4px';
			return;
		}
		if (papers.length === 0) {
			const empty = append(container, $('div'));
			empty.textContent = 'No papers match the current filter.';
			empty.style.padding = '20px';
			empty.style.textAlign = 'center';
			empty.style.opacity = '0.6';
			empty.style.fontSize = '12px';
			return;
		}

		for (const p of papers) {
			this.renderPaperCard(container, p);
		}
	}

	private renderPaperCard(parent: HTMLElement, paper: PaperLibraryEntry): void {
		const card = append(parent, $('div'));
		card.style.background = 'var(--vscode-editorWidget-background, rgba(127,127,127,0.06))';
		card.style.border = '1px solid var(--vscode-panel-border, rgba(127,127,127,0.18))';
		card.style.borderRadius = '4px';
		card.style.padding = '10px';
		card.style.display = 'flex';
		card.style.flexDirection = 'column';
		card.style.gap = '4px';

		// Title - clickable to expand details.
		const titleEl = append(card, $('div'));
		titleEl.style.fontWeight = '600';
		titleEl.style.fontSize = '12.5px';
		titleEl.style.lineHeight = '1.4';
		titleEl.style.cursor = 'pointer';
		titleEl.textContent = paper.title;
		titleEl.title = 'Click to expand / collapse';
		titleEl.onclick = () => {
			if (this.expanded.has(paper.id)) {
				this.expanded.delete(paper.id);
			} else {
				this.expanded.add(paper.id);
			}
			this.renderList();
		};

		// Cross-link: if a downloaded PDF matches this paper, offer to open it.
		const pdfUri = this.pdfByEntryId.get(paper.id);
		if (pdfUri) {
			const openPdf = append(card, $('a')) as HTMLElement;
			openPdf.textContent = 'Open PDF';
			openPdf.style.fontSize = '11px';
			openPdf.style.color = 'var(--vscode-textLink-foreground)';
			openPdf.style.cursor = 'pointer';
			openPdf.style.width = 'fit-content';
			openPdf.onclick = (e) => { e.stopPropagation(); void this.openerService.open(pdfUri, { openExternal: true }); };
		}

		// Meta line - Authors et al. · Venue · Year.
		const meta = append(card, $('div'));
		meta.style.fontSize = '11px';
		meta.style.opacity = '0.75';
		const parts: string[] = [];
		if (paper.authors.length > 0) {
			parts.push(paper.authors.length > 3
				? `${paper.authors.slice(0, 3).join(', ')} et al.`
				: paper.authors.join(', '));
		}
		if (paper.venue) {
			parts.push(paper.venue);
		}
		if (paper.year !== undefined) {
			parts.push(String(paper.year));
		}
		meta.textContent = parts.join(' · ');

		// Papers whose metadata is still the assistant's transcription: the author
		// list or the year may be wrong in ways that look complete, so say so
		// rather than presenting them as equal to a publisher-sourced record.
		const unverified = !paper.metadataSource || paper.metadataSource === 'assistant';
		if (unverified) {
			const warn = append(card, $('div'));
			warn.style.display = 'flex';
			warn.style.alignItems = 'center';
			warn.style.gap = '6px';
			warn.style.fontSize = '10.5px';
			warn.style.opacity = '0.7';
			const label = append(warn, $('span'));
			label.textContent = paper.doi
				? 'Details not verified with the publisher yet'
				: 'Details not verified (no DOI to check against)';
			if (paper.doi) {
				const verifyBtn = append(warn, $('a')) as HTMLElement;
				verifyBtn.textContent = 'Verify now';
				verifyBtn.style.cursor = 'pointer';
				verifyBtn.style.color = 'var(--vscode-textLink-foreground)';
				verifyBtn.onclick = async (e) => {
					e.stopPropagation();
					label.textContent = 'Checking…';
					try { await this.commandService.executeCommand('aria.paperSearch.resolveNow', paper.id); } catch { /* stays unverified */ }
					await this.refresh();
				};
			}
		}

		// Action row - Details (toggle expansion) + Delete. The title is
		// also clickable, but a dedicated Details button is easier to
		// discover for users who don't realize the title is the toggle.
		const actions = append(card, $('div'));
		actions.style.display = 'flex';
		actions.style.gap = '4px';
		actions.style.marginTop = '4px';

		const expanded = this.expanded.has(paper.id);
		const detailsBtn = append(actions, $('button')) as HTMLButtonElement;
		detailsBtn.textContent = expanded ? 'Hide details' : 'Details';
		this.styleSecondaryButton(detailsBtn);
		detailsBtn.onclick = (e) => {
			e.stopPropagation();
			if (this.expanded.has(paper.id)) {
				this.expanded.delete(paper.id);
			} else {
				this.expanded.add(paper.id);
			}
			this.renderList();
		};

		const deleteBtn = append(actions, $('button')) as HTMLButtonElement;
		deleteBtn.textContent = 'Delete';
		deleteBtn.style.background = 'transparent';
		deleteBtn.style.color = 'rgb(220, 100, 100)';
		deleteBtn.style.border = '1px solid rgba(220, 100, 100, 0.4)';
		deleteBtn.style.padding = '3px 9px';
		deleteBtn.style.borderRadius = '3px';
		deleteBtn.style.cursor = 'pointer';
		deleteBtn.style.fontSize = '10.5px';
		deleteBtn.style.fontFamily = 'inherit';
		deleteBtn.onclick = (e) => {
			e.stopPropagation();
			void this.confirmDelete(paper);
		};

		// Expanded details.
		if (expanded) {
			this.renderExpandedDetails(card, paper);
		}
	}

	private renderExpandedDetails(card: HTMLElement, paper: PaperLibraryEntry): void {
		const details = append(card, $('div'));
		details.style.marginTop = '6px';
		details.style.paddingTop = '6px';
		details.style.borderTop = '1px solid rgba(127, 127, 127, 0.18)';
		details.style.display = 'flex';
		details.style.flexDirection = 'column';
		details.style.gap = '6px';
		details.style.fontSize = '11.5px';

		if (paper.doi) {
			const doiRow = append(details, $('div'));
			doiRow.style.display = 'flex';
			doiRow.style.alignItems = 'center';
			doiRow.style.gap = '6px';
			const label = append(doiRow, $('span'));
			label.style.opacity = '0.6';
			label.textContent = 'DOI:';
			const value = append(doiRow, $('span'));
			value.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
			value.textContent = paper.doi;
			value.style.flex = '1';
			value.style.minWidth = '0';
			value.style.overflow = 'hidden';
			value.style.textOverflow = 'ellipsis';
			value.style.whiteSpace = 'nowrap';
			// Overlapping-squares copy icon (codicon-copy), kept inside the row so it
			// never overflows past the panel edge.
			const copyBtn = append(doiRow, $('span.codicon.codicon-copy')) as HTMLElement;
			copyBtn.title = 'Copy DOI';
			copyBtn.style.cursor = 'pointer';
			copyBtn.style.opacity = '0.7';
			copyBtn.style.flexShrink = '0';
			copyBtn.onclick = (e) => {
				e.stopPropagation();
				void this.commandService.executeCommand('aria.paperSearch.copyToClipboard', paper.doi);
			};
		}

		// Tags row with add affordance.
		const tagsRow = append(details, $('div'));
		tagsRow.style.display = 'flex';
		tagsRow.style.flexWrap = 'wrap';
		tagsRow.style.alignItems = 'center';
		tagsRow.style.gap = '4px';
		const tagLabel = append(tagsRow, $('span'));
		tagLabel.style.opacity = '0.6';
		tagLabel.textContent = 'Tags:';
		for (const tag of paper.tags) {
			const pill = append(tagsRow, $('span'));
			pill.style.padding = '1px 6px';
			pill.style.borderRadius = '8px';
			pill.style.fontSize = '10.5px';
			pill.style.background = 'rgba(127, 127, 127, 0.18)';
			pill.style.cursor = 'pointer';
			pill.title = 'Click to remove';
			pill.textContent = tag;
			pill.onclick = (e) => {
				e.stopPropagation();
				const next = paper.tags.filter(t => t !== tag);
				void this.commandService.executeCommand('aria.paperSearch.updateTags', paper.id, next);
				paper.tags = next;
				this.renderList();
			};
		}
		const addTagBtn = append(tagsRow, $('button')) as HTMLButtonElement;
		addTagBtn.textContent = '+ Add tag';
		this.styleSecondaryButton(addTagBtn);
		addTagBtn.onclick = (e) => {
			e.stopPropagation();
			void this.addTag(paper);
		};

		// Note section - sits below Tags. Layout depends on whether a
		// note already exists:
		//   no note  →  Note: [+ Add note]
		//   has note →  Note:
		//                ┌──────────────────────────┐
		//                │ italic note body         │
		//                └──────────────────────────┘
		//                [✎ Edit note]
		// The button label flips automatically once the user saves
		// their first note (Add → Edit), matching the user's request.
		const noteSection = append(details, $('div'));
		noteSection.style.display = 'flex';
		noteSection.style.flexDirection = 'column';
		noteSection.style.gap = '4px';
		noteSection.style.marginTop = '2px';

		const noteLabel = append(noteSection, $('span'));
		noteLabel.style.opacity = '0.6';
		noteLabel.textContent = 'Note:';

		if (paper.note) {
			const noteBody = append(noteSection, $('div'));
			noteBody.style.opacity = '0.85';
			noteBody.style.fontStyle = 'italic';
			noteBody.style.background = 'rgba(127, 127, 127, 0.06)';
			noteBody.style.padding = '6px 8px';
			noteBody.style.borderRadius = '3px';
			noteBody.style.whiteSpace = 'pre-wrap';
			noteBody.textContent = paper.note;
		}

		const noteBtn = append(noteSection, $('button')) as HTMLButtonElement;
		noteBtn.style.alignSelf = 'flex-start';
		this.styleSecondaryButton(noteBtn);
		if (paper.note) {
			noteBtn.style.display = 'inline-flex';
			noteBtn.style.alignItems = 'center';
			noteBtn.style.gap = '4px';
			const editIcon = append(noteBtn, $('span.codicon.codicon-edit')) as HTMLElement;
			editIcon.style.fontSize = '11px';
			const txt = append(noteBtn, $('span'));
			txt.textContent = 'Edit note';
		} else {
			noteBtn.textContent = '+ Add note';
		}
		noteBtn.onclick = (e) => {
			e.stopPropagation();
			void this.editNote(paper);
		};
	}

	private async editNote(paper: PaperLibraryEntry): Promise<void> {
		// Defer to the extension - workbench code can't call
		// vscode.window directly, so we let the aria-paper-search
		// extension show the input box and persist the result. We
		// refresh after to pick up the new note.
		await this.commandService.executeCommand('aria.paperSearch.promptAndUpdateNote', paper.id);
		void this.refresh();
	}

	private async addTag(paper: PaperLibraryEntry): Promise<void> {
		await this.commandService.executeCommand('aria.paperSearch.promptAndAddTag', paper.id);
		void this.refresh();
	}

	private async confirmDelete(paper: PaperLibraryEntry): Promise<void> {
		await this.commandService.executeCommand('aria.paperSearch.confirmAndDelete', paper.id);
		void this.refresh();
	}

	private styleInput(el: HTMLInputElement | HTMLSelectElement): void {
		el.style.background = 'var(--vscode-input-background)';
		el.style.color = 'var(--vscode-input-foreground)';
		el.style.border = '1px solid var(--vscode-input-border, transparent)';
		el.style.padding = '4px 8px';
		el.style.fontSize = '12px';
		el.style.borderRadius = '3px';
		el.style.fontFamily = 'inherit';
	}

	private styleSecondaryButton(btn: HTMLButtonElement): void {
		btn.style.background = 'transparent';
		btn.style.color = 'var(--vscode-foreground)';
		btn.style.border = '1px solid var(--vscode-button-border, var(--vscode-foreground))';
		btn.style.padding = '3px 9px';
		btn.style.borderRadius = '3px';
		btn.style.cursor = 'pointer';
		btn.style.fontSize = '10.5px';
		btn.style.fontFamily = 'inherit';
		btn.style.opacity = '0.85';
	}
}

/**
 * "Downloaded PDFs" - a SEPARATE view in the Paper Library container (like the
 * Analysis tab's Changes / Snapshots), so it is a real collapsible + drag-resizable
 * section. Lists the actual PDF files under <workspace>/.qoka/references/pdfs/ (written
 * by the save-paper-pdf skill), each cross-linked to its library entry by filename.
 */
export class AriaDownloadedPdfsView extends ViewPane {

	static readonly ID = 'aria.paperSearch.downloadedPdfs';

	private viewBody: HTMLElement | undefined;
	private listContainer: HTMLElement | undefined;
	private statsEl: HTMLElement | undefined;
	private papers: PaperLibraryEntry[] = [];
	private pdfFiles: { name: string; uri: URI }[] = [];

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.onDidChangeBodyVisibility(visible => { if (visible) { void this.refresh(); } }));
		void this.setupWatcher();
	}

	private pdfsDirUri(): URI | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) { return undefined; }
		return URI.joinPath(folder.uri, '.qoka', 'references', 'pdfs');
	}

	private async setupWatcher(): Promise<void> {
		try {
			const dir = this.pdfsDirUri();
			if (!dir) { return; }
			this._register(this.fileService.watch(dir));
			this._register(this.fileService.onDidFilesChange(e => { if (e.affects(dir)) { void this.refresh(); } }));
		} catch { /* best-effort */ }
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		ensureAriaPaneScrollbarStyle();
		const root = append(container, $('div'));
		root.classList.add('aria-themed-scrollable');
		root.style.padding = '12px';
		root.style.color = 'var(--vscode-foreground)';
		root.style.fontSize = '12px';
		root.style.boxSizing = 'border-box';
		root.style.overflowY = 'auto';
		root.style.overflowX = 'hidden';
		this.viewBody = root;

		const stats = append(root, $('div'));
		stats.style.fontSize = '11px';
		stats.style.opacity = '0.65';
		stats.style.marginBottom = '8px';
		this.statsEl = stats;

		const list = append(root, $('div'));
		list.style.display = 'flex';
		list.style.flexDirection = 'column';
		list.style.gap = '6px';
		this.listContainer = list;

		void this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.viewBody) { this.viewBody.style.height = `${height}px`; this.viewBody.style.width = `${width}px`; }
	}

	private async refresh(): Promise<void> {
		try {
			const state = await this.commandService.executeCommand<{ papers: PaperLibraryEntry[] }>('aria.paperSearch.list');
			if (state?.papers) { this.papers = state.papers; }
		} catch { /* extension still booting */ }
		const dir = this.pdfsDirUri();
		const files: { name: string; uri: URI }[] = [];
		if (dir) {
			try {
				const stat = await this.fileService.resolve(dir);
				for (const child of stat.children ?? []) {
					if (!child.isDirectory && child.name.toLowerCase().endsWith('.pdf')) {
						files.push({ name: child.name, uri: child.resource });
					}
				}
			} catch { /* no folder yet - no PDFs */ }
		}
		files.sort((a, b) => a.name.localeCompare(b.name));
		this.pdfFiles = files;
		this.renderPdfList();
	}

	private renderPdfList(): void {
		const container = this.listContainer;
		if (!container) { return; }
		clearNode(container);
		if (this.statsEl) { this.statsEl.textContent = this.pdfFiles.length ? `${this.pdfFiles.length} PDF(s)` : ''; }
		if (!this.pdfFiles.length) {
			const empty = append(container, $('div'));
			empty.textContent = 'No PDFs downloaded yet.';
			empty.style.padding = '16px';
			empty.style.textAlign = 'center';
			empty.style.opacity = '0.6';
			empty.style.fontSize = '12px';
			empty.style.background = 'rgba(127, 127, 127, 0.05)';
			empty.style.border = '1px dashed rgba(127, 127, 127, 0.25)';
			empty.style.borderRadius = '4px';
			return;
		}
		for (const f of this.pdfFiles) {
			const entry = this.papers.find(p => pdfMatchesEntry(f.name, p));
			const row = append(container, $('div'));
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.gap = '8px';
			row.style.padding = '6px 8px';
			row.style.borderRadius = '4px';
			row.style.cursor = 'pointer';
			row.style.background = 'var(--vscode-editorWidget-background, rgba(127,127,127,0.06))';
			row.style.border = '1px solid var(--vscode-panel-border, rgba(127,127,127,0.18))';

			const icon = append(row, $('span.codicon.codicon-file')) as HTMLElement;
			icon.style.opacity = '0.7';
			icon.style.flexShrink = '0';

			const name = append(row, $('div'));
			name.textContent = entry ? entry.title : prettyPdfName(f.name);
			name.style.flex = '1';
			name.style.minWidth = '0';
			name.style.overflow = 'hidden';
			name.style.textOverflow = 'ellipsis';
			name.style.whiteSpace = 'nowrap';
			name.style.fontSize = '12px';

			const badge = append(row, $('span'));
			badge.textContent = entry ? 'in library' : 'PDF only';
			badge.style.fontSize = '10px';
			badge.style.opacity = '0.55';
			badge.style.flexShrink = '0';

			row.title = 'Open PDF';
			row.onclick = () => { void this.openerService.open(f.uri, { openExternal: true }); };
		}
	}
}
