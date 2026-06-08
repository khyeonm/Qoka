/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/** Mirrors the same-named type in the aria-vcs extension. */
export interface Snapshot {
	hash: string;
	timestamp: number;
	message: string;
	filesChanged: number;
}

export interface StatusInfo {
	isRepo: boolean;
	unsavedChanges: number;
	hasHead: boolean;
}

export type FileChangeKind = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';

export interface FileChange {
	path: string;
	kind: FileChangeKind;
	additions?: number;
	deletions?: number;
}

/**
 * Inline-injected stylesheet shared by both Aria VCS views. We use a single
 * `<style>` element keyed on `data-aria-vcs-styles` so the rules survive
 * view re-renders and are only injected once per workbench window.
 *
 * We took this route because the obvious `import './media/foo.css'` only
 * works when the build step is configured to bundle CSS — at the moment our
 * Aria-build step is not, and the symlinked dev workbench loads the .css as
 * a JS module and errors out. Inline injection sidesteps the build path
 * entirely.
 */
export function injectAriaVcsStyles(): void {
	const ATTR = 'data-aria-vcs-styles';
	if (document.head.querySelector(`style[${ATTR}]`)) {
		return;
	}
	const style = document.createElement('style');
	style.setAttribute(ATTR, 'true');
	style.textContent = `
		.aria-vcs-scroll::-webkit-scrollbar {
			width: 10px;
			height: 10px;
		}
		.aria-vcs-scroll::-webkit-scrollbar-track {
			background: transparent;
		}
		.aria-vcs-scroll::-webkit-scrollbar-thumb {
			background-color: var(--vscode-scrollbarSlider-background);
			background-clip: padding-box;
			border: 2px solid transparent;
		}
		.aria-vcs-scroll::-webkit-scrollbar-thumb:hover {
			background-color: var(--vscode-scrollbarSlider-hoverBackground);
		}
		.aria-vcs-scroll::-webkit-scrollbar-thumb:active {
			background-color: var(--vscode-scrollbarSlider-activeBackground);
		}
		.aria-vcs-scroll::-webkit-scrollbar-corner {
			background: transparent;
		}

		.aria-vcs-row {
			display: flex;
			align-items: center;
			gap: 4px;
			padding: 3px 8px;
			font-size: 13px;
			border-radius: 3px;
		}
		.aria-vcs-row:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.aria-vcs-marker {
			font-size: 10px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			opacity: 0.85;
			min-width: 52px;
			text-align: left;
			flex-shrink: 0;
		}

		.aria-vcs-filename {
			flex: 1;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			cursor: pointer;
		}

		.aria-vcs-stats {
			opacity: 0.7;
			font-size: 11px;
			flex-shrink: 0;
		}
	`;
	document.head.appendChild(style);
}

/**
 * Last path segment only — Easy mode users only care about the filename in
 * the Changes list; the diff editor (and its title) already shows the full
 * path when they click in.
 */
export function basename(p: string): string {
	if (!p) {
		return '';
	}
	const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
	return idx >= 0 ? p.substring(idx + 1) : p;
}

/**
 * Word-style label + colour for a change kind. The label is shown in a
 * small uppercase badge before the filename. Colours follow VS Code's git
 * decoration tokens so they pick up the active theme.
 */
export function markerFor(kind: FileChangeKind): { label: string; color: string } {
	switch (kind) {
		case 'added':
			return {
				label: localize('aria.vcs.marker.added', "Added"),
				color: 'var(--vscode-gitDecoration-addedResourceForeground, #587c0c)',
			};
		case 'deleted':
			return {
				label: localize('aria.vcs.marker.deleted', "Removed"),
				color: 'var(--vscode-gitDecoration-deletedResourceForeground, #ad0707)',
			};
		case 'untracked':
			return {
				label: localize('aria.vcs.marker.untracked', "New"),
				color: 'var(--vscode-gitDecoration-untrackedResourceForeground, #73c991)',
			};
		case 'renamed':
			return {
				label: localize('aria.vcs.marker.renamed', "Renamed"),
				color: 'var(--vscode-gitDecoration-renamedResourceForeground, #007acc)',
			};
		case 'modified':
		default:
			return {
				label: localize('aria.vcs.marker.modified', "Edited"),
				color: 'var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d)',
			};
	}
}

export function formatRelativeTime(ts: number): string {
	const diffSec = Math.floor((Date.now() - ts) / 1000);
	if (diffSec < 60) {
		return localize('aria.vcs.justNow', "just now");
	}
	if (diffSec < 3600) {
		const m = Math.floor(diffSec / 60);
		return localize('aria.vcs.minutesAgo', "{0} min ago", m);
	}
	if (diffSec < 86400) {
		const h = Math.floor(diffSec / 3600);
		return localize('aria.vcs.hoursAgo', "{0} h ago", h);
	}
	const d = Math.floor(diffSec / 86400);
	return localize('aria.vcs.daysAgo', "{0} d ago", d);
}
