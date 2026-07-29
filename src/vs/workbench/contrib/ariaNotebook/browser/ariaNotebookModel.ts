/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { generateUuid } from '../../../../base/common/uuid.js';

/**
 * The Notebook is the project's single tree of PAGES. It unifies what used to be
 * three separate tabs - Project Overview, Roadmap and Notes - into one place: the
 * Overview is the fixed root, and Roadmaps and Notes hang off it (or off folders).
 *
 * A page carries only its identity and place in the tree; the CONTENT lives
 * wherever that page kind already stores it, so existing editors keep working:
 *   - overview -> <project>/.qoka/notebook/overview.json  (one, the root)
 *   - roadmap  -> <project>/.qoka/roadmaps/<id>.json       (the existing store)
 *   - note     -> <project>/.qoka/notebook/notes/<id>.md
 *   - folder   -> no content, just groups children
 *
 * The tree itself is persisted at <project>/.qoka/notebook/index.json.
 */

export type PageKind = 'overview' | 'roadmap' | 'note' | 'folder';

export interface NotebookPage {
	id: string;
	kind: PageKind;
	title: string;
	/** Parent page id, or null for a top-level page. The overview root has null. */
	parent: string | null;
	/** Sort order among siblings (ascending). */
	order: number;
}

interface NotebookIndex {
	version: number;
	pages: NotebookPage[];
}

const INDEX_VERSION = 1;
export const OVERVIEW_PAGE_ID = 'overview';

/** Storage + tree operations for the notebook index. Stateless: every call reads
 *  or writes the JSON on disk, so the sidebar and any future editor stay in sync
 *  through the file watcher rather than a shared in-memory model. */
export class NotebookModel {

	constructor(
		private readonly folder: URI,
		private readonly fileService: IFileService,
	) { }

	static indexUri(folder: URI): URI {
		return joinPath(folder, '.qoka', 'notebook', 'index.json');
	}

	static notesDir(folder: URI): URI {
		return joinPath(folder, '.qoka', 'notebook', 'notes');
	}

	static roadmapsDir(folder: URI): URI {
		return joinPath(folder, '.qoka', 'notebook', 'roadmaps');
	}

	static noteUri(folder: URI, id: string): URI {
		// A BlockNote document (same JSON shape the Research Note editor uses), so a
		// notebook note opens in that rich editor rather than as raw text.
		return joinPath(NotebookModel.notesDir(folder), `${id}.json`);
	}

	static snapshotsDir(folder: URI): URI {
		return joinPath(folder, '.qoka', 'notebook', 'snapshots');
	}

	static overviewUri(folder: URI): URI {
		return joinPath(folder, '.qoka', 'notebook', 'overview.json');
	}

	/**
	 * One-time layout migration: the overview and roadmaps used to live directly under
	 * `.qoka/` (`.qoka/overview.json`, `.qoka/roadmaps/`); they now sit under
	 * `.qoka/notebook/` with the notes/index/snapshots. Move any old files into the
	 * new location. Idempotent (only moves when the new target does not yet exist), so
	 * it is safe to run from several places / on every start. Never throws.
	 */
	static async migrateLayout(folder: URI, fileService: IFileService): Promise<void> {
		const move = async (from: URI, to: URI) => {
			try {
				if (!(await fileService.exists(from)) || await fileService.exists(to)) { return; }
				await fileService.createFolder(joinPath(folder, '.qoka', 'notebook'));
				await fileService.move(from, to, false);
			} catch { /* best-effort - a partially-moved layout still reads via the new paths */ }
		};
		await move(joinPath(folder, '.qoka', 'overview.json'), NotebookModel.overviewUri(folder));
		await move(joinPath(folder, '.qoka', 'roadmaps'), NotebookModel.roadmapsDir(folder));
	}

	/** The content file that backs a page, or undefined for folders (no content).
	 *  Snapshots copy THIS file, and restore writes back into it. */
	private contentUri(page: NotebookPage): URI | undefined {
		switch (page.kind) {
			case 'overview': return NotebookModel.overviewUri(this.folder);
			case 'roadmap': return joinPath(NotebookModel.roadmapsDir(this.folder), `${page.id}.json`);
			case 'note': return NotebookModel.noteUri(this.folder, page.id);
			case 'folder': return undefined;
		}
	}

	private get indexUri(): URI {
		return NotebookModel.indexUri(this.folder);
	}

