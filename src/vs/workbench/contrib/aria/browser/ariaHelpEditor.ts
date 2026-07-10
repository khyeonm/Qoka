/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { IAction } from '../../../../base/common/actions.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ARIA_TAB_HELP, AriaTabKey } from './ariaTabHelp.js';

const ARIA_HELP_SCHEME = 'aria-help';

/** Editor input for a tab's "How to use" guide (rendered Markdown, read-only). */
export class AriaHelpInput extends EditorInput {

	static readonly ID = 'aria.help.editorInput';
	static readonly EDITOR_ID = 'aria.help.editorPane';

	private readonly _resource: URI;

	constructor(readonly key: AriaTabKey) {
		super();
		this._resource = URI.from({ scheme: ARIA_HELP_SCHEME, path: '/' + key });
	}

	override get typeId(): string { return AriaHelpInput.ID; }
	override get editorId(): string | undefined { return AriaHelpInput.EDITOR_ID; }
	override get resource(): URI { return this._resource; }
	override getName(): string {
		return localize('aria.help.tabName', "{0} — How to use", ARIA_TAB_HELP[this.key]?.title ?? this.key);
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) { return true; }
		return other instanceof AriaHelpInput && other.key === this.key;
	}
}

/** Renders a tab's `howTo` Markdown as a read-only, centered help page with a VS Code-styled scrollbar. */
export class AriaHelpEditorPane extends EditorPane {

	static readonly ID = AriaHelpInput.EDITOR_ID;

	private content: HTMLElement | undefined;
	private scrollable: DomScrollableElement | undefined;
	private readonly renderStore = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(AriaHelpEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const content = document.createElement('div');
		Object.assign(content.style, {
			boxSizing: 'border-box', padding: '24px 32px', maxWidth: '820px', margin: '0 auto',
			fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
			color: 'var(--vscode-foreground)', lineHeight: '1.6',
		});
		this.content = content;

		// Wrap in a DomScrollableElement so the page scrolls with VS Code's own
		// overlay scrollbar instead of the platform-native one.
		this.scrollable = this._register(new DomScrollableElement(content, {
			vertical: ScrollbarVisibility.Auto,
			horizontal: ScrollbarVisibility.Hidden,
			useShadows: true,
		}));
		parent.appendChild(this.scrollable.getDomNode());
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof AriaHelpInput) || !this.content) { return; }
		this.renderStore.clear();
		clearNode(this.content);
		const help = ARIA_TAB_HELP[input.key];
		if (!help) {
			append(this.content, $('p')).textContent = localize('aria.help.missing', "No help is available for this tab yet.");
		} else {
			const rendered = this.renderStore.add(renderMarkdown(new MarkdownString(help.howTo)));
			this.content.appendChild(rendered.element);
		}
		this.scrollable?.scanDomNode();
	}

	override clearInput(): void {
		this.renderStore.clear();
		if (this.content) { clearNode(this.content); }
		this.scrollable?.scanDomNode();
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		const node = this.scrollable?.getDomNode();
		if (node) {
			node.style.width = `${dimension.width}px`;
			node.style.height = `${dimension.height}px`;
		}
		this.scrollable?.scanDomNode();
	}
}

/** The command id that opens the how-to guide for a given tab. */
export function ariaHelpActionId(key: AriaTabKey): string {
	return `aria.tabHelp.show.${key}`;
}

const registeredHelpCommands = new Set<string>();

function ensureHelpCommand(key: AriaTabKey): string {
	const id = ariaHelpActionId(key);
	if (!registeredHelpCommands.has(id)) {
		registeredHelpCommands.add(id);
		CommandsRegistry.registerCommand(id, (accessor: ServicesAccessor) => {
			accessor.get(IEditorService).openEditor(new AriaHelpInput(key), { pinned: true });
		});
	}
	return id;
}

