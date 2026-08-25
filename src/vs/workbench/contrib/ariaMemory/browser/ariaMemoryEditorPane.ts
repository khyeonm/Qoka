/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { onDidRequestAriaMemoryRefresh } from './ariaMemoryRefresh.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { applyAriaScrollbar } from '../../aria/browser/ariaScrollbar.js';
import { AriaMemoryEditorInput } from './ariaMemoryEditorInput.js';

/** Max content width so the page does not stretch across a wide editor. */
const MAX_WIDTH_PX = 820;

interface ProjectMemory { slug: string; title: string; type: string; body: string; updated?: string }

const PROJECT_TYPES = ['project', 'decision', 'feedback', 'reference', 'other'];

/**
 * The Memory page: two stacked sections in a centered, max-width column.
 *   - "This project" - the local wiki files (aria.memory.tab.project*).
 *   - "Global" - the user's mem0 store, needs sign-in (aria.memory.tab.global*).
 * Each section has a Refresh action on its header line and an inline editor; a
 * single search box filters that section's list. All copy is English.
 */
export class AriaMemoryEditorPane extends EditorPane {

	static readonly ID = AriaMemoryEditorInput.EDITOR_ID;

	private column: HTMLElement | undefined;
	private readonly sectionStore = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(AriaMemoryEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const root = document.createElement('div');
		Object.assign(root.style, {
			width: '100%', height: '100%', overflow: 'auto', boxSizing: 'border-box',
			color: 'var(--vscode-foreground)', fontSize: '13px',
			background: 'var(--vscode-editor-background, #1e1e1e)',
			fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
		});
		applyAriaScrollbar(root);
		parent.appendChild(root);

		const column = append(root, $('div'));
		Object.assign(column.style, {
			maxWidth: `${MAX_WIDTH_PX}px`, margin: '0 auto', padding: '20px 24px 48px', boxSizing: 'border-box',
		});
		const heading = append(column, $('div'));
		heading.textContent = 'Memory';
		Object.assign(heading.style, { fontSize: '22px', fontWeight: '600', margin: '4px 0 18px' });
		this.column = column;

		// A chat that saved/deleted a memory (via the MCP tools) fires
		// aria.memory.refresh; reload BOTH sections so the tab reflects it even when
		// it was already open.
		this._register(onDidRequestAriaMemoryRefresh(() => this.buildSections()));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.buildSections();
	}

	private buildSections(): void {
		const column = this.column;
		if (!column) { return; }
		this.sectionStore.clear();
		while (column.childElementCount > 1) { column.removeChild(column.lastElementChild!); }

		this.buildProjectSection(column, true);
		this.buildGlobalSection(column, false);
	}

	// --- shared UI helpers --------------------------------------------------