	/**
	 * The page tree, DISCOVERED from disk and overlaid with the saved structure.
	 *
	 * Discovery is what makes the MCP tools "just work": a roadmap or note created
	 * by Claude/Codex lands in its own store (`.qoka/roadmaps/*.json`,
	 * `.qoka/notebook/notes/*.json`) and shows up here automatically - the sidebar
	 * never has to be told. index.json only records ORGANISATION (each page's
	 * parent/order, plus folder pages), so a page present on disk but missing from
	 * the index appears under the Overview root by default.
	 *
	 * Never throws - a missing/corrupt index degrades to plain discovery.
	 */
	async read(): Promise<NotebookPage[]> {
		// 1) Saved structure (organisation overlay).
		const saved = new Map<string, NotebookPage>();
		try {
			const raw = (await this.fileService.readFile(this.indexUri)).value.toString();
			const parsed = JSON.parse(raw) as Partial<NotebookIndex>;
			for (const p of parsed.pages ?? []) { saved.set(p.id, p); }
		} catch { /* no index yet */ }

		const pages: NotebookPage[] = [];
		const seen = new Set<string>();
		// `contentTitle` is derived from the page's CONTENT (first line of a note, first
		// Goal of a roadmap). It becomes the shown title unless the user set an explicit
		// name via rename - so a fresh "Untitled" page auto-titles itself as soon as the
		// first text is typed.
		const add = (id: string, kind: PageKind, contentTitle: string) => {
			if (seen.has(id)) { return; }
			seen.add(id);
			const s = saved.get(id);
			pages.push({
				id, kind,
				title: NotebookModel.resolveTitle(kind, s?.title, contentTitle),
				parent: s ? s.parent : (id === OVERVIEW_PAGE_ID ? null : OVERVIEW_PAGE_ID),
				order: s?.order ?? Number.MAX_SAFE_INTEGER,
			});
		};

		// 2) The fixed Overview root.
		add(OVERVIEW_PAGE_ID, 'overview', '');

		// 3) Discover roadmaps and notes from their stores.
		for (const { id, title } of await this.discover(NotebookModel.roadmapsDir(this.folder), 'roadmap')) {
			add(id, 'roadmap', title);
		}
		for (const { id, title } of await this.discover(NotebookModel.notesDir(this.folder), 'note')) {
			add(id, 'note', title);
		}

		// 4) Folders (and any structural-only pages) that live only in the index.
		for (const p of saved.values()) {
			if (!seen.has(p.id)) { add(p.id, p.kind, ''); }
		}
		return pages;
	}

	/** The title to show for a page: an explicit (non-placeholder) rename wins; else the
	 *  content-derived title; else a per-kind placeholder. */
	static resolveTitle(kind: PageKind, indexTitle: string | undefined, contentTitle: string): string {
		const idx = (indexTitle ?? '').trim();
		if (kind === 'overview') { return idx || 'Project Overview'; }
		if (kind === 'folder') { return idx || 'New folder'; }
		const explicit = idx && !NotebookModel.isPlaceholderTitle(idx) ? idx : '';
		return explicit || contentTitle.trim() || (kind === 'note' ? 'Untitled note' : 'Untitled roadmap');
	}

	private static isPlaceholderTitle(title: string): boolean {
		const s = title.trim().toLowerCase();
		return s === '' || s === 'untitled' || s === 'untitled note' || s === 'untitled roadmap';
	}

	/** List `<dir>/*.json` as {id, title}, where `title` is derived from the file's
	 *  CONTENT (roadmap: explicit name or first Goal; note: first non-empty line).
	 *  Returns [] when the dir is absent. Never throws. */
	private async discover(dir: URI, kind: 'roadmap' | 'note'): Promise<{ id: string; title: string }[]> {
		let stat;
		try { stat = await this.fileService.resolve(dir); } catch { return []; }
		const out: { id: string; title: string }[] = [];
		for (const child of stat.children ?? []) {
			if (child.isDirectory || !child.name.endsWith('.json')) { continue; }
			const id = child.name.slice(0, -'.json'.length);
			let title = '';
			try {
				const doc = JSON.parse((await this.fileService.readFile(child.resource)).value.toString());
				title = kind === 'roadmap' ? NotebookModel.roadmapContentTitle(doc) : NotebookModel.noteContentTitle(doc);
			} catch { /* unreadable - fall back to placeholder */ }
			out.push({ id, title });
		}
		return out;
	}

