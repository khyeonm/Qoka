/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/ariaViewerScope.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname, isEqual } from '../../../../base/common/resources.js';
import * as DOM from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IExplorerFileContribution, explorerFileContribRegistry } from './explorerFileContrib.js';
import { ariaViewerScopeStore } from './ariaViewerScope.js';

/**
 * Per-row explorer contribution for the pipeline result viewer:
 *   1. An inline "Open in viewer" button on each `results/<run>/` folder,
 *      opening that folder in the Autopipe Viewer (aria.autopipe.openResultsViewer).
 *   2. A highlight box on every row that belongs to an open viewer scope, so
 *      the user can see which folder a viewer tab is bound to. Clicking a file
 *      in the box routes into the viewer (handled in ExplorerView).
 *
 * Both are recomputed per render, so they survive list virtualization. The
 * box's top/bottom edges are placed by a document-wide pass (min/max row offset
 * per scope) since a single row cannot know whether it is first or last.
 */
class ResultsViewerFileContribution extends Disposable implements IExplorerFileContribution {

	private readonly button: HTMLAnchorElement;
	private readonly container: HTMLElement;
	private resource: URI | undefined;

	constructor(
		container: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		super();
		this.container = container;
		this.button = document.createElement('a');
		this.button.className = 'aria-open-in-viewer codicon codicon-eye';
		this.button.title = localize('aria.openInViewer', "Open in viewer");
		this.button.style.display = 'none';
		this.button.style.marginLeft = 'auto';
		this.button.style.flexShrink = '0';
		this.button.style.cursor = 'pointer';
		this.button.style.paddingLeft = '6px';
		this.button.style.opacity = '0.8';
		this._register(DOM.addDisposableListener(this.button, DOM.EventType.CLICK, (e: MouseEvent) => {
			e.stopPropagation();
			e.preventDefault();
			if (this.resource) {
				void this.commandService.executeCommand('aria.autopipe.openResultsViewer', this.resource.fsPath);
			}
		}));
		container.appendChild(this.button);

		// Repaint this row when scopes open/close/focus-change.
		this._register(ariaViewerScopeStore.onDidChange(() => this.applyHighlight()));
	}

	setResource(resource: URI | undefined): void {
		this.resource = resource;
		this.button.style.display = resource && this.isResultsRunFolder(resource) ? 'inline-flex' : 'none';
		this.applyHighlight();
	}

	/** Toggle the scope-highlight classes on this row's `.monaco-list-row`. */
	private applyHighlight(): void {
		const row = this.container.closest('.monaco-list-row') as HTMLElement | null;
		if (!row) {
			return;
		}
		const scope = this.resource ? ariaViewerScopeStore.scopeContaining(this.resource) : undefined;
		if (!scope) {
			row.classList.remove('aria-viewer-scope-member', 'aria-viewer-scope-active', 'aria-viewer-scope-top', 'aria-viewer-scope-bottom');
			row.removeAttribute('data-aria-scope');
			scheduleEdgePass();
			return;
		}
		row.classList.add('aria-viewer-scope-member');
		row.classList.toggle('aria-viewer-scope-active', scope.active);
		// Top/bottom are decided by the document-wide pass; clear here so a
		// recycled row does not keep a stale edge.
		row.classList.remove('aria-viewer-scope-top', 'aria-viewer-scope-bottom');
		row.setAttribute('data-aria-scope', scope.folder.toString());
		scheduleEdgePass();
	}

	/** A direct child of <workspace>/results (i.e. a pipeline run folder). */
	private isResultsRunFolder(resource: URI): boolean {
		const folder = this.contextService.getWorkspace().folders[0];
		if (!folder) {
			return false;
		}
		return isEqual(dirname(resource), URI.joinPath(folder.uri, 'results'));
	}

	override dispose(): void {
		this.button.remove();
		const row = this.container.closest('.monaco-list-row') as HTMLElement | null;
		row?.classList.remove('aria-viewer-scope-member', 'aria-viewer-scope-active', 'aria-viewer-scope-top', 'aria-viewer-scope-bottom');
		row?.removeAttribute('data-aria-scope');
		super.dispose();
	}
}

/**
 * Place the top/bottom border of each scope box on its topmost / bottommost
 * currently-rendered member row. Grouped by the `data-aria-scope` attribute
 * and ordered by layout offset (offsetTop) - robust to the monaco list's
 * absolute row positioning, where DOM order does not track visual order.
 */
let edgePassScheduled = false;
function scheduleEdgePass(): void {
	if (edgePassScheduled) {
		return;
	}
	edgePassScheduled = true;
	const run = () => {
		edgePassScheduled = false;
		runEdgePass();
	};
	if (typeof requestAnimationFrame === 'function') {
		requestAnimationFrame(run);
	} else {
		setTimeout(run, 0);
	}
}

function runEdgePass(): void {
	const rows = Array.from(document.querySelectorAll('.monaco-list-row.aria-viewer-scope-member')) as HTMLElement[];
	const byScope = new Map<string, HTMLElement[]>();
	for (const row of rows) {
		row.classList.remove('aria-viewer-scope-top', 'aria-viewer-scope-bottom');
		const key = row.getAttribute('data-aria-scope') ?? '';
		const list = byScope.get(key);
		if (list) {
			list.push(row);
		} else {
			byScope.set(key, [row]);
		}
	}
	for (const group of byScope.values()) {
		if (group.length === 0) {
			continue;
		}
		let top = group[0];
		let bottom = group[0];
		for (const row of group) {
			if (row.offsetTop < top.offsetTop) {
				top = row;
			}
			if (row.offsetTop > bottom.offsetTop) {
				bottom = row;
			}
		}
		top.classList.add('aria-viewer-scope-top');
		bottom.classList.add('aria-viewer-scope-bottom');
	}
}

explorerFileContribRegistry.register({
	create: (insta, container) => insta.createInstance(ResultsViewerFileContribution, container),
});
