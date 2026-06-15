/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';

/**
 * Shared types + the state-change signal for the New Project Roadmap
 * Wizard, which now renders as a real workbench editor (AriaRoadmapEditorPane)
 * instead of a full-viewport DOM overlay.
 *
 * The aria-roadmap extension owns the authoritative state and pushes a
 * fresh Snapshot after every mutation by invoking the workbench command
 * `aria.roadmap.workbench.onStateChange`. The contribution that handles
 * that command re-broadcasts via `notifyRoadmapStateChanged`, and the
 * open editor pane re-renders. Decoupling the command sink from the pane
 * through this module-level emitter mirrors the ariaVcs `onDidChangeSnapshots`
 * pattern and means the pane never has to register itself with the
 * contribution.
 */

/** URI scheme for the wizard's synthetic editor input. The Started overlay
 *  watches for an open editor with this scheme to know the wizard is up. */
export const ROADMAP_SCHEME = 'aria-roadmap';

export interface RoadmapNode {
	id: string;
	column: number;
	parent: string | null;
	label: string;
	description?: string;
	status?: 'todo' | 'in_progress' | 'done';
}

export interface RoadmapProposal {
	id: string;
	column: number;
	parent: string | null;
	label: string;
	description?: string;
	proposedAt: number;
}

export interface Snapshot {
	columnLabels: readonly string[];
	committed: RoadmapNode[];
	proposed: RoadmapProposal[];
	finalized: boolean;
}

export function isSnapshot(value: unknown): value is Snapshot {
	if (!value || typeof value !== 'object') { return false; }
	const v = value as Record<string, unknown>;
	return Array.isArray(v.committed) && Array.isArray(v.proposed) && Array.isArray(v.columnLabels);
}

const _onDidChangeRoadmapState = new Emitter<Snapshot>();
export const onDidChangeRoadmapState: Event<Snapshot> = _onDidChangeRoadmapState.event;

export function notifyRoadmapStateChanged(snapshot: Snapshot): void {
	_onDidChangeRoadmapState.fire(snapshot);
}
