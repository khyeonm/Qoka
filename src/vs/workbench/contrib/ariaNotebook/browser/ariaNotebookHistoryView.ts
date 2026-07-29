/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { applyAriaScrollbar } from '../../aria/browser/ariaScrollbar.js';
import { NotebookModel, PageKind, SnapshotEntry, SnapshotType, ChangedFile } from './ariaNotebookModel.js';

const KIND_ICON: Record<PageKind, string> = {
	overview: 'codicon-book',
	roadmap: 'codicon-map',
	note: 'codicon-note',
	folder: 'codicon-folder',
};

/** The coloured tag shown on each history row, one per event type. Just a small
 *  coloured word (no filled box), per the Qoka UI style. Colours: green = created,
 *  amber = modified, red = deleted, blue = restored. */
const TAG: Record<SnapshotType, { label: string; fg: string }> = {
	create: { label: 'cre', fg: '#3fb950' },
	modify: { label: 'mod', fg: '#c0a000' },
	delete: { label: 'del', fg: '#f85149' },
	restore: { label: 'res', fg: '#4a9eff' },
};

/**
 * The Notebook's version history, rendered as a section INSIDE the Notebook view
 * (below the page tree) rather than as its own activity-bar view, so the tab keeps
 * a single "Notebook" title. It lists every page's auto-saved versions newest
 * first; each row can be Previewed (a readable, colour-diffed view of that version)
 * or Restored (writes it back into the page, after a confirm).
 */
export class NotebookHistorySection {

	constructor(
		private readonly listEl: HTMLElement,
		private readonly getModel: () => NotebookModel | undefined,
		private readonly dialogService: IDialogService,
		private readonly commandService: ICommandService,
	) { }

	/** Snapshot every changed page now (the History "Save" button). Returns whether
	 *  anything new was recorded, then re-renders. */
	async saveNow(): Promise<boolean> {
		const model = this.getModel();
		if (!model) { return false; }
		let any = false;
		for (const page of await model.read()) {
			if (await model.snapshotIfChanged(page)) { any = true; }
		}
		await this.refresh();
		return any;
	}

	async refresh(): Promise<void> {
		clearNode(this.listEl);
		const model = this.getModel();
		if (!model) { return; }

		const pages = await model.read();
		const titles = new Map(pages.map(p => [p.id, p.title]));
		const entries = await model.listAllSnapshots(titles);

		if (!entries.length) {
			const empty = append(this.listEl, $('div'));
			empty.textContent = 'No versions yet. Your edits are saved here automatically as you work.';
			Object.assign(empty.style, { fontSize: '11px', opacity: '0.6', lineHeight: '1.4', padding: '4px 2px' });
			return;
		}
		for (const entry of entries) {
			this.renderRow(model, entry);
		}
	}