	/** A roadmap's title from its file: an explicit name, else its first Goal node. */
	private static roadmapContentTitle(doc: unknown): string {
		const o = doc as { name?: string; nodes?: Array<{ column?: number; label?: string }> };
		const name = (o.name ?? '').trim();
		if (name) { return name; }
		const nodes = Array.isArray(o.nodes) ? o.nodes : [];
		const goal = nodes.find(n => n.column === 0) ?? nodes[0];
		return (goal?.label ?? '').trim().slice(0, 80);
	}

	/** A note's title from its file: an explicit (non-placeholder) title, else the
	 *  first non-empty line of its blocks. */
	private static noteContentTitle(doc: unknown): string {
		const o = doc as { title?: string; blocks?: unknown[] };
		const title = (o.title ?? '').trim();
		if (title && !NotebookModel.isPlaceholderTitle(title)) { return title.slice(0, 80); }
		const blocks = Array.isArray(o.blocks) ? o.blocks : [];
		for (const b of blocks) {
			const text = NotebookModel.blockText(b).trim();
			if (text) { return text.slice(0, 80); }
		}
		return '';
	}

	/** Concatenate the text runs of one BlockNote block. */
	private static blockText(block: unknown): string {
		const content = (block as { content?: unknown }).content;
		if (typeof content === 'string') { return content; }
		if (!Array.isArray(content)) { return ''; }
		return content.map(run => typeof (run as { text?: string }).text === 'string' ? (run as { text?: string }).text : '').join('');
	}

	private async write(pages: NotebookPage[]): Promise<void> {
		const body = JSON.stringify({ version: INDEX_VERSION, pages }, null, 2) + '\n';
		await this.fileService.writeFile(this.indexUri, VSBuffer.fromString(body));
	}

	/** Add a page under `parent` (or top level) and return it. A fresh uuid is
	 *  minted for its id. Roadmap/note content files are created by the caller. */
	async addPage(kind: Exclude<PageKind, 'overview' | 'roadmap'>, title: string, parent: string | null): Promise<NotebookPage> {
		return this.addPageWithId(generateUuid(), kind, title, parent);
	}

	/** Add a page whose id is chosen by the caller. Used for roadmap pages, whose
	 *  id must match the roadmap file in the existing roadmap store. */
	async addPageWithId(id: string, kind: Exclude<PageKind, 'overview'>, title: string, parent: string | null): Promise<NotebookPage> {
		const pages = await this.read();
		const siblings = pages.filter(p => p.parent === parent);
		const order = siblings.length ? Math.max(...siblings.map(p => p.order)) + 1 : 0;
		const page: NotebookPage = { id, kind, title, parent, order };
		pages.push(page);
		await this.write(pages);
		return page;
	}

	/**
	 * Move `id` under `newParent`, inserting it BEFORE `beforeSiblingId` (or at the
	 * end of the new parent's children when that is undefined / not found). Sibling
	 * orders are re-numbered densely so the requested position is exact. The
	 * Overview root cannot be moved.
	 */
	async movePage(id: string, newParent: string | null, beforeSiblingId?: string): Promise<void> {
		if (id === OVERVIEW_PAGE_ID) { return; }
		const pages = await this.read();
		const page = pages.find(p => p.id === id);
		if (!page) { return; }
		page.parent = newParent;
		const siblings = pages.filter(p => p.parent === newParent && p.id !== id)
			.sort((a, b) => a.order - b.order);
		const beforeIdx = beforeSiblingId ? siblings.findIndex(p => p.id === beforeSiblingId) : -1;
		const insertAt = beforeIdx >= 0 ? beforeIdx : siblings.length;
		siblings.splice(insertAt, 0, page);
		siblings.forEach((p, i) => { p.order = i; });
		await this.write(pages);
	}

	async renamePage(id: string, title: string): Promise<void> {
		const pages = await this.read();
		const page = pages.find(p => p.id === id);
		if (!page || page.id === OVERVIEW_PAGE_ID) { return; }
		page.title = title;
		await this.write(pages);
	}

	/** Remove a page and all its descendants from the tree. Content files are left
	 *  for the caller to delete (so a mis-click can be undone at the file level). */
	async removePage(id: string): Promise<string[]> {
		if (id === OVERVIEW_PAGE_ID) { return []; }
		const pages = await this.read();
		const removed = new Set<string>();
		const collect = (pid: string) => {
			removed.add(pid);
			for (const child of pages.filter(p => p.parent === pid)) { collect(child.id); }
		};
		collect(id);
		await this.write(pages.filter(p => !removed.has(p.id)));
		return [...removed];
	}

