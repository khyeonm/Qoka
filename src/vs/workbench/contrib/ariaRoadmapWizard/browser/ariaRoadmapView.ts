/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { COLUMN_WIDTH, NodeInput, computeRoadmapLayout, layoutBounds } from './roadmapCanvasLayout.js';

interface PersistedNode {
	id: string;
	column: number;
	parent: string | null;
	label: string;
	description?: string;
	status?: 'todo' | 'in_progress' | 'done';
}

interface PersistedRoadmap {
	version: number;
	columnLabels: string[];
	nodes: PersistedNode[];
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Sidebar view for the project's roadmap (`<workspace>/.aria/roadmap.json`).
 *
 * Shows a compact, non-interactive thumbnail of the same canvas the wizard
 * editor draws, plus an "Open full roadmap" button that opens the full,
 * pan/zoom/editable canvas in the editor area. Re-reads on any change to the
 * roadmap file.
 */
export class AriaRoadmapView extends ViewPane {

	static readonly ID = 'workbench.view.aria.roadmap.tree';

	private viewBody: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.refresh()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.refresh()));
		// Re-read whenever the roadmap file changes (the wizard saving, manual edits).
		this._register(this.fileService.onDidFilesChange(e => {
			const uri = this.roadmapFileUri();
			if (uri && e.contains(uri)) {
				void this.refresh();
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.aria-roadmap-view'));
		root.style.padding = '10px';
		root.style.overflow = 'auto';
		root.style.boxSizing = 'border-box';
		root.style.width = '100%';
		this.viewBody = root;
		void this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.viewBody) {
			this.viewBody.style.height = `${height}px`;
			this.viewBody.style.width = `${width}px`;
		}
	}

	private roadmapFileUri() {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return undefined;
		}
		return joinPath(folder.uri, '.aria', 'roadmap.json');
	}

	private async refresh(): Promise<void> {
		const root = this.viewBody;
		if (!root) {
			return;
		}
		clearNode(root);

		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			this.renderEmpty(root, localize('aria.roadmap.noFolder', "Open a project to see its roadmap."));
			return;
		}

		const uri = this.roadmapFileUri();
		if (!uri) {
			this.renderEmpty(root, localize('aria.roadmap.noFolder', "Open a project to see its roadmap."));
			return;
		}

		let roadmap: PersistedRoadmap | undefined;
		try {
			const content = await this.fileService.readFile(uri);
			roadmap = JSON.parse(content.value.toString()) as PersistedRoadmap;
		} catch {
			roadmap = undefined;
		}

		if (!roadmap || !Array.isArray(roadmap.nodes) || roadmap.nodes.length === 0) {
			this.renderEmpty(root, localize('aria.roadmap.empty', "No roadmap yet. Use New Project to draft one with Claude Code."));
			return;
		}

		this.renderThumbnail(root, roadmap.nodes);
	}

	/** Compact, non-interactive preview of the whole roadmap; click or the button
	 *  opens the full canvas in the editor. */
	private renderThumbnail(root: HTMLElement, nodes: PersistedNode[]): void {
		const open = () => void this.commandService.executeCommand('aria.roadmap.openWizard');

		const inputs: NodeInput[] = nodes.map(n => ({ id: n.id, column: n.column, parent: n.parent, label: n.label, description: n.description }));
		const laid = computeRoadmapLayout(inputs, []);
		const bounds = layoutBounds(laid);

		const frame = append(root, $('div'));
		frame.style.border = '1px solid var(--vscode-widget-border, rgba(127,127,127,0.3))';
		frame.style.borderRadius = '6px';
		frame.style.overflow = 'hidden';
		frame.style.cursor = 'pointer';
		frame.style.background = 'var(--vscode-editorWidget-background, rgba(127,127,127,0.04))';
		frame.title = localize('aria.roadmap.openFullHint', "Open the full roadmap");
		frame.onclick = open;

		const svg = document.createElementNS(SVG_NS, 'svg') as unknown as SVGSVGElement;
		svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
		svg.setAttribute('width', '100%');
		// Keep the thumbnail a reasonable height; aspect from the content bounds.
		const aspect = bounds.height / bounds.width;
		svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
		svg.style.display = 'block';
		svg.style.width = '100%';
		svg.style.height = `${Math.max(120, Math.min(360, Math.round((root.clientWidth || 240) * aspect)))}px`;

		// Connectors.
		for (const node of laid) {
			if (node.parent === null) { continue; }
			const parent = laid.find(n => n.id === node.parent);
			if (!parent) { continue; }
			const path = document.createElementNS(SVG_NS, 'path');
			const x1 = parent.x + COLUMN_WIDTH, y1 = parent.y + parent.height / 2;
			const x2 = node.x, y2 = node.y + node.height / 2;
			const mid = (x1 + x2) / 2;
			path.setAttribute('d', `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
			path.setAttribute('stroke', 'rgba(127,127,127,0.6)');
			path.setAttribute('stroke-width', '2');
			path.setAttribute('fill', 'none');
			svg.appendChild(path);
		}
		// Node boxes (no text — it would be illegible at thumbnail scale).
		for (const node of laid) {
			const rect = document.createElementNS(SVG_NS, 'rect');
			rect.setAttribute('x', String(node.x));
			rect.setAttribute('y', String(node.y));
			rect.setAttribute('width', String(COLUMN_WIDTH));
			rect.setAttribute('height', String(node.height));
			rect.setAttribute('rx', '8');
			rect.setAttribute('fill', 'var(--vscode-editor-background, #1e1e1e)');
			rect.setAttribute('stroke', node.column === 0 ? 'var(--vscode-focusBorder, #007acc)' : 'rgba(127,127,127,0.6)');
			rect.setAttribute('stroke-width', node.column === 0 ? '3' : '2');
			svg.appendChild(rect);
		}
		frame.appendChild(svg as unknown as SVGElement);

		const button = append(root, $('button')) as HTMLButtonElement;
		button.textContent = localize('aria.roadmap.openFull', "Open full roadmap");
		button.style.marginTop = '8px';
		button.style.width = '100%';
		button.style.padding = '6px 10px';
		button.style.fontSize = '12px';
		button.style.cursor = 'pointer';
		button.style.borderRadius = '4px';
		button.style.border = 'none';
		button.style.background = 'var(--vscode-button-background)';
		button.style.color = 'var(--vscode-button-foreground)';
		button.onclick = open;
	}

	private renderEmpty(root: HTMLElement, text: string): void {
		const empty = append(root, $('p'));
		empty.style.opacity = '0.7';
		empty.style.fontSize = '13px';
		empty.textContent = text;
	}
}