	private renderRow(model: NotebookModel, entry: SnapshotEntry): void {
		const isRestore = entry.type === 'restore';
		// A wrapper so a Restored row can reveal its changed-files list beneath itself.
		const wrapper = append(this.listEl, $('div'));

		const row = append(wrapper, $('div'));
		Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 2px', borderRadius: '4px' });
		row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.12))'; actions.style.visibility = 'visible'; });
		row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; actions.style.visibility = 'hidden'; });

		// Restore rows show no kind icon (they span files); a chevron hints they expand.
		if (isRestore) {
			const chevron = append(row, $('span.codicon.codicon-chevron-right')) as HTMLElement;
			Object.assign(chevron.style, { fontSize: '13px', flexShrink: '0', opacity: '0.7' });
			(row as HTMLElement & { _chevron?: HTMLElement })._chevron = chevron;
		} else {
			const icon = append(row, $(`span.codicon.${KIND_ICON[entry.kind]}`)) as HTMLElement;
			Object.assign(icon.style, { fontSize: '13px', flexShrink: '0', opacity: '0.7' });
		}

		// Coloured event tag.
		const tag = TAG[entry.type];
		const badge = append(row, $('span'));
		badge.textContent = tag.label;
		Object.assign(badge.style, {
			flexShrink: '0', fontSize: '9px', fontWeight: '700', letterSpacing: '0.03em', textTransform: 'uppercase',
			color: tag.fg,
		});

		const text = append(row, $('div'));
		Object.assign(text.style, { flex: '1', minWidth: '0' });
		const t1 = append(text, $('div'));
		t1.textContent = isRestore ? this.restoreSummary(entry) : entry.title;
		Object.assign(t1.style, { fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
		const t2 = append(text, $('div'));
		t2.textContent = new Date(entry.takenAt).toLocaleString();
		Object.assign(t2.style, { fontSize: '10px', opacity: '0.6' });

		const actions = append(row, $('div'));
		Object.assign(actions.style, { display: 'flex', gap: '2px', flexShrink: '0', visibility: 'hidden' });

		if (isRestore) {
			// Clicking a Restored row toggles the list of files it changed.
			const expand = append(wrapper, $('div'));
			expand.style.display = 'none';
			this.renderRestoreDetail(expand, entry);
			row.style.cursor = 'pointer';
			row.onclick = () => {
				const open = expand.style.display === 'none';
				expand.style.display = open ? 'block' : 'none';
				const chevron = (row as HTMLElement & { _chevron?: HTMLElement })._chevron;
				chevron?.classList.toggle('codicon-chevron-down', open);
				chevron?.classList.toggle('codicon-chevron-right', !open);
			};
			return;
		}

		const view = append(actions, $('span.codicon.codicon-eye')) as HTMLElement;
		view.title = 'Preview this version';
		Object.assign(view.style, { cursor: 'pointer', opacity: '0.6', padding: '2px' });
		view.onclick = () => void this.previewSnapshot(model, entry);

		const restore = append(actions, $('span.codicon.codicon-discard')) as HTMLElement;
		Object.assign(restore.style, { cursor: 'pointer', opacity: '0.6', padding: '2px' });
		if (entry.type === 'delete') {
			// A deleted file can be brought back (recreated with its last content).
			restore.title = 'Restore this deleted file';
			restore.onclick = () => void this.restoreDeleted(model, entry);
		} else {
			restore.title = 'Restore this version';
			restore.onclick = () => void this.restore(model, entry);
		}
	}

	private restoreSummary(entry: SnapshotEntry): string {
		const n = entry.changed?.length ?? 0;
		const scope = entry.mode === 'all' ? 'all files' : 'one file';
		return `Restored ${scope} (${n} changed)`;
	}

	/** The indented list of files a restore touched, shown when its row is expanded. */
	private renderRestoreDetail(container: HTMLElement, entry: SnapshotEntry): void {
		Object.assign(container.style, { paddingLeft: '22px', paddingBottom: '4px' });
		const changed = entry.changed ?? [];
		if (!changed.length) {
			const none = append(container, $('div'));
			none.textContent = 'No files were changed.';
			Object.assign(none.style, { fontSize: '11px', opacity: '0.6', padding: '2px 0' });
			return;
		}
		for (const f of changed) {
			const line = append(container, $('div'));
			Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0' });
			const icon = append(line, $(`span.codicon.${KIND_ICON[f.kind]}`)) as HTMLElement;
			Object.assign(icon.style, { fontSize: '12px', opacity: '0.7', flexShrink: '0' });
			const name = append(line, $('span'));
			name.textContent = f.title;
			Object.assign(name.style, { fontSize: '11px', flex: '1', minWidth: '0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
			const act = append(line, $('span'));
			act.textContent = f.action === 'deleted' ? 'deleted' : 'reverted';
			Object.assign(act.style, { fontSize: '10px', flexShrink: '0', color: f.action === 'deleted' ? '#f85149' : '#4a9eff' });
		}
	}

	/** Preview a version. A 'modify' colours what changed versus the version it
	 *  replaced (roadmaps node-by-node, notes/overview line-by-line). A 'delete' shows
	 *  the removed content all-red; a 'create' shows the new content all-green. */
	private async previewSnapshot(model: NotebookModel, entry: SnapshotEntry): Promise<void> {
		const raw = await model.readSnapshotContent(entry.uri);
		const curLines = raw === undefined ? [] : snapshotToPlainText(entry.kind, raw).split('\n');

		if (entry.type === 'delete') {
			this.showPreview(entry, curLines.map(text => ({ status: 'del' as const, text })), false);
			return;
		}
		if (entry.type === 'create') {
			this.showPreview(entry, curLines.map(text => ({ status: 'add' as const, text })), false);
			return;
		}

		const prev = await model.previousSnapshotOf(entry);
		const prevRaw = prev ? await model.readSnapshotContent(prev.uri) : undefined;
		const hasPrev = prevRaw !== undefined;

		let blocks: PreviewBlock[];
		if (entry.kind === 'roadmap') {
			blocks = roadmapDiff(prevRaw, raw);
		} else {
			const prevLines = prevRaw === undefined ? undefined : snapshotToPlainText(entry.kind, prevRaw).split('\n');
			blocks = diffLines(prevLines, curLines).map(seg => ({ status: seg.type, text: seg.text }));
		}
		this.showPreview(entry, blocks, hasPrev);
	}

	private showPreview(entry: SnapshotEntry, blocks: PreviewBlock[], hasPrev: boolean): void {
		const doc = this.listEl.ownerDocument;
		const backdrop = doc.createElement('div');
		Object.assign(backdrop.style, {
			position: 'fixed', inset: '0', zIndex: '2000', display: 'flex',
			alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)',
		});
		const card = doc.createElement('div');
		Object.assign(card.style, {
			width: 'min(680px, 86vw)', maxHeight: '78vh', display: 'flex', flexDirection: 'column',
			background: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))',
			border: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.35))', borderRadius: '8px',
			boxShadow: '0 6px 24px rgba(0,0,0,0.4)', color: 'var(--vscode-foreground)',
			fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
		});
		const head = append(card, $('div'));
		Object.assign(head.style, { padding: '12px 14px 8px', borderBottom: '1px solid rgba(127,127,127,0.2)' });
		const h1 = append(head, $('div'));
		h1.textContent = entry.title;
		Object.assign(h1.style, { fontWeight: '600', fontSize: '14px' });
		const when = new Date(entry.takenAt).toLocaleString();
		const h2 = append(head, $('div'));
		h2.textContent = entry.type === 'delete' ? `Deleted ${when} - the content that was removed`
			: entry.type === 'create' ? `Created ${when} - the first version`
				: hasPrev ? `Version from ${when} - highlights show what changed`
					: `Version from ${when} - first version`;
		Object.assign(h2.style, { fontSize: '11px', opacity: '0.6', marginTop: '2px' });

		const bodyEl = append(card, $('div'));
		applyAriaScrollbar(bodyEl);
		Object.assign(bodyEl.style, {
			padding: '10px 14px', overflow: 'auto', wordBreak: 'break-word',
			fontSize: '13px', lineHeight: '1.5', flex: '1', minHeight: '0',
		});
		if (!blocks.length) {
			const empty = append(bodyEl, $('div'));
			empty.textContent = '(This version is empty.)';
			empty.style.opacity = '0.6';
		}
		for (const block of blocks) {
			const line = append(bodyEl, $('div'));
			line.textContent = block.text || ' ';
			Object.assign(line.style, { whiteSpace: 'pre-wrap', padding: '0 4px', borderRadius: '2px', marginBottom: '1px' });
			if (block.status === 'add' || block.status === 'modify') {
				line.style.background = 'rgba(255, 214, 0, 0.28)'; // yellow: added or edited
			} else if (block.status === 'del') {
				line.style.background = 'rgba(255, 82, 82, 0.24)';
				line.style.textDecoration = 'line-through';
				line.style.opacity = '0.8';
			}
		}

		const foot = append(card, $('div'));
		Object.assign(foot.style, { padding: '8px 14px 12px', display: 'flex', justifyContent: 'flex-end', gap: '8px', borderTop: '1px solid rgba(127,127,127,0.2)' });
		const close = append(foot, $('button'));
		close.textContent = 'Close';
		Object.assign(close.style, {
			padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
			border: '1px solid var(--vscode-button-border, transparent)',
			background: 'var(--vscode-button-secondaryBackground, rgba(127,127,127,0.2))',
			color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
		});

		const finish = () => { doc.removeEventListener('keydown', onKey, true); backdrop.remove(); };
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { finish(); } };
		close.onclick = finish;
		backdrop.onclick = (e) => { if (e.target === backdrop) { finish(); } };
		backdrop.appendChild(card);
		doc.body.appendChild(backdrop);
		doc.addEventListener('keydown', onKey, true);
	}

	/** Restore flow: ask whether to roll back just this file or the whole project to
	 *  this point. "All files" additionally asks whether to remove files that were
	 *  created after this point. Non-destructive: current states are saved first. */
	private async restore(model: NotebookModel, entry: SnapshotEntry): Promise<void> {
		const when = new Date(entry.takenAt).toLocaleString();
		const { result } = await this.dialogService.prompt<'single' | 'all' | undefined>({
			type: 'question',
			message: `Restore to the version from ${when}?`,
			detail: `Roll back only "${entry.title}", or every file to how it was at that point? Current content is saved to history first, so you can undo this.`,
			buttons: [
				{ label: 'This file only', run: () => 'single' as const },
				{ label: 'All files', run: () => 'all' as const },
			],
			cancelButton: { label: 'Cancel', run: () => undefined },
		});
		if (!result) { return; }

		if (result === 'single') {
			const r = await model.restoreSingle(entry);
			if (r.result === 'nochange') {
				await this.dialogService.info('Nothing to restore', `"${entry.title}" is already at this version - the later changes were to other files.`);
				return;
			}
			if (r.result === 'restored') { await this.afterRestore([r.changed], []); }
		} else {
			const createdAfter = await model.filesCreatedAfter(entry.takenAt);
			let deletePostT = false;
			if (createdAfter.length) {
				const { confirmed } = await this.dialogService.confirm({
					message: `${createdAfter.length} file(s) were created after this point. Delete them too?`,
					detail: `${createdAfter.map(p => p.title).join(', ')}\n\nEither way, the other files are rolled back to this point.`,
					primaryButton: 'Delete them too',
					cancelButton: 'Keep them',
				});
				deletePostT = confirmed;
			}
			const { changed, deletedPageIds } = await model.restoreAllToPoint(entry.takenAt, deletePostT);
			if (!changed.length && !deletedPageIds.length) {
				await this.dialogService.info('Nothing to restore', 'Every file is already at this point.');
				return;
			}
			await this.afterRestore(changed, deletedPageIds);
		}
		await this.refresh();
	}

	/** Undelete a 'delete' entry: recreate the file, then refresh. */
	private async restoreDeleted(model: NotebookModel, entry: SnapshotEntry): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: `Restore the deleted "${entry.title}"?`,
			detail: 'This recreates the file with the content it had when deleted.',
			primaryButton: 'Restore',
		});
		if (!confirmed) { return; }
		const changed = await model.restoreDeleted(entry);
		// The undeleted content matches the delete snapshot, so no Modified version is
		// re-recorded; still route roadmap reloads through afterRestore.
		await this.afterRestore(changed ? [changed] : [], []);
		await this.refresh();
	}

	/** After writing restored files: refresh editors that don't watch their file.
	 *  Notes and the overview reload themselves; roadmaps are drawn from the roadmap
	 *  extension's in-memory state, so they must be told to re-read from disk. */
	private async afterRestore(changed: ChangedFile[], deletedPageIds: string[]): Promise<void> {
		// A hidden restore baseline (written by the model) already keeps the restored
		// content from being re-recorded as Modified; here we just reload editors.
		for (const f of changed) {
			if (f.kind === 'roadmap' && f.action === 'reverted') {
				try { await this.commandService.executeCommand('aria.roadmap.reloadFromDisk', f.pageId); } catch { /* extension optional */ }
			}
		}
		for (const id of deletedPageIds) {
			try { await this.commandService.executeCommand('aria.roadmap.deleteRoadmap', id); } catch { /* not a roadmap */ }
		}
	}
}