	/** Ensure a note's BlockNote document exists (empty) so opening it never 404s.
	 *  Matches the payload shape the Research Note editor writes. */
	async ensureNoteFile(id: string, title: string): Promise<URI> {
		const uri = NotebookModel.noteUri(this.folder, id);
		try {
			await this.fileService.stat(uri);
		} catch {
			const payload = { version: 1, title, blocks: [] as unknown[], updatedAt: new Date().toISOString() };
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(payload, null, 2)));
		}
		return uri;
	}

	// --- snapshots (version history) ---------------------------------------

	/** Directory name (a reserved, non-page id) holding multi-file restore events. */
	private static readonly EVENTS_DIR_NAME = '_events';

	private snapshotPageDir(pageId: string): URI {
		return joinPath(NotebookModel.snapshotsDir(this.folder), pageId);
	}

	private eventsDir(): URI {
		return joinPath(NotebookModel.snapshotsDir(this.folder), NotebookModel.EVENTS_DIR_NAME);
	}

	/** Newest stored snapshot content for a page, or undefined when it has none.
	 *  Used to skip taking a snapshot identical to the last one. */
	private async latestSnapshotContent(pageId: string): Promise<string | undefined> {
		const snaps = await this.listPageSnapshots(pageId);
		if (!snaps.length) { return undefined; }
		return this.readSnapshotContent(snaps[0].uri);
	}

	/** Keys that carry no user-visible meaning - only timestamps / transient AI state
	 *  - so a save that changes ONLY these must not count as a new version. */
	private static readonly VOLATILE_KEYS = new Set(['updatedAt', 'checkedAt', 'proposedAt', 'savedAt', 'modifiedAt', 'pendingCompletions']);

	/** A stable comparison key: strips volatile fields anywhere in the tree and sorts
	 *  object keys, so a save that only bumps a timestamp (every autosave does) or
	 *  reorders keys is NOT treated as a change. Without this, History fills with
	 *  near-identical versions whose diff is empty. Array order is preserved (it is
	 *  content order). */
	private static changeKey(content: string): string {
		try {
			return JSON.stringify(NotebookModel.canonicalize(JSON.parse(content)));
		} catch { return content; }
	}

	private static canonicalize(value: unknown): unknown {
		if (Array.isArray(value)) { return value.map(v => NotebookModel.canonicalize(v)); }
		if (value && typeof value === 'object') {
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(value as Record<string, unknown>).sort()) {
				if (NotebookModel.VOLATILE_KEYS.has(key)) { continue; }
				out[key] = NotebookModel.canonicalize((value as Record<string, unknown>)[key]);
			}
			return out;
		}
		return value;
	}

	/** Snapshot a page's current content IFF it differs meaningfully from its last
	 *  snapshot (ignoring timestamp-only changes). The very first snapshot of a page
	 *  is tagged 'create', later ones 'modify'. Returns true when a new snapshot was
	 *  written. Never throws. */
	async snapshotIfChanged(page: NotebookPage): Promise<boolean> {
		const contentUri = this.contentUri(page);
		if (!contentUri) { return false; }
		let content: string;
		try {
			content = (await this.fileService.readFile(contentUri)).value.toString();
		} catch { return false; }              // no content yet - nothing to snapshot
		const snaps = await this.listPageSnapshots(page.id);
		const last = snaps.length ? await this.readSnapshotContent(snaps[0].uri) : undefined;
		if (last !== undefined && NotebookModel.changeKey(content) === NotebookModel.changeKey(last)) { return false; }
		// First-ever version of a page is a creation; anything after is a modification.
		const hasPriorContent = snaps.some(s => s.type !== 'delete');
		const type: Exclude<SnapshotType, 'restore'> = hasPriorContent ? 'modify' : 'create';
		return this.writeSnapshot({ takenAt: new Date().toISOString(), type, pageId: page.id, kind: page.kind, title: page.title, content });
	}

	private async writeSnapshot(snap: SnapshotFile): Promise<boolean> {
		const file = joinPath(this.snapshotPageDir(snap.pageId), `${snap.takenAt.replace(/[:.]/g, '-')}.json`);
		try {
			await this.fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(snap, null, 2)));
			return true;
		} catch { return false; }
	}

	/** Record that a page was deleted, capturing its last content so the History
	 *  entry can preview what was removed. Called just BEFORE the files are deleted. */
	async recordDelete(page: NotebookPage): Promise<void> {
		const contentUri = this.contentUri(page);
		let content = '';
		if (contentUri) {
			try { content = (await this.fileService.readFile(contentUri)).value.toString(); } catch { /* already gone */ }
		}
		await this.writeSnapshot({ takenAt: new Date().toISOString(), type: 'delete', pageId: page.id, kind: page.kind, title: page.title, content, parent: page.parent });
	}

	/** All snapshots for one page, newest first. Legacy snapshots without a `type`
	 *  read back as 'modify'. */
	private async listPageSnapshots(pageId: string): Promise<SnapshotEntry[]> {
		let stat;
		try { stat = await this.fileService.resolve(this.snapshotPageDir(pageId)); } catch { return []; }
		const out: SnapshotEntry[] = [];
		for (const child of stat.children ?? []) {
			if (child.isDirectory || !child.name.endsWith('.json')) { continue; }
			try {
				const meta = JSON.parse((await this.fileService.readFile(child.resource)).value.toString()) as SnapshotFile;
				out.push({ uri: child.resource, type: meta.type ?? 'modify', pageId, kind: meta.kind, title: meta.title, takenAt: meta.takenAt });
			} catch { /* skip unreadable */ }
		}
		out.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
		return out;
	}

	/** Every stored restore event, newest first. */
	private async listRestoreEvents(): Promise<SnapshotEntry[]> {
		let stat;
		try { stat = await this.fileService.resolve(this.eventsDir()); } catch { return []; }
		const out: SnapshotEntry[] = [];
		for (const child of stat.children ?? []) {
			if (child.isDirectory || !child.name.endsWith('.json')) { continue; }
			try {
				const ev = JSON.parse((await this.fileService.readFile(child.resource)).value.toString()) as RestoreEventFile;
				out.push({ uri: child.resource, type: 'restore', takenAt: ev.takenAt, pageId: '', kind: 'folder', title: 'Restored', mode: ev.mode, changed: ev.changed });
			} catch { /* skip unreadable */ }
		}
		return out;
	}

	/** Every page's snapshots plus restore events, merged and sorted newest-first -
	 *  the data behind the Notebook's History panel. `titles` maps live page ids to
	 *  their current title so an entry shows the page's present name even if renamed. */
	async listAllSnapshots(titles: Map<string, string>): Promise<SnapshotEntry[]> {
		let stat;
		try { stat = await this.fileService.resolve(NotebookModel.snapshotsDir(this.folder)); } catch { return []; }
		const all: SnapshotEntry[] = [];
		for (const dir of stat.children ?? []) {
			if (!dir.isDirectory || dir.name === NotebookModel.EVENTS_DIR_NAME) { continue; }
			for (const e of await this.listPageSnapshots(dir.name)) {
				if (e.type === 'restore') { continue; }   // hidden baseline, not a visible version
				all.push({ ...e, title: titles.get(e.pageId) ?? e.title });
			}
		}
		all.push(...await this.listRestoreEvents());
		all.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
		return all;
	}

	/** The content-bearing snapshot taken immediately BEFORE `entry` for the same page,
	 *  or undefined when `entry` is that page's first version. Used to diff a version
	 *  against the state it replaced, so the preview can colour what changed. */
	async previousSnapshotOf(entry: SnapshotEntry): Promise<SnapshotEntry | undefined> {
		const snaps = await this.listPageSnapshots(entry.pageId); // newest first
		const i = snaps.findIndex(s => s.uri.toString() === entry.uri.toString());
		if (i < 0) { return undefined; }
		return snaps.slice(i + 1).find(s => s.type !== 'delete');
	}

	/** The stored content JSON of a snapshot (for preview). */
	async readSnapshotContent(uri: URI): Promise<string | undefined> {
		try {
			return (JSON.parse((await this.fileService.readFile(uri)).value.toString()) as SnapshotFile).content;
		} catch { return undefined; }
	}

	private async writeRestoreEvent(mode: 'single' | 'all', targetTakenAt: string, changed: ChangedFile[]): Promise<void> {
		const takenAt = new Date().toISOString();
		const ev: RestoreEventFile = { takenAt, type: 'restore', mode, targetTakenAt, changed };
		const file = joinPath(this.eventsDir(), `${takenAt.replace(/[:.]/g, '-')}.json`);
		try { await this.fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(ev, null, 2))); } catch { /* best-effort */ }
	}

	/** Roll ONE page back to the version in `entry` (non-destructive: the current
	 *  state is snapshotted first, and a Restored event is recorded).
	 *  Returns 'nochange' when the file is ALREADY at that version (nothing to undo -
	 *  the changes that stacked on top were to other files), 'failed' on error, or the
	 *  changed page on success so the caller can refresh its editor. */
	async restoreSingle(entry: SnapshotEntry): Promise<{ result: 'restored'; changed: ChangedFile } | { result: 'nochange' } | { result: 'failed' }> {
		const pages = await this.read();
		const page = pages.find(p => p.id === entry.pageId);
		const contentUri = page ? this.contentUri(page) : undefined;
		if (!page || !contentUri) { return { result: 'failed' }; }
		const content = await this.readSnapshotContent(entry.uri);
		if (content === undefined) { return { result: 'failed' }; }
		// No-op guard: if the file's current content already equals this version, there
		// is nothing to restore - tell the caller so it can say so instead of writing
		// an identical file and a meaningless Restored entry.
		let current: string | undefined;
		try { current = (await this.fileService.readFile(contentUri)).value.toString(); } catch { /* missing - treat as a real restore */ }
		if (current !== undefined && NotebookModel.changeKey(current) === NotebookModel.changeKey(content)) {
			return { result: 'nochange' };
		}
		await this.snapshotIfChanged(page);   // capture "before restore" so it can be undone
		try {
			await this.fileService.writeFile(contentUri, VSBuffer.fromString(content));
		} catch { return { result: 'failed' }; }
		await this.writeBaseline(page, content); // so the restored content isn't re-recorded as Modified
		const changed: ChangedFile = { pageId: page.id, kind: page.kind, title: page.title, action: 'reverted' };
		await this.writeRestoreEvent('single', entry.takenAt, [changed]);
		return { result: 'restored', changed };
	}

	/** A hidden 'restore' baseline: marks the restored content as the current version
	 *  so the next auto/manual save sees no change (no spurious Modified entry). */
	private async writeBaseline(page: NotebookPage, content: string): Promise<void> {
		await this.writeSnapshot({ takenAt: new Date().toISOString(), type: 'restore', pageId: page.id, kind: page.kind, title: page.title, content });
	}

	/** Undelete: recreate a page that a 'delete' entry recorded, writing its last
	 *  content back and re-adding it to the tree in its original place. */
	async restoreDeleted(entry: SnapshotEntry): Promise<ChangedFile | undefined> {
		if (entry.type !== 'delete') { return undefined; }
		let file: SnapshotFile;
		try { file = JSON.parse((await this.fileService.readFile(entry.uri)).value.toString()) as SnapshotFile; }
		catch { return undefined; }
		const parent = file.parent ?? OVERVIEW_PAGE_ID;
		const page: NotebookPage = { id: entry.pageId, kind: entry.kind, title: entry.title, parent, order: 0 };
		const contentUri = this.contentUri(page);
		if (!contentUri) { return undefined; }
		try { await this.fileService.writeFile(contentUri, VSBuffer.fromString(file.content)); }
		catch { return undefined; }
		await this.recreateInIndex(entry.pageId, entry.kind, entry.title, parent);
		const changed: ChangedFile = { pageId: entry.pageId, kind: entry.kind, title: entry.title, action: 'reverted' };
		await this.writeRestoreEvent('single', entry.takenAt, [changed]);
		return changed;
	}

	/** Ensure the tree index lists page `id` under `parent` (dropping any stale entry
	 *  for it first), appended after its siblings. Used by undelete. */
	private async recreateInIndex(id: string, kind: PageKind, title: string, parent: string | null): Promise<void> {
		const pages = (await this.read()).filter(p => p.id !== id);
		const siblings = pages.filter(p => p.parent === parent);
		const order = siblings.length ? Math.max(...siblings.map(p => p.order)) + 1 : 0;
		pages.push({ id, kind, title, parent, order });
		await this.write(pages);
	}

	/** Pages whose content was CREATED after `targetTakenAt` (no snapshot at or before
	 *  that time) - the files that did not yet exist at the restore point. */
	async filesCreatedAfter(targetTakenAt: string): Promise<NotebookPage[]> {
		const out: NotebookPage[] = [];
		for (const page of await this.read()) {
			if (!this.contentUri(page)) { continue; }               // folders have no content
			const snaps = await this.listPageSnapshots(page.id);
			if (snaps.length && !snaps.some(s => s.takenAt <= targetTakenAt)) { out.push(page); }
		}
		return out;
	}

	/**
	 * Roll the WHOLE project back to the state at `targetTakenAt`: every page with a
	 * snapshot at or before that time is reverted to its newest such version. Pages
	 * created afterwards are left untouched, UNLESS `deletePostT` is set, in which
	 * case they are recorded-then-deleted. Non-destructive for reverts (each current
	 * state is snapshotted first). Returns what changed, for editor/extension cleanup.
	 */
	async restoreAllToPoint(targetTakenAt: string, deletePostT: boolean): Promise<{ changed: ChangedFile[]; deletedPageIds: string[] }> {
		const changed: ChangedFile[] = [];
		const deletedPageIds: string[] = [];
		for (const page of await this.read()) {
			const contentUri = this.contentUri(page);
			if (!contentUri) { continue; }                          // folders
			const snaps = await this.listPageSnapshots(page.id);    // newest first
			const target = snaps.find(s => s.takenAt <= targetTakenAt && s.type !== 'delete');
			if (target) {
				const targetContent = await this.readSnapshotContent(target.uri);
				let current: string | undefined;
				try { current = (await this.fileService.readFile(contentUri)).value.toString(); } catch { /* missing */ }
				if (targetContent !== undefined && (current === undefined || NotebookModel.changeKey(current) !== NotebookModel.changeKey(targetContent))) {
					await this.snapshotIfChanged(page);
					try { await this.fileService.writeFile(contentUri, VSBuffer.fromString(targetContent)); } catch { continue; }
					await this.writeBaseline(page, targetContent);
					changed.push({ pageId: page.id, kind: page.kind, title: page.title, action: 'reverted' });
				}
			} else if (deletePostT && snaps.length) {
				// Created after the restore point and the user chose to remove such files.
				await this.recordDelete(page);
				try { await this.fileService.del(contentUri); } catch { /* already gone */ }
				await this.removePage(page.id);
				deletedPageIds.push(page.id);
				changed.push({ pageId: page.id, kind: page.kind, title: page.title, action: 'deleted' });
			}
		}
		// Only record a Restored event when something actually changed - if every file
		// was already at this point, there is nothing to show.
		if (changed.length) { await this.writeRestoreEvent('all', targetTakenAt, changed); }
		return { changed, deletedPageIds };
	}
}

