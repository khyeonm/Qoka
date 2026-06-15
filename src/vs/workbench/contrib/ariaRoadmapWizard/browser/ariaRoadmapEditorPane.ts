/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension, addDisposableListener } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { Snapshot, isSnapshot, onDidChangeRoadmapState } from './ariaRoadmapWizardCommon.js';
import { COLUMN_WIDTH, NODE_LINE_HEIGHT, NODE_LABEL_PAD_X, LaidOut, columnX, computeRoadmapLayout } from './roadmapCanvasLayout.js';

// Ctrl+drag zoom bounds.
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;

// Starter prompt shown on the empty canvas. The user pastes it into the
// Claude Code chat (Claude Code's sidebar chat can't be seeded programmatically),
// which kicks the model into the facilitator role. Because it arrives as a real
// user message — not passive MCP `instructions` — the model reliably adopts it.
const STARTER_PROMPT = [
	'I want to build ___. Help me complete this roadmap through brainstorming.',
	'Don\'t write any code yet. First read get_roadmap_guide, then ask me one question at a time',
	'and use propose_node to add Goal → Milestone → Task → Detail nodes to the canvas. Keep all node text in English.',
].join('\n');

/**
 * The New Project Roadmap Wizard, rendered as a workbench editor.
 *
 * Replaces the former full-viewport DOM overlay. Living in the editor area
 * means VS Code's own layout owns the surrounding chrome: Claude Code's chat
 * sits natively in the auxiliary side bar (opened alongside by the contribution
 * that opens this editor), the user can resize/close panels normally, and there
 * is no CSS hide/restore fight with the workbench.
 *
 * The pane is purely a view over the aria-roadmap extension's state:
 *   - on `setInput` it pulls the current snapshot via `aria.roadmap.getState`
 *   - thereafter it re-renders whenever `onDidChangeRoadmapState` fires
 *     (the contribution re-broadcasts the extension's push)
 *   - every user action routes back through an `aria.roadmap.*` command, so
 *     manual canvas edits and AI proposals share one state path.
 */
export class AriaRoadmapEditorPane extends EditorPane {

	static readonly ID = 'aria.roadmap.editorPane';

	private container: HTMLElement | undefined;
	private canvasSvg: SVGSVGElement | undefined;
	private editPanel: HTMLElement | undefined;
	private sequentialBar: HTMLElement | undefined;
	private saveButton: HTMLButtonElement | undefined;
	private starterCard: HTMLElement | undefined;
	private canvasWrap: HTMLElement | undefined;
	// Camera: the SVG fills the viewport and a viewBox acts as a movable,
	// scalable window over the content. camX/camY are the content coordinates at
	// the viewport's top-left; camZoom scales. This gives infinite-canvas pan
	// (works even when the tree is smaller than the viewport) and smooth zoom.
	private camX = -16;
	private camY = -16;
	private camZoom = 1;
	private snapshot: Snapshot ={ columnLabels: ['Goal', 'Milestone', 'Task', 'Detail'], committed: [], proposed: [], finalized: false };

	// Sequential review is fully derived from the snapshot: whenever any
	// proposal exists, the review bar focuses the FIRST one (proposals come
	// sorted by creation time) and the user decides Accept / Edit / Delete on
	// it. Accepting/rejecting shrinks the list, so the next proposal becomes
	// the focus automatically — no frozen queue/index to drift out of sync as
	// the AI streams proposals in one at a time.

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super(AriaRoadmapEditorPane.ID, group, telemetryService, themeService, storageService);