// --- readable text + diff ---------------------------------------------------

interface DiffSegment { type: 'same' | 'add' | 'del'; text: string; }

/** One rendered block in a preview: its text plus how it changed versus the prior
 *  version. 'modify' is used for a roadmap node whose content was edited in place. */
interface PreviewBlock { status: 'same' | 'add' | 'del' | 'modify'; text: string; }

interface RoadmapNode { id: string; column: number; parent?: string | null; label?: string; description?: string; }
interface RoadmapFile { name?: string; columnLabels?: string[]; nodes?: RoadmapNode[]; }

/** Diff two roadmap snapshots node-by-node (matched on node id): a node only in the
 *  new version is 'add' (yellow), only in the old is 'del' (red), and one whose
 *  label or detail changed is 'modify' (yellow). Nodes are grouped by column so the
 *  preview reads top-down like the roadmap itself. When there is no previous version
 *  every node is 'same' (nothing to compare against). */
function roadmapDiff(prevRaw: string | undefined, curRaw: string | undefined): PreviewBlock[] {
	const cur = parseRoadmap(curRaw);
	const prev = prevRaw === undefined ? undefined : parseRoadmap(prevRaw);
	const cols = cur.columnLabels ?? prev?.columnLabels ?? [];
	const blocks: PreviewBlock[] = [];
	const name = cur.name ?? prev?.name;
	if (name && name.trim()) { blocks.push({ status: 'same', text: name.trim() }); }

	const prevById = prev ? new Map((prev.nodes ?? []).map(n => [n.id, n])) : undefined;
	const curIds = new Set((cur.nodes ?? []).map(n => n.id));

	// Current nodes (add / modify / same), then nodes that were deleted, all ordered
	// by column so related items sit together.
	type Tagged = { node: RoadmapNode; status: PreviewBlock['status'] };
	const tagged: Tagged[] = [];
	for (const node of cur.nodes ?? []) {
		const before = prevById?.get(node.id);
		let status: PreviewBlock['status'] = 'same';
		if (prev) {
			if (!before) { status = 'add'; }
			else if ((before.label ?? '') !== (node.label ?? '') || (before.description ?? '') !== (node.description ?? '')) { status = 'modify'; }
		}
		tagged.push({ node, status });
	}
	if (prev) {
		for (const node of prev.nodes ?? []) {
			if (!curIds.has(node.id)) { tagged.push({ node, status: 'del' }); }
		}
	}
	tagged.sort((a, b) => (a.node.column ?? 0) - (b.node.column ?? 0));
	for (const t of tagged) { blocks.push({ status: t.status, text: nodeText(cols, t.node) }); }
	return blocks;
}