/**
 * Register the "How to use?" title-bar action for an Aria sidebar view. Call this
 * once at module-load time from the view's contribution, passing the view id and
 * its help key. It adds a `MenuId.ViewTitle` item (shown in the view's title bar,
 * to the right of the title) that opens the how-to guide. The view should render
 * it as a blue text link via `createAriaHelpTitleActionViewItem` in its
 * `createActionViewItem` override.
 */
export function registerAriaTabHelpTitleAction(viewId: string, key: AriaTabKey): void {
	const id = ensureHelpCommand(key);
	MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
		command: { id, title: localize('aria.tabHelp.howToUse', "How to use?") },
		when: ContextKeyExpr.equals('view', viewId),
		group: 'navigation',
		order: -1000,
	});
}

/**
 * Like `registerAriaTabHelpTitleAction`, but for a multi-view container whose
 * title bar shows the container name (not a merged single view). Adds a
 * `MenuId.ViewContainerTitle` item scoped to the container id. The container's
 * `ViewPaneContainer` must render it as a blue text link by overriding
 * `getActionViewItem` with `createAriaHelpTitleActionViewItem`.
 */
export function registerAriaTabHelpContainerTitleAction(containerId: string, key: AriaTabKey): void {
	const id = ensureHelpCommand(key);
	MenuRegistry.appendMenuItem(MenuId.ViewContainerTitle, {
		command: { id, title: localize('aria.tabHelp.howToUse', "How to use?") },
		when: ContextKeyExpr.equals('viewContainer', containerId),
		group: 'navigation',
		order: -1000,
	});
}

/** Custom title-bar action view item that renders "How to use?" as a blue text link. */
class AriaHelpTitleActionViewItem extends BaseActionViewItem {
	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('aria-tabhelp-title-action');
		const link = append(container, $('a'));
		link.textContent = this.action.label;
		link.setAttribute('role', 'button');
		link.tabIndex = 0;
		Object.assign(link.style, {
			cursor: 'pointer', color: 'var(--vscode-textLink-foreground)',
			fontSize: '11px', fontWeight: '600', whiteSpace: 'nowrap',
			padding: '0 6px', textDecoration: 'none',
		});
	}
}

/**
 * Build the "How to use?" title-bar link action view item for `key`, or return
 * undefined if `action` isn't the help action. Call from a view's
 * `createActionViewItem` override:
 *
 *   override createActionViewItem(action, options) {
 *     return createAriaHelpTitleActionViewItem(action, 'paper-library', options)
 *       ?? super.createActionViewItem(action, options);
 *   }
 */
export function createAriaHelpTitleActionViewItem(action: IAction, key: AriaTabKey, options: IBaseActionViewItemOptions): BaseActionViewItem | undefined {
	if (action.id !== ariaHelpActionId(key)) { return undefined; }
	return new AriaHelpTitleActionViewItem(undefined, action, options);
}

/**
 * Render the reusable one-line tab summary at the top of a view's sidebar body.
 * The summary text fills the width and sits directly under the title bar; a small
 * right-aligned action slot is returned so a view can drop an icon (e.g. refresh)
 * next to it. Call this FIRST where the view (re)builds its body content.
 */
export function renderAriaTabSummary(parent: HTMLElement, key: AriaTabKey): HTMLElement | undefined {
	const help = ARIA_TAB_HELP[key];
	if (!help) { return undefined; }
	const row = append(parent, $('div'));
	Object.assign(row.style, {
		display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
		margin: '0 0 10px', paddingBottom: '8px',
		borderBottom: '1px solid rgba(127,127,127,0.2)',
	});
	const summary = append(row, $('div'));
	summary.textContent = help.summary;
	Object.assign(summary.style, { fontSize: '12px', opacity: '0.8', lineHeight: '1.45', flex: '1', minWidth: '0' });
	const actions = append(row, $('div'));
	Object.assign(actions.style, { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: '0' });
	return actions;
}