		// Subscribe once for the pane's lifetime — the handler just re-renders
		// against the latest snapshot, so it is safe across input changes.
		this._register(onDidChangeRoadmapState(snapshot => this.onStateChange(snapshot)));
	}

	protected createEditor(parent: HTMLElement): void {
		const container = document.createElement('div');
		container.style.position = 'relative';
		container.style.width = '100%';
		container.style.height = '100%';
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.background = 'var(--vscode-editor-background, #1e1e1e)';
		container.style.color = 'var(--vscode-foreground, #cccccc)';
		container.style.fontFamily = 'var(--vscode-font-family, system-ui, sans-serif)';
		container.style.overflow = 'hidden';

		// Header — title hint + Cancel / Save & Accept. No window-control
		// padding hack here: the editor area never underlaps the OS title bar.
		const header = document.createElement('header');
		header.style.display = 'flex';
		header.style.alignItems = 'center';
		header.style.justifyContent = 'space-between';
		header.style.padding = '12px 20px';
		header.style.borderBottom = '1px solid rgba(127,127,127,0.2)';
		header.style.flex = '0 0 auto';

		const hint = document.createElement('div');
		hint.textContent = 'Draft your roadmap with Claude Code. Click any node to view or edit its details. Save keeps it in this project.';
		hint.style.fontSize = '12.5px';
		hint.style.opacity = '0.7';
		header.appendChild(hint);

		const headerActions = document.createElement('div');
		headerActions.style.display = 'flex';
		headerActions.style.gap = '8px';
		const deleteButton = this.makeButton('Delete', 'ghost', () => void this.deleteRoadmap());
		const saveButton = this.makeButton('Save', 'primary', () => void this.save());
		saveButton.disabled = true;
		saveButton.title = 'Add at least one goal to save the roadmap.';
		this.saveButton = saveButton;
		headerActions.appendChild(deleteButton);
		headerActions.appendChild(saveButton);
		header.appendChild(headerActions);
		container.appendChild(header);

		// Canvas — an SVG that fills the viewport; pan/zoom are done by moving the
		// viewBox (the "camera"), not by scrolling, so it behaves like an
		// infinite canvas.
		const canvasWrap = document.createElement('section');
		canvasWrap.style.position = 'relative';
		canvasWrap.style.flex = '1 1 auto';
		canvasWrap.style.overflow = 'hidden';
		canvasWrap.style.background = 'var(--vscode-editorWidget-background, rgba(127,127,127,0.04))';
		this.canvasWrap = canvasWrap;

		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg') as unknown as SVGSVGElement;
		svg.style.display = 'block';
		svg.style.width = '100%';
		svg.style.height = '100%';
		canvasWrap.appendChild(svg);
		this.canvasSvg = svg;

		// Starter card — floats over the empty canvas with a copyable prompt the
		// user pastes into the Claude Code chat to begin the brainstorming.
		// Hidden as soon as the roadmap has any node.
		const starter = this.buildStarterCard();
		canvasWrap.appendChild(starter);
		this.starterCard = starter;

		// Background drag = pan. Ctrl+drag (drag up = in, down = out) or Ctrl+wheel
		// = zoom; plain wheel pans vertically. Drags that start on a node/button
		// pan too — the camera ignores their position — but their click still
		// fires if the pointer doesn't move, so node clicks keep working.
		canvasWrap.style.cursor = 'grab';
		let panning = false;
		let zooming = false;
		let startX = 0, startY = 0, startCamX = 0, startCamY = 0, startZoom = 1;
		let anchorContentX = 0, anchorContentY = 0, anchorPX = 0, anchorPY = 0;
		const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
		this._register(addDisposableListener(canvasWrap, 'mousedown', (e: MouseEvent) => {
			if (e.button !== 0) { return; }
			const target = e.target as Element;
			startX = e.clientX; startY = e.clientY;
			if (e.ctrlKey || e.metaKey) {
				// Zoom works anywhere (even starting on a node).
				zooming = true;
				startZoom = this.camZoom;
				const rect = canvasWrap.getBoundingClientRect();
				anchorPX = e.clientX - rect.left;
				anchorPY = e.clientY - rect.top;
				anchorContentX = this.camX + anchorPX / this.camZoom;
				anchorContentY = this.camY + anchorPY / this.camZoom;
				e.preventDefault();
				return;
			}
			// Pan: ignore drags that begin on an interactive element so their
			// own click/select still works.
			if (target.closest?.('.roadmap-interactive')) { return; }
			panning = true;
			startCamX = this.camX; startCamY = this.camY;
			canvasWrap.style.cursor = 'grabbing';
			e.preventDefault();
		}));
		this._register(addDisposableListener(canvasWrap.ownerDocument, 'mousemove', (e: MouseEvent) => {
			if (zooming) {
				const next = clampZoom(startZoom * Math.exp((startY - e.clientY) * 0.008));
				this.camZoom = next;
				// Keep the point under the initial cursor fixed while zooming.
				this.camX = anchorContentX - anchorPX / next;
				this.camY = anchorContentY - anchorPY / next;
				this.updateCamera();
				return;
			}
			if (!panning) { return; }
			this.camX = startCamX - (e.clientX - startX) / this.camZoom;
			this.camY = startCamY - (e.clientY - startY) / this.camZoom;
			this.updateCamera();
		}));
		this._register(addDisposableListener(canvasWrap.ownerDocument, 'mouseup', () => {
			panning = false;
			zooming = false;
			canvasWrap.style.cursor = 'grab';
		}));
		this._register(addDisposableListener(canvasWrap, 'wheel', (e: WheelEvent) => {
			const rect = canvasWrap.getBoundingClientRect();
			if (e.ctrlKey || e.metaKey) {
				const pX = e.clientX - rect.left, pY = e.clientY - rect.top;
				const contentX = this.camX + pX / this.camZoom;
				const contentY = this.camY + pY / this.camZoom;
				this.camZoom = clampZoom(this.camZoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
				this.camX = contentX - pX / this.camZoom;
				this.camY = contentY - pY / this.camZoom;
			} else {
				// Plain wheel pans (vertical, plus horizontal if the device sends it).
				this.camX += e.deltaX / this.camZoom;
				this.camY += e.deltaY / this.camZoom;
			}
			this.updateCamera();
			e.preventDefault();
		}, { passive: false }));

		container.appendChild(canvasWrap);

		// Sequential review action bar (hidden until proposals exist).
		const bar = document.createElement('footer');
		bar.style.position = 'absolute';
		bar.style.left = '50%';
		bar.style.bottom = '32px';
		bar.style.transform = 'translateX(-50%)';
		bar.style.display = 'none';
		bar.style.gap = '8px';
		bar.style.padding = '12px 16px';
		bar.style.background = 'var(--vscode-editorWidget-background, #252526)';
		bar.style.border = '1px solid rgba(127,127,127,0.3)';
		bar.style.borderRadius = '8px';
		bar.style.boxShadow = '0 4px 18px rgba(0,0,0,0.35)';
		bar.style.alignItems = 'center';
		bar.style.zIndex = '20';
		this.sequentialBar = bar;
		container.appendChild(bar);

		// Edit panel (slide-in from right, within the pane).
		const edit = document.createElement('aside');
		edit.style.position = 'absolute';
		edit.style.top = '0';
		edit.style.right = '0';
		edit.style.bottom = '0';
		edit.style.width = '380px';
		edit.style.background = 'var(--vscode-editorWidget-background, #252526)';
		edit.style.borderLeft = '1px solid rgba(127,127,127,0.3)';
		edit.style.padding = '20px';
		edit.style.transform = 'translateX(100%)';
		edit.style.transition = 'transform 180ms ease';
		edit.style.display = 'flex';
		edit.style.flexDirection = 'column';
		edit.style.gap = '12px';
		edit.style.zIndex = '30';
		this.editPanel = edit;
		container.appendChild(edit);

		parent.appendChild(container);
		this.container = container;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		// Pull the initial snapshot — onDidChangeRoadmapState handles updates after.
		// Guarded: if the aria-roadmap extension hasn't activated yet (e.g. the
		// editor auto-opens on a fresh project window) the command may be missing;
		// we then just render empty and refresh when the extension fires its state.
		try {
			const initial = await this.commandService.executeCommand<Snapshot>('aria.roadmap.getState');
			if (token.isCancellationRequested) {
				return;
			}
			if (initial) {
				this.snapshot = initial;
			}
		} catch {
			// extension not ready — render empty for now
		}
		this.renderAll();
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
		// Viewport size changed → the viewBox depends on it.
		this.updateCamera();
	}

	/** Point the SVG viewBox at the current camera (pan + zoom). */
	private updateCamera(): void {
		const svg = this.canvasSvg;
		const wrap = this.canvasWrap;
		if (!svg || !wrap) { return; }
		const w = Math.max(1, wrap.clientWidth);
		const h = Math.max(1, wrap.clientHeight);
		svg.setAttribute('viewBox', `${this.camX} ${this.camY} ${w / this.camZoom} ${h / this.camZoom}`);
	}

	override focus(): void {
		super.focus();
		this.container?.focus();
	}

	private onStateChange(snapshot: unknown): void {
		if (!isSnapshot(snapshot)) {
			return;
		}
		this.snapshot = snapshot;
		this.renderAll();
	}

	/** The proposal currently under review — the first pending one (proposals
	 *  arrive sorted by creation time). Undefined when there is nothing to review. */
	private currentProposalId(): string | undefined {
		return this.snapshot.proposed[0]?.id;
	}

	private renderAll(): void {
		this.renderCanvas();
		this.renderSequentialBar();
		this.renderSaveButton();
		this.renderStarterCard();
	}

	/** Show the starter card only while the roadmap is completely empty. */
	private renderStarterCard(): void {
		if (!this.starterCard) { return; }
		const empty = this.snapshot.committed.length === 0 && this.snapshot.proposed.length === 0;
		this.starterCard.style.display = empty ? 'flex' : 'none';
	}

	private renderCanvas(): void {
		const svg = this.canvasSvg;
		if (!svg) { return; }
		while (svg.firstChild) { svg.removeChild(svg.firstChild); }

		const svgNS = 'http://www.w3.org/2000/svg';
		const laid = this.computeLayout();

		// Column headers — only the four named stages get a label; deeper
		// columns (sub-details) are intentionally unnamed. Centered over the card.
		// The Goal header also carries the "+" to add a new goal.
		this.snapshot.columnLabels.forEach((label, idx) => {
			const cx = columnX(idx) + COLUMN_WIDTH / 2;
			const text = document.createElementNS(svgNS, 'text');
			text.textContent = label;
			text.setAttribute('x', String(cx));
			text.setAttribute('y', '32');
			text.setAttribute('text-anchor', 'middle');
			text.setAttribute('fill', 'var(--vscode-foreground, #cccccc)');
			text.setAttribute('font-weight', '600');
			text.setAttribute('font-size', '13');
			text.setAttribute('opacity', '0.7');
			svg.appendChild(text);
			if (idx === 0) {
				this.drawHeaderAddButton(svg, cx + 30, 27);
			}
		});

		// Camera (viewBox) drives pan/zoom; nothing to size here.
		this.updateCamera();

		// Connections first (behind the cards).
		for (const node of laid) {
			if (node.parent === null) { continue; }
			const parent = laid.find(n => n.id === node.parent);
			if (!parent) { continue; }
			const path = document.createElementNS(svgNS, 'path');
			const x1 = parent.x + COLUMN_WIDTH;
			const y1 = parent.y + parent.height / 2;
			const x2 = node.x;
			const y2 = node.y + node.height / 2;
			const mid = (x1 + x2) / 2;
			path.setAttribute('d', `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
			path.setAttribute('stroke', node.proposed ? 'var(--vscode-charts-blue, #3b82f6)' : 'rgba(127,127,127,0.6)');
			path.setAttribute('stroke-width', '1.5');
			path.setAttribute('fill', 'none');
			if (node.proposed) {
				path.setAttribute('stroke-dasharray', '5 4');
			}
			svg.appendChild(path);
		}

		for (const node of laid) {
			this.drawNode(svg, node);
		}

		// "+ add child" buttons on every committed node — the tree can extend
		// arbitrarily deep, so even Detail (and beyond) nodes can sprout children.
		for (const node of laid) {
			if (node.proposed) { continue; }
			this.drawAddButton(svg, node);
		}
		// Goals are added via the "+" on the Goal column header (drawn above).
	}

	private computeLayout(): LaidOut[] {
		return computeRoadmapLayout(this.snapshot.committed, this.snapshot.proposed);
	}

	private drawNode(svg: SVGSVGElement, node: LaidOut): void {
		const svgNS = 'http://www.w3.org/2000/svg';
		const g = document.createElementNS(svgNS, 'g');
		g.setAttribute('transform', `translate(${node.x}, ${node.y})`);
		g.setAttribute('class', 'roadmap-interactive');
		g.style.cursor = 'pointer';

		// Only the proposal currently under review gets the focus ring.
		const isFocused = node.proposed && node.id === this.currentProposalId();

		const rect = document.createElementNS(svgNS, 'rect');
		rect.setAttribute('width', String(COLUMN_WIDTH));
		rect.setAttribute('height', String(node.height));
		rect.setAttribute('rx', '8');
		rect.setAttribute('ry', '8');
		rect.setAttribute('fill', node.proposed
			? 'rgba(59, 130, 246, 0.10)'
			: 'var(--vscode-editor-background, #1e1e1e)');
		rect.setAttribute('stroke', isFocused
			? 'var(--vscode-focusBorder, #007acc)'
			: node.proposed
				? 'var(--vscode-charts-blue, #3b82f6)'
				: 'rgba(127,127,127,0.5)');
		rect.setAttribute('stroke-width', isFocused ? '2.5' : '1.2');
		if (node.proposed) {
			rect.setAttribute('stroke-dasharray', '6 4');
		}
		g.appendChild(rect);

		// Full title, wrapped over as many lines as it needs, vertically centered
		// in the card. Description is not shown here — it opens in the edit panel.
		const label = document.createElementNS(svgNS, 'text');
		label.setAttribute('fill', 'var(--vscode-foreground, #cccccc)');
		label.setAttribute('font-size', '13');
		label.setAttribute('font-weight', '600');
		const blockHeight = node.lines.length * NODE_LINE_HEIGHT;
		const firstBaseline = (node.height - blockHeight) / 2 + NODE_LINE_HEIGHT - 4;
		node.lines.forEach((line, i) => {
			const tspan = document.createElementNS(svgNS, 'tspan');
			tspan.textContent = line;
			tspan.setAttribute('x', String(NODE_LABEL_PAD_X));
			tspan.setAttribute('y', String(firstBaseline + i * NODE_LINE_HEIGHT));
			label.appendChild(tspan);
		});
		g.appendChild(label);

		// kebab (⋮) — top-right corner. Opens a small action menu.
		const kebab = document.createElementNS(svgNS, 'text');
		kebab.textContent = '⋮';
		kebab.setAttribute('x', String(COLUMN_WIDTH - 16));
		kebab.setAttribute('y', '22');
		kebab.setAttribute('fill', 'var(--vscode-foreground, #cccccc)');
		kebab.setAttribute('font-size', '20');
		kebab.setAttribute('font-weight', '700');
		kebab.setAttribute('text-anchor', 'middle');
		kebab.style.cursor = 'pointer';
		kebab.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openKebabMenu(node, e.clientX, e.clientY);
		});
		g.appendChild(kebab);

		g.addEventListener('click', () => this.openEditPanel(node.id));

		svg.appendChild(g);
	}

	private drawAddButton(svg: SVGSVGElement, node: LaidOut): void {
		const svgNS = 'http://www.w3.org/2000/svg';
		const cx = node.x + COLUMN_WIDTH + 18;
		const cy = node.y + node.height / 2;
		const g = document.createElementNS(svgNS, 'g');
		g.setAttribute('class', 'roadmap-interactive');
		g.style.cursor = 'pointer';
		g.addEventListener('click', () => {
			void this.proposeChild(node);
		});

		const circle = document.createElementNS(svgNS, 'circle');
		circle.setAttribute('cx', String(cx));
		circle.setAttribute('cy', String(cy));
		circle.setAttribute('r', '11');
		circle.setAttribute('fill', 'var(--vscode-button-background, #0e639c)');
		circle.setAttribute('opacity', '0.85');
		g.appendChild(circle);

		const plus = document.createElementNS(svgNS, 'text');
		plus.textContent = '+';
		plus.setAttribute('x', String(cx));
		plus.setAttribute('y', String(cy + 4));
		plus.setAttribute('fill', 'var(--vscode-button-foreground, #fff)');
		plus.setAttribute('font-size', '14');
		plus.setAttribute('font-weight', '700');
		plus.setAttribute('text-anchor', 'middle');
		g.appendChild(plus);

		svg.appendChild(g);
	}

	/** The "+" next to the Goal column header — the single, uncluttered way to
	 *  add a top-level goal (replaces the old below-node button / placeholder). */
	private drawHeaderAddButton(svg: SVGSVGElement, cx: number, cy: number): void {
		const svgNS = 'http://www.w3.org/2000/svg';
		const g = document.createElementNS(svgNS, 'g');
		g.setAttribute('class', 'roadmap-interactive');
		g.style.cursor = 'pointer';
		g.addEventListener('click', () => { void this.proposeRoot(); });

		const circle = document.createElementNS(svgNS, 'circle');
		circle.setAttribute('cx', String(cx));
		circle.setAttribute('cy', String(cy));
		circle.setAttribute('r', '9');
		circle.setAttribute('fill', 'var(--vscode-button-background, #0e639c)');
		circle.setAttribute('opacity', '0.85');
		g.appendChild(circle);

		const plus = document.createElementNS(svgNS, 'text');
		plus.textContent = '+';
		plus.setAttribute('x', String(cx));
		plus.setAttribute('y', String(cy + 4));
		plus.setAttribute('fill', 'var(--vscode-button-foreground, #fff)');
		plus.setAttribute('font-size', '13');
		plus.setAttribute('font-weight', '700');
		plus.setAttribute('text-anchor', 'middle');
		g.appendChild(plus);

		svg.appendChild(g);
	}

	private renderSequentialBar(): void {
		const bar = this.sequentialBar;
		if (!bar) { return; }
		while (bar.firstChild) { bar.removeChild(bar.firstChild); }

		const remaining = this.snapshot.proposed.length;
		if (remaining === 0) {
			// No proposals left to review — the bar disappears on its own.
			bar.style.display = 'none';
			return;
		}

		bar.style.display = 'flex';

		const label = document.createElement('span');
		label.textContent = remaining === 1
			? '1 proposal to review'
			: `${remaining} proposals to review`;
		label.style.fontSize = '12px';
		label.style.opacity = '0.7';
		label.style.marginRight = '12px';
		bar.appendChild(label);

		const accept = this.makeButton('✓ Accept', 'primary', () => { void this.reviewAccept(); });
		const edit = this.makeButton('✏ Edit', 'ghost', () => this.reviewEdit());
		const del = this.makeButton('✗ Delete', 'ghost', () => { void this.reviewDelete(); });
		const acceptAll = this.makeButton('⏎ Accept All Remaining', 'ghost', () => { void this.reviewAcceptAll(); });
		bar.appendChild(accept);
		bar.appendChild(edit);
		bar.appendChild(del);
		bar.appendChild(acceptAll);
	}

	private renderSaveButton(): void {
		if (!this.saveButton) { return; }
		// Enabled as soon as there's at least one committed goal — the user is
		// never blocked waiting on the AI to "finalize".
		const ready = this.snapshot.committed.length > 0;
		this.saveButton.disabled = !ready;
		this.saveButton.style.opacity = ready ? '1' : '0.5';
		this.saveButton.title = ready
			? 'Save this roadmap.'
			: 'Add at least one goal to save the roadmap.';
	}

	private openKebabMenu(node: LaidOut, clientX: number, clientY: number): void {
		this.closeKebabMenu();
		const menu = document.createElement('div');
		menu.id = 'aria-roadmap-kebab';
		menu.style.position = 'fixed';
		menu.style.left = `${clientX}px`;
		menu.style.top = `${clientY}px`;
		menu.style.background = 'var(--vscode-editorWidget-background, #252526)';
		menu.style.border = '1px solid rgba(127,127,127,0.3)';
		menu.style.borderRadius = '6px';
		menu.style.padding = '4px 0';
		menu.style.boxShadow = '0 6px 22px rgba(0,0,0,0.4)';
		menu.style.zIndex = '40';
		menu.style.minWidth = '160px';

		const items = node.proposed
			? [
				{ label: 'Accept', action: () => this.commandService.executeCommand('aria.roadmap.acceptProposal', node.id) },
				{ label: 'Edit', action: () => this.openEditPanel(node.id) },
				{ label: 'Reject', action: () => this.commandService.executeCommand('aria.roadmap.rejectProposal', node.id) },
			]
			: [
				{ label: 'Edit', action: () => this.openEditPanel(node.id) },
				{ label: 'Mark in progress', action: () => this.commandService.executeCommand('aria.roadmap.updateNode', node.id, { status: 'in_progress' }) },
				{ label: 'Mark complete', action: () => this.commandService.executeCommand('aria.roadmap.updateNode', node.id, { status: 'done' }) },
				{ label: 'Delete', action: () => this.commandService.executeCommand('aria.roadmap.deleteNode', node.id) },
			];

		for (const item of items) {
			const row = document.createElement('div');
			row.textContent = item.label;
			row.style.padding = '8px 14px';
			row.style.fontSize = '12.5px';
			row.style.cursor = 'pointer';
			row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.15))'; });
			row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
			row.addEventListener('click', () => {
				this.closeKebabMenu();
				void item.action();
			});
			menu.appendChild(row);
		}

		// Mount inside the pane container — `position: fixed` keeps it anchored
		// to the cursor and it is cleaned up with the pane.
		(this.container ?? document.body).appendChild(menu);

		const dismiss = (e: MouseEvent) => {
			if (e.target instanceof Node && menu.contains(e.target)) { return; }
			this.closeKebabMenu();
			document.removeEventListener('click', dismiss, true);
		};
		setTimeout(() => document.addEventListener('click', dismiss, true), 0);
	}

	private closeKebabMenu(): void {
		const existing = this.container?.querySelector('#aria-roadmap-kebab');
		if (existing) { existing.remove(); }
	}

	private openEditPanel(id: string): void {
		const panel = this.editPanel;
		if (!panel) { return; }

		const node = this.snapshot.committed.find(n => n.id === id);
		const proposal = this.snapshot.proposed.find(p => p.id === id);
		if (!node && !proposal) { return; }
		const isProposal = !!proposal;
		const current = (node ?? proposal)!;

		while (panel.firstChild) { panel.removeChild(panel.firstChild); }

		const title = document.createElement('h2');
		title.textContent = isProposal ? 'Edit proposal' : 'Edit node';
		title.style.fontSize = '14px';
		title.style.fontWeight = '600';
		title.style.margin = '0';
		panel.appendChild(title);

		const labelInput = document.createElement('input');
		labelInput.type = 'text';
		labelInput.value = current.label;
		labelInput.placeholder = 'Label';
		this.styleInput(labelInput);
		panel.appendChild(this.fieldRow('Label', labelInput));

		const descInput = document.createElement('textarea');
		descInput.value = current.description ?? '';
		descInput.placeholder = 'Description (optional)';
		this.styleInput(descInput);
		descInput.style.minHeight = '120px';
		descInput.style.resize = 'vertical';
		panel.appendChild(this.fieldRow('Description', descInput));

		const actions = document.createElement('div');
		actions.style.display = 'flex';
		actions.style.gap = '8px';
		actions.style.marginTop = 'auto';
		actions.style.justifyContent = 'flex-end';

		const cancel = this.makeButton('Close', 'ghost', () => this.closeEditPanel());
		const save = this.makeButton('Save', 'primary', () => {
			const newLabel = labelInput.value.trim();
			const newDesc = descInput.value.trim();
			if (!newLabel) { return; }
			const cmd = isProposal ? 'aria.roadmap.updateProposal' : 'aria.roadmap.updateNode';
			void this.commandService.executeCommand(cmd, id, { label: newLabel, description: newDesc || undefined });
			this.closeEditPanel();
		});
		actions.appendChild(cancel);
		actions.appendChild(save);
		panel.appendChild(actions);

		panel.style.transform = 'translateX(0)';
	}

	private closeEditPanel(): void {
		if (!this.editPanel) { return; }
		this.editPanel.style.transform = 'translateX(100%)';
	}

	private fieldRow(labelText: string, input: HTMLElement): HTMLElement {
		const wrap = document.createElement('div');
		wrap.style.display = 'flex';
		wrap.style.flexDirection = 'column';
		wrap.style.gap = '6px';
		const lbl = document.createElement('label');
		lbl.textContent = labelText;
		lbl.style.fontSize = '12px';
		lbl.style.opacity = '0.75';
		wrap.appendChild(lbl);
		wrap.appendChild(input);
		return wrap;
	}

	private styleInput(el: HTMLInputElement | HTMLTextAreaElement): void {
		el.style.background = 'var(--vscode-input-background, rgba(0,0,0,0.2))';
		el.style.color = 'var(--vscode-input-foreground, #cccccc)';
		el.style.border = '1px solid var(--vscode-input-border, rgba(127,127,127,0.3))';
		el.style.borderRadius = '4px';
		el.style.padding = '8px 10px';
		el.style.fontSize = '13px';
		el.style.fontFamily = 'inherit';
		el.style.width = '100%';
		el.style.boxSizing = 'border-box';
	}

	private async proposeRoot(): Promise<void> {
		const label = await this.promptForLabel('Project goal');
		if (!label) { return; }
		void this.commandService.executeCommand('aria.roadmap.propose', {
			parent: null,
			column: 0,
			label,
		});
	}

	private async proposeChild(parent: LaidOut): Promise<void> {
		const label = await this.promptForLabel(this.snapshot.columnLabels[parent.column + 1] ?? 'Child');
		if (!label) { return; }
		void this.commandService.executeCommand('aria.roadmap.propose', {
			parent: parent.id,
			column: parent.column + 1,
			label,
		});
	}

	private async promptForLabel(_kind: string): Promise<string | undefined> {
		return new Promise(resolve => {
			const root = document.createElement('div');
			root.style.position = 'fixed';
			root.style.inset = '0';
			root.style.background = 'rgba(0,0,0,0.5)';
			root.style.zIndex = '50';
			root.style.display = 'flex';
			root.style.alignItems = 'center';
			root.style.justifyContent = 'center';

			const box = document.createElement('div');
			box.style.background = 'var(--vscode-editorWidget-background, #252526)';
			box.style.border = '1px solid rgba(127,127,127,0.3)';
			box.style.borderRadius = '8px';
			box.style.padding = '20px';
			box.style.minWidth = '360px';
			box.style.display = 'flex';
			box.style.flexDirection = 'column';
			box.style.gap = '12px';

			const title = document.createElement('div');
			title.textContent = 'Add node';
			title.style.fontSize = '14px';
			title.style.fontWeight = '600';
			box.appendChild(title);

			const input = document.createElement('input');
			input.placeholder = 'Label';
			this.styleInput(input);
			box.appendChild(input);

			const actions = document.createElement('div');
			actions.style.display = 'flex';
			actions.style.gap = '8px';
			actions.style.justifyContent = 'flex-end';
			const cancel = this.makeButton('Cancel', 'ghost', () => { root.remove(); resolve(undefined); });
			const ok = this.makeButton('Add', 'primary', () => { const v = input.value.trim(); root.remove(); resolve(v || undefined); });
			actions.appendChild(cancel);
			actions.appendChild(ok);
			box.appendChild(actions);

			root.appendChild(box);
			// `position: fixed` centers it on the viewport even though it is a
			// pane-container child; cleaned up with the pane.
			(this.container ?? document.body).appendChild(root);
			setTimeout(() => input.focus(), 0);
			input.addEventListener('keydown', e => {
				if (e.key === 'Enter') { const v = input.value.trim(); root.remove(); resolve(v || undefined); }
				if (e.key === 'Escape') { root.remove(); resolve(undefined); }
			});
		});
	}

	// Sequential review --------------------------------------------------
	// Each action targets the current proposal (the first pending one). The
	// command mutates state → onStateChange re-renders → the next proposal
	// becomes current automatically, so proposals are reviewed one at a time
	// and the bar clears itself once none remain.

	private async reviewAccept(): Promise<void> {
		const id = this.currentProposalId();
		if (!id) { return; }
		await this.commandService.executeCommand('aria.roadmap.acceptProposal', id);
	}

	private async reviewDelete(): Promise<void> {
		const id = this.currentProposalId();
		if (!id) { return; }
		await this.commandService.executeCommand('aria.roadmap.rejectProposal', id);
	}

	private reviewEdit(): void {
		const id = this.currentProposalId();
		if (!id) { return; }
		this.openEditPanel(id);
	}

	private async reviewAcceptAll(): Promise<void> {
		await this.commandService.executeCommand('aria.roadmap.acceptAllProposals');
	}

	// Save flow ----------------------------------------------------------

	private async save(): Promise<void> {
		// The project folder already exists (created at New Project time) and the
		// roadmap auto-persists on every change, so Save just makes that explicit
		// — write the current tree to <workspace>/.aria/roadmap.json and confirm.
		// No folder picker, no new window: the roadmap stays in this window and
		// the sidebar Roadmap tab reflects it.
		try {
			await this.commandService.executeCommand('aria.roadmap.persist');
		} catch (e) {
			this.notificationService.notify({
				severity: Severity.Error,
				message: `Could not save roadmap: ${(e as Error).message}`,
			});
			return;
		}
		this.notificationService.notify({
			severity: Severity.Info,
			message: 'Roadmap saved.',
		});
	}

	// Lifecycle ----------------------------------------------------------

	private async deleteRoadmap(): Promise<void> {
		// Destructive — confirm before wiping every node. The project folder
		// itself stays; only the roadmap content is cleared (and the now-empty
		// state auto-persists, so the saved file is emptied too).
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: 'Delete the entire roadmap?',
			detail: 'This removes every node from this roadmap. This cannot be undone.',
			primaryButton: 'Delete',
		});
		if (!confirmed) {
			return;
		}
		await this.commandService.executeCommand('aria.roadmap.reset');
	}

	private buildStarterCard(): HTMLElement {
		const card = document.createElement('div');
		card.className = 'roadmap-interactive'; // don't pan when interacting with the card
		// Centered on the canvas (both axes) so the empty-state prompt sits in
		// the middle of the viewport rather than the top-left.
		card.style.position = 'absolute';
		card.style.top = '50%';
		card.style.left = '50%';
		card.style.transform = 'translate(-50%, -50%)';
		card.style.width = 'calc(100% - 48px)';
		card.style.maxWidth = '560px';
		card.style.boxSizing = 'border-box';
		card.style.display = 'flex';
		card.style.flexDirection = 'column';
		card.style.gap = '10px';
		card.style.padding = '18px 20px';
		card.style.background = 'var(--vscode-editorWidget-background, #252526)';
		card.style.border = '1px solid var(--vscode-focusBorder, #007acc)';
		card.style.borderRadius = '10px';
		card.style.boxShadow = '0 6px 24px rgba(0,0,0,0.35)';
		card.style.zIndex = '15';

		const title = document.createElement('div');
		title.textContent = 'Start here';
		title.style.fontSize = '14px';
		title.style.fontWeight = '600';
		card.appendChild(title);

		const hint = document.createElement('div');
		hint.textContent = 'Paste the prompt below into the Claude Code chat on the right, fill in the “___”, and send. The AI will brainstorm with you and draw the roadmap here as you go.';
		hint.style.fontSize = '12.5px';
		hint.style.lineHeight = '1.5';
		hint.style.opacity = '0.8';
		card.appendChild(hint);

		const promptBox = document.createElement('pre');
		promptBox.textContent = STARTER_PROMPT;
		promptBox.style.margin = '0';
		promptBox.style.padding = '12px';
		promptBox.style.background = 'var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12))';
		promptBox.style.border = '1px solid rgba(127,127,127,0.25)';
		promptBox.style.borderRadius = '6px';
		promptBox.style.fontSize = '12.5px';
		promptBox.style.lineHeight = '1.5';
		promptBox.style.whiteSpace = 'pre-wrap';
		promptBox.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
		promptBox.style.userSelect = 'text';
		card.appendChild(promptBox);

		const actions = document.createElement('div');
		actions.style.display = 'flex';
		actions.style.alignItems = 'center';
		actions.style.gap = '10px';
		const copyButton = this.makeButton('Copy prompt', 'primary', () => {
			void this.clipboardService.writeText(STARTER_PROMPT);
			copyButton.textContent = 'Copied!';
			setTimeout(() => { copyButton.textContent = 'Copy prompt'; }, 1500);
		});
		actions.appendChild(copyButton);
		card.appendChild(actions);

		card.style.display = 'none'; // shown by renderStarterCard when empty
		return card;
	}

	private makeButton(label: string, variant: 'primary' | 'ghost', onclick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.textContent = label;
		btn.style.padding = '6px 14px';
		btn.style.fontSize = '12.5px';
		btn.style.borderRadius = '4px';
		btn.style.cursor = 'pointer';
		btn.style.fontFamily = 'inherit';
		if (variant === 'primary') {
			btn.style.background = 'var(--vscode-button-background, #0e639c)';
			btn.style.color = 'var(--vscode-button-foreground, #fff)';
			btn.style.border = '1px solid transparent';
		} else {
			btn.style.background = 'transparent';
			btn.style.color = 'var(--vscode-foreground, #cccccc)';
			btn.style.border = '1px solid rgba(127,127,127,0.4)';
		}
		btn.addEventListener('click', e => { e.stopPropagation(); onclick(); });
		return btn;
	}
}