	/** A section shell: a header row (title left; an add "+" and a refresh icon at the
	 *  right end, like the Paper Library), a one-line explainer, and an empty body
	 *  element the caller fills. Returns the body. */
	private makeSection(column: HTMLElement, title: string, explainer: string, first: boolean, onAdd: () => void, onRefresh: () => void): HTMLElement {
		const wrap = append(column, $('div'));
		if (!first) {
			Object.assign(wrap.style, {
				borderTop: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.25))', marginTop: '26px', paddingTop: '22px',
				marginLeft: '-24px', marginRight: '-24px', paddingLeft: '24px', paddingRight: '24px',
			});
		}
		const head = append(wrap, $('div'));
		Object.assign(head.style, { display: 'flex', alignItems: 'center', gap: '12px', minHeight: '22px' });
		const titleEl = append(head, $('div'));
		titleEl.textContent = title;
		Object.assign(titleEl.style, { fontSize: '15px', fontWeight: '700', flex: '1 1 auto' });
		const addBtn = this.iconButton(head, 'add', 'Add a memory');
		addBtn.onclick = () => onAdd();
		const refreshBtn = this.iconButton(head, 'refresh', 'Reload this list');
		refreshBtn.onclick = () => onRefresh();

		const sub = append(wrap, $('div'));
		sub.textContent = explainer;
		Object.assign(sub.style, { fontSize: '12.5px', opacity: '0.65', margin: '6px 0 14px', lineHeight: '1.5' });

		return append(wrap, $('div'));
	}

	private styleSecondaryButton(btn: HTMLButtonElement): void {
		Object.assign(btn.style, {
			padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontFamily: 'inherit',
			border: '1px solid var(--vscode-button-border, transparent)',
			background: 'var(--vscode-button-secondaryBackground, rgba(127,127,127,0.2))',
			color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
		});
	}

	private stylePrimaryButton(btn: HTMLButtonElement): void {
		Object.assign(btn.style, {
			padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontFamily: 'inherit',
			border: '1px solid var(--vscode-button-border, transparent)',
			background: 'var(--vscode-button-background, #0e639c)',
			color: 'var(--vscode-button-foreground, #fff)',
		});
	}

	private makeSearch(parent: HTMLElement, onInput: (q: string) => void): void {
		const input = append(parent, $('input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = 'Search';
		Object.assign(input.style, {
			width: '100%', boxSizing: 'border-box', padding: '6px 10px', marginBottom: '12px',
			borderRadius: '4px', fontSize: '13px', fontFamily: 'inherit',
			border: '1px solid var(--vscode-input-border, rgba(127,127,127,0.3))',
			background: 'var(--vscode-input-background, rgba(127,127,127,0.08))',
			color: 'var(--vscode-input-foreground, var(--vscode-foreground))',
		});
		input.oninput = () => onInput(input.value.trim().toLowerCase());
	}

	private makeCardRow(parent: HTMLElement): HTMLElement {
		const row = append(parent, $('div'));
		Object.assign(row.style, {
			borderBottom: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.15))',
			padding: '9px 2px',
		});
		return row;
	}

	private emptyNote(parent: HTMLElement, text: string): void {
		const note = append(parent, $('div'));
		note.textContent = text;
		Object.assign(note.style, { opacity: '0.55', fontSize: '12.5px', padding: '10px 2px' });
	}

	// --- project memory (local wiki files) ---------------------------------

	private buildProjectSection(column: HTMLElement, first: boolean): void {
		let items: ProjectMemory[] = [];
		let query = '';

		const refresh = async () => {
			try {
				items = await this.commandService.executeCommand<ProjectMemory[]>('aria.memory.tab.projectList') ?? [];
			} catch {
				items = [];
			}
			renderList();
		};

		const ctx: { addHost?: HTMLElement } = {};
		const showAdd = () => {
			const host = ctx.addHost;
			if (!host) { return; }
			const form = this.buildProjectForm(undefined, async (data) => {
				await this.commandService.executeCommand('aria.memory.tab.projectSave', data);
				clearNode(host);
				await refresh();
			}, () => clearNode(host));
			clearNode(host);
			host.appendChild(form);
		};

		const body = this.makeSection(column, 'This project', 'Memory used only in this project.', first, showAdd, () => void refresh());
		ctx.addHost = append(body, $('div'));
		this.makeSearch(body, q => { query = q; renderList(); });
		const list = append(body, $('div'));

		const renderList = () => {
			clearNode(list);
			const filtered = items.filter(i =>
				!query || i.title.toLowerCase().includes(query) || i.body.toLowerCase().includes(query));
			if (!filtered.length) {
				this.emptyNote(list, items.length ? 'No matches.' : 'No memories saved yet.');
				return;
			}
			for (const item of filtered) {
				this.renderProjectItem(list, item, refresh);
			}
		};

		void refresh();
	}

	private buildProjectForm(existing: ProjectMemory | undefined, onSave: (data: { title: string; type: string; body: string; originalSlug?: string }) => Promise<void>, onCancel: () => void): HTMLElement {
		const form = $('div');
		Object.assign(form.style, { display: 'flex', flexDirection: 'column', gap: '8px', margin: '4px 0 14px', padding: '10px', borderRadius: '6px', border: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.25))' });

		const titleInput = append(form, $('input')) as HTMLInputElement;
		titleInput.type = 'text';
		titleInput.placeholder = 'Title';
		titleInput.value = existing?.title ?? '';
		this.styleField(titleInput);

		const typeSelect = append(form, $('select')) as HTMLSelectElement;
		this.styleField(typeSelect);
		const types = existing && !PROJECT_TYPES.includes(existing.type) ? [existing.type, ...PROJECT_TYPES] : PROJECT_TYPES;
		for (const t of types) {
			const opt = append(typeSelect, $('option')) as HTMLOptionElement;
			opt.value = t; opt.textContent = t;
		}
		typeSelect.value = existing?.type ?? 'project';

		const bodyArea = append(form, $('textarea')) as HTMLTextAreaElement;
		bodyArea.placeholder = 'What should Qoka remember about this project?';
		bodyArea.value = existing?.body ?? '';
		bodyArea.rows = 4;
		this.styleField(bodyArea);
		bodyArea.style.resize = 'vertical';

		this.formButtons(form,
			async () => {
				if (!titleInput.value.trim() || !bodyArea.value.trim()) { return; }
				await onSave({ title: titleInput.value.trim(), type: typeSelect.value, body: bodyArea.value.trim(), originalSlug: existing?.slug });
			},
			onCancel);
		return form;
	}

	private renderProjectItem(list: HTMLElement, item: ProjectMemory, refresh: () => Promise<void>): void {
		const row = this.makeCardRow(list);
		const header = append(row, $('div'));
		Object.assign(header.style, { display: 'flex', alignItems: 'center', gap: '10px' });

		const titleEl = append(header, $('div'));
		titleEl.textContent = item.title;
		Object.assign(titleEl.style, { fontWeight: '600', flex: '1 1 auto', cursor: 'pointer', fontSize: '13px' });

		const typeLabel = append(header, $('div'));
		typeLabel.textContent = item.type;
		Object.assign(typeLabel.style, { fontSize: '11px', opacity: '0.5' });

		const editBtn = this.iconButton(header, 'edit', 'Edit');
		const delBtn = this.iconButton(header, 'trash', 'Delete');

		const detail = append(row, $('div'));
		detail.style.display = 'none';
		Object.assign(detail.style, { marginTop: '6px', fontSize: '12.5px', opacity: '0.85', whiteSpace: 'pre-wrap', lineHeight: '1.5' });
		detail.textContent = item.body;

		titleEl.onclick = () => { detail.style.display = detail.style.display === 'none' ? 'block' : 'none'; };

		editBtn.onclick = () => {
			const form = this.buildProjectForm(item, async (data) => {
				await this.commandService.executeCommand('aria.memory.tab.projectSave', data);
				await refresh();
			}, () => void refresh());
			clearNode(row);
			row.appendChild(form);
		};
		delBtn.onclick = async () => {
			if (!(await this.confirmDelete(item.title))) { return; }
			try {
				await this.commandService.executeCommand('aria.memory.tab.projectDelete', item.slug);
				await refresh();
			} catch (e) { this.reportError(e); }
		};
	}

	// --- global memory (local wiki at ~/.qoka/memory/wiki, shared across projects) ---

	private buildGlobalSection(column: HTMLElement, first: boolean): void {
		let items: ProjectMemory[] = [];
		let query = '';

		const refresh = async () => {
			try {
				items = await this.commandService.executeCommand<ProjectMemory[]>('aria.memory.tab.globalList') ?? [];
			} catch {
				items = [];
			}
			renderList();
		};

		const ctx: { addHost?: HTMLElement } = {};
		const showAdd = () => {
			const host = ctx.addHost;
			if (!host) { return; }
			const form = this.buildGlobalForm(undefined, async (data) => {
				await this.commandService.executeCommand('aria.memory.tab.globalSave', data);
				clearNode(host);
				await refresh();
			}, () => clearNode(host));
			clearNode(host);
			host.appendChild(form);
		};

		const body = this.makeSection(column, 'Global', 'Things Qoka remembers about you across all your projects on this computer.', first, showAdd, () => void refresh());
		ctx.addHost = append(body, $('div'));
		this.makeSearch(body, q => { query = q; renderList(); });
		const list = append(body, $('div'));

		const renderList = () => {
			clearNode(list);
			const filtered = items.filter(i =>
				!query || i.title.toLowerCase().includes(query) || i.body.toLowerCase().includes(query));
			if (!filtered.length) {
				this.emptyNote(list, items.length ? 'No matches.' : 'No memories saved yet.');
				return;
			}
			for (const item of filtered) {
				this.renderGlobalItem(list, item, refresh);
			}
		};

		void refresh();
	}

	private buildGlobalForm(existing: ProjectMemory | undefined, onSave: (data: { title: string; type: string; body: string; originalSlug?: string }) => Promise<void>, onCancel: () => void): HTMLElement {
		const GLOBAL_TYPES = ['preference', 'identity', 'convention', 'reference'];
		const form = $('div');
		Object.assign(form.style, { display: 'flex', flexDirection: 'column', gap: '8px', margin: '4px 0 14px', padding: '10px', borderRadius: '6px', border: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.25))' });

		const titleInput = append(form, $('input')) as HTMLInputElement;
		titleInput.type = 'text';
		titleInput.placeholder = 'Title';
		titleInput.value = existing?.title ?? '';
		this.styleField(titleInput);

		const typeSelect = append(form, $('select')) as HTMLSelectElement;
		this.styleField(typeSelect);
		const types = existing && !GLOBAL_TYPES.includes(existing.type) ? [existing.type, ...GLOBAL_TYPES] : GLOBAL_TYPES;
		for (const t of types) {
			const opt = append(typeSelect, $('option')) as HTMLOptionElement;
			opt.value = t; opt.textContent = t;
		}
		typeSelect.value = existing?.type ?? 'preference';

		const bodyArea = append(form, $('textarea')) as HTMLTextAreaElement;
		bodyArea.placeholder = 'Something Qoka should remember about you (e.g. your field, how you like to work)';
		bodyArea.value = existing?.body ?? '';
		bodyArea.rows = 4;
		this.styleField(bodyArea);
		bodyArea.style.resize = 'vertical';

		this.formButtons(form,
			async () => {
				if (!titleInput.value.trim() || !bodyArea.value.trim()) { return; }
				await onSave({ title: titleInput.value.trim(), type: typeSelect.value, body: bodyArea.value.trim(), originalSlug: existing?.slug });
			},
			onCancel);
		return form;
	}

	private renderGlobalItem(list: HTMLElement, item: ProjectMemory, refresh: () => Promise<void>): void {
		const row = this.makeCardRow(list);
		const header = append(row, $('div'));
		Object.assign(header.style, { display: 'flex', alignItems: 'center', gap: '10px' });

		const titleEl = append(header, $('div'));
		titleEl.textContent = item.title;
		Object.assign(titleEl.style, { fontWeight: '600', flex: '1 1 auto', cursor: 'pointer', fontSize: '13px' });

		const typeLabel = append(header, $('div'));
		typeLabel.textContent = item.type;
		Object.assign(typeLabel.style, { fontSize: '11px', opacity: '0.5' });

		const editBtn = this.iconButton(header, 'edit', 'Edit');
		const delBtn = this.iconButton(header, 'trash', 'Delete');

		const detail = append(row, $('div'));
		detail.style.display = 'none';
		Object.assign(detail.style, { marginTop: '6px', fontSize: '12.5px', opacity: '0.85', whiteSpace: 'pre-wrap', lineHeight: '1.5' });
		detail.textContent = item.body;

		titleEl.onclick = () => { detail.style.display = detail.style.display === 'none' ? 'block' : 'none'; };

		editBtn.onclick = () => {
			const form = this.buildGlobalForm(item, async (data) => {
				await this.commandService.executeCommand('aria.memory.tab.globalSave', data);
				await refresh();
			}, () => void refresh());
			clearNode(row);
			row.appendChild(form);
		};
		delBtn.onclick = async () => {
			if (!(await this.confirmDelete(item.title))) { return; }
			try {
				await this.commandService.executeCommand('aria.memory.tab.globalDelete', item.slug);
				await refresh();
			} catch (e) { this.reportError(e); }
		};
	}

	// --- small shared widgets ----------------------------------------------

	private styleField(el: HTMLElement): void {
		Object.assign(el.style, {
			width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: '4px', fontSize: '13px', fontFamily: 'inherit',
			border: '1px solid var(--vscode-input-border, rgba(127,127,127,0.3))',
			background: 'var(--vscode-input-background, rgba(127,127,127,0.08))',
			color: 'var(--vscode-input-foreground, var(--vscode-foreground))',
		});
	}

	private iconButton(parent: HTMLElement, codicon: 'edit' | 'trash' | 'add' | 'refresh', title: string): HTMLElement {
		const btn = append(parent, $(`a.codicon.codicon-${codicon}`));
		Object.assign(btn.style, { cursor: 'pointer', opacity: '0.7', fontSize: '15px' });
		btn.title = title;
		(btn as HTMLElement).onmouseenter = () => { btn.style.opacity = '1'; };
		(btn as HTMLElement).onmouseleave = () => { btn.style.opacity = '0.7'; };
		return btn as HTMLElement;
	}

	private formButtons(form: HTMLElement, onSave: () => Promise<void>, onCancel: () => void): void {
		const bar = append(form, $('div'));
		Object.assign(bar.style, { display: 'flex', gap: '8px', marginTop: '2px' });
		const save = append(bar, $('button')) as HTMLButtonElement;
		save.textContent = 'Save';
		this.stylePrimaryButton(save);
		save.onclick = async () => {
			save.disabled = true;
			try { await onSave(); } catch (e) { save.disabled = false; this.reportError(e); }
		};
		const cancel = append(bar, $('button')) as HTMLButtonElement;
		cancel.textContent = 'Cancel';
		this.styleSecondaryButton(cancel);
		cancel.onclick = () => onCancel();
	}

	private async confirmDelete(name: string): Promise<boolean> {
		const { confirmed } = await this.dialogService.confirm({
			message: 'Delete this memory?',
			detail: name,
			primaryButton: 'Delete',
			type: 'warning',
		});
		return confirmed;
	}

	private reportError(e: unknown): void {
		this.notificationService.error((e as Error)?.message ?? String(e));
		console.error('[aria-memory-tab]', e);
	}

	override clearInput(): void {
		this.sectionStore.clear();
		if (this.column) {
			while (this.column.childElementCount > 1) { this.column.removeChild(this.column.lastElementChild!); }
		}
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this.column?.focus();
	}

	override layout(_dimension: Dimension): void {
		// Centered/max-width content scrolls on its own; nothing to size here.
	}
}
