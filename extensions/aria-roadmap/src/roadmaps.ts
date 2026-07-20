/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { RoadmapState, RoadmapNode, COLUMN_LABELS } from './state';

/**
 * Multi-roadmap store.
 *
 * A project holds MANY roadmaps - one per hypothesis - each persisted as its own
 * `<workspace>/.aria/roadmaps/<id>.json`. Exactly one roadmap is "active" at a
 * time; the shared `RoadmapState` always mirrors the active roadmap, so every
 * existing MCP tool and workbench command (which operate on that one state)
 * transparently edits whichever roadmap is active. Switching active = reloading
 * the shared state from another file.
 *
 * A roadmap's display name is DERIVED from its first Goal (column-0) node - the
 * hypothesis sentence - so the sidebar can list roadmaps by hypothesis with no
 * separate title to keep in sync. Empty roadmaps show "Untitled roadmap".
 */

export interface RoadmapMeta {
	id: string;
	/** Hypothesis sentence (first Goal node's label), or a placeholder. */
	name: string;
	nodeCount: number;
	updatedAt: number;
}

interface PersistedRoadmap {
	version: number;
	columnLabels: readonly string[];
	nodes: RoadmapNode[];
	updatedAt?: number;
	/** User-set custom name. When present it overrides the hypothesis-derived
	 *  name, so the sidebar and tab show what the user typed. */
	name?: string;
}

const UNTITLED = 'Untitled roadmap';

/** Name derived from the roadmap's first Goal node (the hypothesis sentence). */
export function deriveName(nodes: RoadmapNode[] | undefined): string {
	if (!Array.isArray(nodes)) {
		return UNTITLED;
	}
	const goal = nodes.find(n => n && n.column === 0 && (n.parent === null || n.parent === undefined));
	const label = goal?.label?.trim();
	return label ? label : UNTITLED;
}

/** Display name: an explicit user name wins, else the hypothesis-derived name. */
export function displayName(explicit: string | undefined, nodes: RoadmapNode[] | undefined): string {
	const trimmed = explicit?.trim();
	return trimmed ? trimmed : deriveName(nodes);
}

export class RoadmapStore {

	/** The shared state that mirrors the ACTIVE roadmap. */
	readonly state: RoadmapState;
	private dir: string | undefined;
	activeId: string | undefined;
	/** The active roadmap's explicit name (if the user renamed it), tracked so
	 *  auto-persist doesn't drop it on every node edit. */
	private activeExplicitName: string | undefined;

	constructor(state: RoadmapState, workspaceFsPath: string | undefined) {
		this.state = state;
		this.dir = workspaceFsPath ? path.join(workspaceFsPath, '.qoka', 'roadmaps') : undefined;
	}

	get hasWorkspace(): boolean {
		return !!this.dir;
	}

	private fileFor(id: string): string {
		if (!this.dir) {
			throw new Error('no workspace folder open');
		}
		return path.join(this.dir, `${id}.json`);
	}

	private newId(): string {
		return `r_${crypto.randomBytes(5).toString('hex')}`;
	}

	private ensureDir(): void {
		if (this.dir) {
			fs.mkdirSync(this.dir, { recursive: true });
		}
	}