/** How a history entry came to be. 'create'/'modify'/'delete' describe a single
 *  page's content file; 'restore' is a multi-file operation stored on its own. */
export type SnapshotType = 'create' | 'modify' | 'delete' | 'restore';

/** One file touched by a restore, for the expandable list under a Restored entry. */
export interface ChangedFile {
	pageId: string;
	kind: PageKind;
	title: string;
	/** 'reverted' = content rolled back; 'deleted' = a later-created file removed. */
	action: 'reverted' | 'deleted';
}

interface SnapshotFile {
	takenAt: string;
	/** Absent on pre-existing snapshots; treated as 'modify' when reading them back.
	 *  A per-page 'restore' snapshot is a hidden BASELINE written right after a restore
	 *  so the next auto/manual save sees no change and does not re-record the restored
	 *  content as a Modified version. Baselines are used for comparison but not shown. */
	type?: SnapshotType;
	pageId: string;
	kind: PageKind;
	title: string;
	content: string;
	/** Where the page sat in the tree - stored on 'delete' events so an undelete can
	 *  recreate it in its original place. */
	parent?: string | null;
}

interface RestoreEventFile {
	takenAt: string;
	type: 'restore';
	mode: 'single' | 'all';
	/** The point-in-time the project was rolled back to. */
	targetTakenAt: string;
	changed: ChangedFile[];
}

export interface SnapshotEntry {
	uri: URI;
	type: SnapshotType;
	takenAt: string;
	// create / modify / delete: the single page this version belongs to.
	pageId: string;
	kind: PageKind;
	title: string;
	// restore only:
	mode?: 'single' | 'all';
	changed?: ChangedFile[];
}
