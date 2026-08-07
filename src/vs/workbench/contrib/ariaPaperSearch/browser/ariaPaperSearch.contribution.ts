/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { registerThemingParticipant } from '../../../../platform/theme/common/themeService.js';
import { localize, localize2 } from '../../../../nls.js';
import {
	ViewContainer, ViewContainerLocation,
	IViewContainersRegistry, Extensions as ViewContainerExtensions,
	IViewsRegistry, Extensions as ViewExtensions,
	IViewDescriptor,
} from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { AriaPaperSearchView, AriaDownloadedPdfsView } from './ariaPaperSearchView.js';
import { registerAriaTabHelpTitleAction } from '../../aria/browser/ariaHelpEditor.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IFileService, FileChangeType } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { URI } from '../../../../base/common/uri.js';

const ARIA_PAPER_SEARCH_CONTAINER_ID = 'workbench.view.ariaPaperSearch';

const paperSearchIcon = registerIcon(
	'aria-paper-search-view',
	Codicon.search,
	localize('aria.paperSearch.iconLabel', "Qoka Paper Library activity bar icon"),
);

// A small stylized "book + magnifier" puzzle for the activity bar.
// Encoded as a data URI so the workbench bundle has no external asset.
const PAPER_ICON_SVG_DATA_URI = 'data:image/svg+xml;utf8,'
	+ encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" `
		+ `stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`
		+ `<path d="M4 4 h11 a2 2 0 0 1 2 2 v9 h-13 a1 1 0 0 1 -1 -1 v-9 a1 1 0 0 1 1 -1 Z"/>`
		+ `<path d="M7 8 h6 M7 11 h4"/>`
		+ `<circle cx="17" cy="17" r="3"/>`
		+ `<path d="M19.2 19.2 L22 22"/>`
		+ `</svg>`,
	);

registerThemingParticipant((_theme, collector) => {
	const url = `url("${PAPER_ICON_SVG_DATA_URI}")`;
	collector.addRule(`
		.codicon-aria-paper-search-view::before {
			content: '';
			display: inline-block;
			width: 24px;
			height: 24px;
			background-color: currentColor;
			-webkit-mask-image: ${url};
			mask-image: ${url};
			-webkit-mask-repeat: no-repeat;
			mask-repeat: no-repeat;
			-webkit-mask-size: contain;
			mask-size: contain;
			-webkit-mask-position: center;
			mask-position: center;
		}
	`);
});

const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: ARIA_PAPER_SEARCH_CONTAINER_ID,
		title: localize2('aria.paperSearch.containerTitle', "Paper Library"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ARIA_PAPER_SEARCH_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: paperSearchIcon,
		order: 12,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const paperSearchView: IViewDescriptor = {
	id: AriaPaperSearchView.ID,
	name: localize2('aria.paperSearch.viewName', "Saved Papers"),
	containerIcon: paperSearchIcon,
	ctorDescriptor: new SyncDescriptor(AriaPaperSearchView),
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
};

// Second, separate section (like the Analysis tab's Changes / Snapshots): a real
// collapsible + drag-resizable pane listing the downloaded PDF files.
const downloadedPdfsView: IViewDescriptor = {
	id: AriaDownloadedPdfsView.ID,
	name: localize2('aria.downloadedPdfs.viewName', "Downloaded PDFs"),
	containerIcon: paperSearchIcon,
	ctorDescriptor: new SyncDescriptor(AriaDownloadedPdfsView),
	canToggleVisibility: true,
	canMoveView: false,
	order: 2,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([paperSearchView, downloadedPdfsView], viewContainer);

// "How to use?" link in the view's title bar (right of the "PAPER LIBRARY" title).
registerAriaTabHelpTitleAction(AriaPaperSearchView.ID, 'paper-library');

/**
 * When the save-paper-pdf skill writes a PDF into `<workspace>/.qoka/references/pdfs/`,
 * open the Paper Library (Downloaded PDFs section) so the user sees it right away.
 */
class AriaPdfDownloadRevealContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.pdfDownloadReveal';

	private revealTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super();
		const folder = contextService.getWorkspace().folders[0];
		if (!folder) { return; }
		const pdfsUri = URI.joinPath(folder.uri, '.qoka', 'references', 'pdfs');
		this._register(fileService.watch(pdfsUri));
		this._register(fileService.onDidFilesChange(e => {
			if (!e.affects(pdfsUri, FileChangeType.ADDED)) { return; }
			// A download can fire several change events (mkdir + move); debounce so we
			// reveal the Paper Library once, not repeatedly.
			if (this.revealTimer) { return; }
			this.revealTimer = setTimeout(() => { this.revealTimer = undefined; }, 1500);
			void this.viewsService.openView(AriaDownloadedPdfsView.ID, true);
		}));
	}

	override dispose(): void {
		if (this.revealTimer) { clearTimeout(this.revealTimer); this.revealTimer = undefined; }
		super.dispose();
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaPdfDownloadRevealContribution, LifecyclePhase.Restored);