	/** One-time migration: an older single-roadmap `.aria/roadmap.json` becomes
	 *  the project's first roadmap under `roadmaps/`. The legacy file is left in
	 *  place (harmless) so nothing is destroyed. */
	migrateLegacy(): void {
		if (!this.dir) {
			return;
		}
		try {
			if (fs.existsSync(this.dir) && fs.readdirSync(this.dir).some(f => f.endsWith('.json'))) {
				return; // already have roadmaps/ - nothing to migrate
			}
			const legacy = path.join(path.dirname(this.dir), 'roadmap.json');
			if (!fs.existsSync(legacy)) {
				return;
			}
			const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8')) as PersistedRoadmap;
			if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
				return; // empty legacy roadmap - skip, a fresh one will be created
			}
			this.ensureDir();
			const id = this.newId();
			this.writeFile(id, parsed.nodes);
			console.log(`[aria-roadmap] migrated legacy roadmap.json -> roadmaps/${id}.json`);
		} catch (e) {
			console.warn('[aria-roadmap] legacy migration skipped:', (e as Error).message);
		}
	}

	/** List every roadmap in the project, newest first. */
	list(): RoadmapMeta[] {
		if (!this.dir || !fs.existsSync(this.dir)) {
			return [];
		}
		const metas: RoadmapMeta[] = [];
		for (const file of fs.readdirSync(this.dir)) {
			if (!file.endsWith('.json')) {
				continue;
			}
			const id = file.slice(0, -'.json'.length);
			try {
				const raw = fs.readFileSync(path.join(this.dir, file), 'utf8');
				const parsed = JSON.parse(raw) as PersistedRoadmap;
				const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
				metas.push({
					id,
					name: displayName(parsed.name, nodes),
					nodeCount: nodes.length,
					updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
				});
			} catch {
				// Skip an unreadable roadmap file rather than failing the whole list.
			}
		}
		return metas.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private writeFile(id: string, nodes: RoadmapNode[], name?: string): void {
		this.ensureDir();
		const payload: PersistedRoadmap = {
			version: 1,
			columnLabels: COLUMN_LABELS,
			nodes,
			updatedAt: Date.now(),
			name: name?.trim() || undefined,
		};
		fs.writeFileSync(this.fileFor(id), JSON.stringify(payload, null, 2), 'utf8');
	}

	private readRoadmap(id: string): { nodes: RoadmapNode[]; name: string | undefined } {
		const parsed = JSON.parse(fs.readFileSync(this.fileFor(id), 'utf8')) as PersistedRoadmap;
		return { nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [], name: parsed.name };
	}

	/** Create a new empty roadmap file and return its id. Does NOT switch active. */
	create(): string {
		const id = this.newId();
		this.writeFile(id, []);
		return id;
	}

	/** Persist the shared state to the active roadmap's file, preserving its
	 *  explicit name so a node edit never wipes a user rename. */
	persistActive(): void {
		if (!this.dir || !this.activeId) {
			return;
		}
		try {
			this.writeFile(this.activeId, this.state.snapshot().committed, this.activeExplicitName);
		} catch (e) {
			console.warn('[aria-roadmap] persistActive failed:', (e as Error).message);
		}
	}

	/** Make `id` the active roadmap: persist the current active, then load `id`
	 *  into the shared state. Returns false when the roadmap file is missing. */
	switchActive(id: string): boolean {
		if (!this.dir) {
			return false;
		}
		if (this.activeId === id) {
			return true;
		}
		// Flush the outgoing roadmap first so no edits are lost.
		this.persistActive();
		let roadmap: { nodes: RoadmapNode[]; name: string | undefined };
		try {
			roadmap = this.readRoadmap(id);
		} catch {
			return false;
		}
		this.state.load(roadmap.nodes);
		this.activeExplicitName = roadmap.name;
		this.activeId = id;
		return true;
	}

	/** Set (or clear, with an empty string) a roadmap's explicit name. */
	rename(id: string, name: string): void {
		if (!this.dir) {
			return;
		}
		const clean = name.trim();
		if (id === this.activeId) {
			this.activeExplicitName = clean || undefined;
			this.persistActive();
			return;
		}
		try {
			const roadmap = this.readRoadmap(id);
			this.writeFile(id, roadmap.nodes, clean || undefined);
		} catch (e) {
			console.warn('[aria-roadmap] rename failed:', (e as Error).message);
		}
	}

	/** The active roadmap's display name (explicit rename wins, else hypothesis). */
	activeDisplayName(): string {
		return displayName(this.activeExplicitName, this.state.snapshot().committed);
	}

	/** Ensure some roadmap is active. Picks the newest existing one, or creates a
	 *  fresh empty roadmap when the project has none yet. Returns the active id. */
	ensureActive(): string | undefined {
		if (!this.dir) {
			return undefined;
		}
		if (this.activeId && fs.existsSync(this.fileFor(this.activeId))) {
			return this.activeId;
		}
		const existing = this.list();
		const id = existing.length ? existing[0].id : this.create();
		this.switchActive(id);
		return this.activeId;
	}

	/** Delete a roadmap. If it was active, the newest remaining one (or a fresh
	 *  empty roadmap) becomes active. Returns the new active id. */
	delete(id: string): string | undefined {
		if (!this.dir) {
			return undefined;
		}
		try {
			fs.rmSync(this.fileFor(id), { force: true });
		} catch (e) {
			console.warn('[aria-roadmap] delete failed:', (e as Error).message);
		}
		if (this.activeId === id) {
			this.activeId = undefined;
			this.activeExplicitName = undefined;
			this.state.load([]);
			return this.ensureActive();
		}
		return this.activeId;
	}
}
