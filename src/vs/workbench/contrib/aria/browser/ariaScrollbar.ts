/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared scrollbar styling for Qoka's custom panes/views.
 *
 * Qoka builds several surfaces (the sidebar views and the Paper Writer editor
 * pane) as plain DOM with `overflow: auto`, which renders the chunky default OS
 * scrollbar - visually inconsistent with the rest of VS Code, whose scrollbars
 * are thin, square, and theme-coloured. Tagging a scroll container with the
 * `aria-themed-scrollable` class (via `applyAriaScrollbar`) makes its scrollbar
 * match VS Code's, so every Qoka surface scrolls the same way.
 *
 * We use `var(--vscode-...)` so light/dark theme switches keep the slider in
 * sync without us having to listen for theme changes. Injecting the stylesheet
 * a second time (because another pane already imported this) is a no-op.
 */

const STYLE_ID = 'aria-themed-scrollbar-style';
export const ARIA_SCROLLABLE_CLASS = 'aria-themed-scrollable';

/** Inject (once) the stylesheet that themes `.aria-themed-scrollable` scrollbars. */
export function ensureAriaPaneScrollbarStyle(): void {
	if (document.getElementById(STYLE_ID)) {
		return;
	}
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
		.${ARIA_SCROLLABLE_CLASS}::-webkit-scrollbar {
			width: 10px;
			height: 10px;
		}
		.${ARIA_SCROLLABLE_CLASS}::-webkit-scrollbar-track {
			background: transparent;
		}
		.${ARIA_SCROLLABLE_CLASS}::-webkit-scrollbar-thumb {
			background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
			border-radius: 0;
		}
		.${ARIA_SCROLLABLE_CLASS}::-webkit-scrollbar-thumb:hover {
			background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.7));
		}
		.${ARIA_SCROLLABLE_CLASS}::-webkit-scrollbar-thumb:active {
			background: var(--vscode-scrollbarSlider-activeBackground, rgba(191, 191, 191, 0.4));
		}
		.${ARIA_SCROLLABLE_CLASS}::-webkit-scrollbar-corner {
			background: transparent;
		}
	`;
	document.head.appendChild(style);
}

/** Tag a scrollable element so its scrollbar matches VS Code's theme. */
export function applyAriaScrollbar(el: HTMLElement): void {
	ensureAriaPaneScrollbarStyle();
	el.classList.add(ARIA_SCROLLABLE_CLASS);
}
