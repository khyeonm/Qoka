/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AriaMode } from '../../common/ariaConfiguration.js';

/**
 * Catalog of "things you can start" on the Aria start page. A single feature
 * record carries everything needed to render its card (icon + text) and to
 * invoke the action (command id). The `modes` array controls which modes
 * the feature shows up in — changing the visibility for a mode is a one-line
 * edit here, no UI changes required.
 */
export interface IAriaStartFeature {
	readonly id: string;
	readonly icon: string;             // codicon id (no `$()` wrapper)
	readonly title: string;
	readonly detail: string;
	readonly command: string;          // command id to invoke on click
	readonly modes: readonly AriaMode[]; // which modes show this feature
	readonly order?: number;           // lower = earlier; default 100
}

export const ARIA_START_FEATURES: readonly IAriaStartFeature[] = [
	{
		id: 'newFile',
		icon: 'new-file',
		title: 'New File',
		detail: 'Start with an empty file',
		command: 'workbench.action.files.newUntitledFile',
		modes: ['easy', 'advanced'],
		order: 10,
	},
	{
		id: 'openFile',
		icon: 'go-to-file',
		title: 'Open File',
		detail: 'Open an existing file',
		command: 'workbench.action.files.openFile',
		modes: ['easy', 'advanced'],
		order: 20,
	},
	{
		id: 'openFolder',
		icon: 'folder-opened',
		title: 'Open Folder',
		detail: 'Open a project folder',
		command: 'workbench.action.files.openFolder',
		modes: ['easy', 'advanced'],
		order: 30,
	},
];

export function getFeaturesForMode(mode: AriaMode): IAriaStartFeature[] {
	return ARIA_START_FEATURES
		.filter(f => f.modes.includes(mode))
		.slice()
		.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}