function parseRoadmap(raw: string | undefined): RoadmapFile {
	if (raw === undefined) { return {}; }
	try { return JSON.parse(raw) as RoadmapFile; } catch { return {}; }
}

/** A node as one preview block: "Column: label", with its detail indented below. */
function nodeText(columnLabels: string[], node: RoadmapNode): string {
	const col = columnLabels[node.column] ?? `Column ${(node.column ?? 0) + 1}`;
	let text = `${col}: ${node.label ?? ''}`.trimEnd();
	const desc = (node.description ?? '').trim();
	if (desc) { text += `\n    ${desc.replace(/\n/g, '\n    ')}`; }
	return text;
}

/** A unified line diff of `prev` -> `cur` (added lines marked 'add', removed 'del').
 *  When `prev` is undefined (the first version), every line is 'same' - nothing to
 *  compare against, so nothing is highlighted. Uses an LCS so unchanged lines line
 *  up and only genuine insertions/deletions are coloured. */
function diffLines(prev: string[] | undefined, cur: string[]): DiffSegment[] {
	if (!prev) { return cur.map(text => ({ type: 'same' as const, text })); }
	const n = prev.length, m = cur.length;
	// LCS length table.
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i][j] = prev[i] === cur[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const out: DiffSegment[] = [];
	let i = 0, j = 0;
	while (i < n && j < m) {
		if (prev[i] === cur[j]) { out.push({ type: 'same', text: cur[j] }); i++; j++; }
		else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ type: 'del', text: prev[i] }); i++; }
		else { out.push({ type: 'add', text: cur[j] }); j++; }
	}
	while (i < n) { out.push({ type: 'del', text: prev[i++] }); }
	while (j < m) { out.push({ type: 'add', text: cur[j++] }); }
	return out;
}

