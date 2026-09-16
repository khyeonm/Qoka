/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';

/**
 * Deterministic "hide the integrated browser" signal for full-screen startup /
 * loading covers.
 *
 * The browser is a native Electron WebContentsView that floats above the whole
 * workbench DOM, so it can paint on top of a loading screen. DOM-overlap / mutation
 * detection from the browser renderer proved unreliable for this (timing during
 * startup), so instead the loading covers themselves flip this flag directly when
 * they show / hide, and the renderer hides the WCV while it is set - no DOM query
 * and no dependence on when the browser editor is restored.
 *
 * Multiple covers may be up at once (started overlay, first-run overlay, ...), so
 * each begins / ends by a stable id and the browser stays suppressed while any is up.
 */
class BrowserLoadingSuppressor {
	private readonly _active = new Set<string>();
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	get suppressed(): boolean {
		return this._active.size > 0;
	}

	/** A loading cover with this id is now shown (idempotent). */
	begin(id: string): void {
		if (!this._active.has(id)) {
			this._active.add(id);
			this._onDidChange.fire();
		}
	}

	/** A loading cover with this id is gone (idempotent). */
	end(id: string): void {
		if (this._active.delete(id)) {
			this._onDidChange.fire();
		}
	}
}

/** Process-wide singleton shared by the loading covers and the browser renderer. */
export const browserLoadingSuppressor = new BrowserLoadingSuppressor();
