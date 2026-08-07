/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { isEqual, isEqualOrParent } from '../../../../base/common/resources.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';

/**
 * A `results/<run>/` folder that currently has an open Autopipe Viewer tab. The
 * Analysis tree draws a highlight box around the folder and its members, and
 * clicking a file inside routes to that viewer tab instead of a normal editor.
 * `active` is true for the scope whose viewer tab is focused (sky-blue box);
 * others render grey.
 */
export interface ViewerScopeState {
	folder: URI;
	active: boolean;
}

export interface ScopeMembership {
	/** The resource is the scope folder or lives underneath it. */
	member: boolean;
	/** The resource IS a scope folder (the box's top row). */
	isRoot: boolean;
	/** The innermost containing scope is focused. */
	active: boolean;
}

/**
 * Process-wide store of open viewer scopes. The autopipe extension drives it
 * through the `aria.viewer.*` commands (registered below); the explorer reads
 * it to paint the highlight and to route file clicks. A plain singleton (not a
 * DI service) so both the per-row file contribution and the ExplorerView can
 * reach the same state without threading a service through either.
 */
class AriaViewerScopeStore {

	private readonly _scopes: ViewerScopeState[] = [];
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	get scopes(): readonly ViewerScopeState[] {
		return this._scopes;
	}

	setScope(folder: URI): void {
		if (this._scopes.some(s => isEqual(s.folder, folder))) {
			return;
		}
		// A freshly opened viewer tab takes focus, so it becomes the active
		// (blue) scope and the others go idle.
		for (const s of this._scopes) {
			s.active = false;
		}
		this._scopes.push({ folder, active: true });
		this._onDidChange.fire();
	}

	setScopeActive(folder: URI, active: boolean): void {
		const scope = this._scopes.find(s => isEqual(s.folder, folder));
		if (!scope) {
			return;
		}
		if (active) {
			for (const s of this._scopes) {
				s.active = false;
			}
		}
		scope.active = active;
		this._onDidChange.fire();
	}

	clearScope(folder: URI): void {
		const idx = this._scopes.findIndex(s => isEqual(s.folder, folder));
		if (idx < 0) {
			return;
		}
		this._scopes.splice(idx, 1);
		this._onDidChange.fire();
	}

	/** The innermost scope whose folder contains (or equals) `resource`. */
	scopeContaining(resource: URI): ViewerScopeState | undefined {
		let best: ViewerScopeState | undefined;
		for (const s of this._scopes) {
			if (isEqualOrParent(resource, s.folder)) {
				if (!best || s.folder.path.length > best.folder.path.length) {
					best = s;
				}
			}
		}
		return best;
	}

	membershipFor(resource: URI): ScopeMembership {
		const scope = this.scopeContaining(resource);
		if (!scope) {
			return { member: false, isRoot: false, active: false };
		}
		return {
			member: true,
			isRoot: isEqual(resource, scope.folder),
			active: scope.active,
		};
	}
}

export const ariaViewerScopeStore = new AriaViewerScopeStore();

function toUri(arg: unknown): URI | undefined {
	if (typeof arg === 'string') {
		return URI.file(arg);
	}
	if (arg && typeof (arg as URI).scheme === 'string') {
		return arg as URI;
	}
	return undefined;
}

CommandsRegistry.registerCommand('aria.viewer.setScope', (_accessor, folder: unknown) => {
	const uri = toUri(folder);
	if (uri) {
		ariaViewerScopeStore.setScope(uri);
	}
});

CommandsRegistry.registerCommand('aria.viewer.setScopeActive', (_accessor, folder: unknown, active: unknown) => {
	const uri = toUri(folder);
	if (uri) {
		ariaViewerScopeStore.setScopeActive(uri, active !== false);
	}
});

CommandsRegistry.registerCommand('aria.viewer.clearScope', (_accessor, folder: unknown) => {
	const uri = toUri(folder);
	if (uri) {
		ariaViewerScopeStore.clearScope(uri);
	}
});
