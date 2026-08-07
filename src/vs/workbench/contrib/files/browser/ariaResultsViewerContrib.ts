/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname, isEqual } from '../../../../base/common/resources.js';
import * as DOM from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IExplorerFileContribution, explorerFileContribRegistry } from './explorerFileContrib.js';

/**
 * Adds an inline "Open in viewer" button to each `results/<run>/` folder in the
 * Analysis / Explorer tree. Clicking opens that run folder in the autopipe viewer
 * (aria.autopipe.openResultsViewer), where the autopipe plugins render each result
 * file (CSV tables, images, and genomics formats via the run connection). Individual
 * files still open normally in the editor (PDFs in the in-app PDF viewer).
 */
class ResultsViewerFileContribution extends Disposable implements IExplorerFileContribution {

	private readonly button: HTMLAnchorElement;
	private resource: URI | undefined;

	constructor(
		container: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		super();
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
	}

	setResource(resource: URI | undefined): void {
		this.resource = resource;
		this.button.style.display = resource && this.isResultsRunFolder(resource) ? 'inline-flex' : 'none';
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
		super.dispose();
	}
}

explorerFileContribRegistry.register({
	create: (insta, container) => insta.createInstance(ResultsViewerFileContribution, container),
});