/** Turn a stored snapshot's content JSON into readable text for the preview, so the
 *  user sees the page roughly as it looked rather than raw JSON. Best-effort: any
 *  shape it doesn't recognise falls back to pretty-printed JSON. */
function snapshotToPlainText(kind: PageKind, contentJson: string): string {
	let obj: unknown;
	try { obj = JSON.parse(contentJson); } catch { return contentJson; }
	try {
		if (kind === 'note') {
			const o = obj as { title?: string; blocks?: unknown[] };
			return [o.title, blocksToText(Array.isArray(o.blocks) ? o.blocks : [])].filter(s => s && s.trim()).join('\n\n');
		}
		if (kind === 'overview') {
			const o = obj as { title?: string; content?: unknown[]; tasks?: Array<{ label?: string; done?: boolean }> };
			const body = blocksToText(Array.isArray(o.content) ? o.content : []);
			const tasks = (o.tasks ?? []).map(t => `[${t.done ? 'x' : ' '}] ${(t.label ?? '').trim()}`).join('\n');
			return [o.title, body, tasks].filter(s => s && s.trim()).join('\n\n');
		}
		if (kind === 'roadmap') {
			const o = obj as RoadmapFile;
			const labels = (o.nodes ?? [])
				.map(node => (node.label ?? '').trim())
				.filter(s => s)
				.map(s => `- ${s}`);
			return [o.name, ...labels].filter(s => s && s.trim()).join('\n');
		}
	} catch { /* fall through to raw JSON */ }
	return JSON.stringify(obj, null, 2);
}

/** Flatten BlockNote-style blocks ({type, props, content:[{text}]}) to plain lines,
 *  prefixing list items and headings so the structure is still legible as text. */
function blocksToText(blocks: unknown[]): string {
	const out: string[] = [];
	for (const b of blocks) {
		const block = b as { type?: string; props?: { checked?: boolean; level?: number }; content?: unknown };
		const text = inlineText(block.content);
		switch (block.type) {
			case 'heading': out.push(`${'#'.repeat(Math.min(block.props?.level ?? 1, 3))} ${text}`); break;
			case 'bulletListItem': out.push(`- ${text}`); break;
			case 'numberedListItem': out.push(`1. ${text}`); break;
			case 'checkListItem': out.push(`[${block.props?.checked ? 'x' : ' '}] ${text}`); break;
			default: out.push(text);
		}
	}
	return out.join('\n');
}

/** Concatenate the text runs of a block's inline content. */
function inlineText(content: unknown): string {
	if (typeof content === 'string') { return content; }
	if (!Array.isArray(content)) { return ''; }
	return content.map(run => {
		const r = run as { text?: string };
		return typeof r.text === 'string' ? r.text : '';
	}).join('');
}
