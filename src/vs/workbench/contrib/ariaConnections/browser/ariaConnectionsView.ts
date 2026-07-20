/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, $, clearNode } from '../../../../base/browser/dom.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { isLinux } from '../../../../base/common/platform.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ensureAriaPaneScrollbarStyle } from '../../ariaSkills/browser/ariaSkillsView.js';

/** Subset of aria.autopipe.getStatus that the Connections view needs. */
interface ConnectionsStatus {
	sshActiveProfileId?: string | null;
	sshProfiles?: { id: string; name: string; host: string; username: string; port: number }[];
}

/** Draft state for the in-panel SSH form. */
interface SshFormDraft {
	name: string;
	host: string;
	port: string;
	username: string;
	password: string;
	repoPath: string;
}

const EMPTY_DRAFT: SshFormDraft = {
	name: '', host: '', port: '22', username: '', password: '', repoPath: '',
};

/** Active-target id for the built-in local VM (mirrors LOCAL_VM_ID in the
 *  aria-autopipe extension's types; kept as a literal here to avoid a
 *  workbench→extension import). */
const LOCAL_VM_ID = '__local_vm__';

/**
 * Connections panel. The single place to choose WHERE the AI runs code: the
 * built-in server (WSL/VM) or a user-added SSH server. Both autopipe pipelines
 * and the qoka-run `run_code` tool follow the selected active target, so setting
 * it here once applies everywhere.
 *
 * This UI talks entirely through the aria.autopipe.* commands (ssh.* / vm.* /
 * getStatus) that already exist - it was extracted verbatim from the Autopipe
 * view so no backend change was needed.
 */
export class AriaConnectionsView extends ViewPane {

	static readonly ID = 'aria.connections.main';

	private viewBody: HTMLElement | undefined;
	private sshFormOpen = false;
	private sshDraft: SshFormDraft = { ...EMPTY_DRAFT };
	/** When set, the inline edit form for that SSH profile id is open below its row. */
	private editingId: string | undefined;
	private editDraft: SshFormDraft = { ...EMPTY_DRAFT };
	/** Live status of the built-in VM (from aria.autopipe.vm.status). */
	private vmStatus: { status: string; error?: string; progress?: { message: string; pct?: number } } | undefined;

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
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		ensureAriaPaneScrollbarStyle();
		const root = append(container, $('div'));
		root.classList.add('aria-themed-scrollable');
		root.style.padding = '12px';
		root.style.fontSize = '12px';
		root.style.lineHeight = '1.55';
		root.style.color = 'var(--vscode-foreground)';
		root.style.boxSizing = 'border-box';
		root.style.overflowY = 'auto';
		root.style.overflowX = 'hidden';
		root.style.wordBreak = 'break-word';
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

	private async refresh(): Promise<void> {
		const root = this.viewBody;
		if (!root) {
			return;
		}
		let status: ConnectionsStatus = {};
		try {
			status = (await this.commandService.executeCommand<ConnectionsStatus>('aria.autopipe.getStatus', true)) ?? {};
		} catch {
			// extension still booting
		}
		try {
			this.vmStatus = await this.commandService.executeCommand('aria.autopipe.vm.status');
		} catch {
			this.vmStatus = undefined;
		}
		// While the built-in server is downloading/booting, poll fast for progress;
		// poll slower whenever it's the active target but not yet ready, so a start
		// kicked off elsewhere (e.g. the assistant calling start_built_in_server)
		// flips the row to "Running" on its own. Stops once ready / not the target.
		const vmSt = this.vmStatus?.status;
		const vmIsActiveTarget = (status.sshActiveProfileId ?? null) === LOCAL_VM_ID;
		if (vmSt === 'provisioning' || vmSt === 'booting') {
			setTimeout(() => { void this.refresh(); }, 2000);
		} else if (vmIsActiveTarget && vmSt !== 'ready') {
			setTimeout(() => { void this.refresh(); }, 4000);
		}

		clearNode(root);
		this.renderServersSection(root, status);
	}

	private renderServersSection(root: HTMLElement, status: ConnectionsStatus): void {
		// Section with a header row that ends in a "+" add button on the far right.
		// The Add-profile form expands inline when + is pressed; + becomes × to cancel.
		const section = appendSectionWithAction(root, 'Servers', this.sshFormOpen ? 'x' : '+', () => {
			this.sshFormOpen = !this.sshFormOpen;
			this.sshDraft = { ...EMPTY_DRAFT };
			this.editingId = undefined; // opening the add form closes any open edit form
			void this.refresh();
		});

		const desc = append(section, $('div'));
		desc.style.fontSize = '11px';
		desc.style.opacity = '0.7';
		desc.style.marginBottom = '8px';
		desc.textContent = isLinux
			? 'Manage where your code runs. Press + to connect an SSH server to run there.'
			: 'Manage where your code runs. Use the built-in server, or connect an SSH server to run there.';

		const profiles = status.sshProfiles ?? [];
		const activeId = status.sshActiveProfileId ?? null;

		// Built-in local VM - the default target on Mac/Windows.
		this.renderBuiltInVmRow(section, activeId);

		// Each saved SSH profile as a selectable row: a radio dot on the left, the
		// profile name as the title, user@host:port underneath. Clicking selects it.
		for (const p of profiles) {
			const isActive = p.id === activeId;
			const row = append(section, $('div'));
			Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', cursor: 'pointer' });

			const dot = append(row, $('span'));
			Object.assign(dot.style, {
				width: '12px', height: '12px', borderRadius: '50%', flexShrink: '0', boxSizing: 'border-box',
				border: '1px solid',
				// Green circle when this SSH server is the active (connected) target;
				// no color otherwise.
				borderColor: isActive ? 'var(--vscode-charts-green, #4caf50)' : 'var(--vscode-descriptionForeground)',
				background: isActive ? 'var(--vscode-charts-green, #4caf50)' : 'transparent',
			});

			const text = append(row, $('div'));
			text.style.flex = '1';
			const title = append(text, $('div'));
			title.textContent = p.name;
			title.style.fontSize = '12px';
			const sub = append(text, $('div'));
			sub.textContent = `${p.username}@${p.host}:${p.port}`;
			Object.assign(sub.style, { fontSize: '10.5px', opacity: '0.6' });

			// Edit (pencil) - left of the trash. Opens an inline edit form (like the
			// + add form) below this row, pre-filled with the server's fields.
			const edit = append(row, $('span.codicon.codicon-edit')) as HTMLElement;
			edit.title = 'Edit this server';
			Object.assign(edit.style, { cursor: 'pointer', opacity: '0.7', flexShrink: '0', padding: '2px' });
			edit.onclick = async (e) => {
				e.stopPropagation();
				if (this.editingId === p.id) { this.editingId = undefined; void this.refresh(); return; }
				const full = await this.commandService.executeCommand<{ name: string; host: string; port: number; username: string; repoPath: string } | null>('aria.autopipe.ssh.getProfile', p.id);
				this.editingId = p.id;
				this.sshFormOpen = false;
				this.editDraft = {
					name: full?.name ?? p.name,
					host: full?.host ?? p.host,
					port: String(full?.port ?? p.port),
					username: full?.username ?? p.username,
					password: '',
					repoPath: full?.repoPath ?? '',
				};
				void this.refresh();
			};

			const trash = append(row, $('span.codicon.codicon-trash')) as HTMLElement;
			trash.title = 'Remove this server';
			Object.assign(trash.style, { cursor: 'pointer', opacity: '0.7', flexShrink: '0', padding: '2px' });
			trash.onclick = (e) => { e.stopPropagation(); void this.commandService.executeCommand('aria.autopipe.ssh.remove', p.id).then(() => this.refresh()); };

			row.onclick = () => { void this.commandService.executeCommand('aria.autopipe.ssh.setActiveById', p.id).then(() => this.refresh()); };

			if (this.editingId === p.id) {
				this.renderEditForm(section, p.id);
			}
		}

		if (this.sshFormOpen) {
			this.renderSshForm(section);
		}
	}

	/** The "Qoka built-in" run target: a radio row whose subtitle shows live
	 *  status. Clicking it makes the built-in VM active and starts it; the gear
	 *  edits its memory/CPU. (Windows/macOS only - hidden on Linux.) */
	private renderBuiltInVmRow(section: HTMLElement, activeId: string | null): void {
		if (isLinux) {
			return;
		}
		const isActive = activeId === LOCAL_VM_ID;
		const st = this.vmStatus?.status ?? 'stopped';

		const row = append(section, $('div'));
		Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', cursor: 'pointer' });

		const dot = append(row, $('span'));
		Object.assign(dot.style, {
			width: '12px', height: '12px', borderRadius: '50%', flexShrink: '0', boxSizing: 'border-box',
			border: '1px solid',
			// Status light: green when the built-in server is active AND ready (usable),
			// red when active but not yet usable, and NO color when an SSH server is the
			// active target instead (the built-in isn't the one in use).
			borderColor: isActive ? (st === 'ready' ? 'var(--vscode-charts-green, #4caf50)' : 'var(--vscode-charts-red, #f14c4c)') : 'var(--vscode-descriptionForeground)',
			background: isActive ? (st === 'ready' ? 'var(--vscode-charts-green, #4caf50)' : 'var(--vscode-charts-red, #f14c4c)') : 'transparent',
		});

		const text = append(row, $('div'));
		text.style.flex = '1';
		const title = append(text, $('div'));
		title.textContent = 'Qoka built-in server';
		title.style.fontSize = '12px';
		const sub = append(text, $('div'));
		let subText = 'Runs on this computer - no server needed';
		if (isActive) {
			if (st === 'provisioning') {
				subText = this.vmStatus?.progress?.pct != null ? `Downloading ${this.vmStatus.progress.pct}%…` : 'Preparing…';
			} else if (st === 'booting') {
				subText = 'Starting…';
			} else if (st === 'error') {
				subText = 'Not running';
			} else if (st === 'ready') {
				subText = 'Running on this computer';
			}
		}
		sub.textContent = subText;
		Object.assign(sub.style, { fontSize: '10.5px', opacity: '0.6' });

		const gear = append(row, $('span.codicon.codicon-settings-gear')) as HTMLElement;
		gear.title = 'Built-in server settings (memory, CPU)';
		Object.assign(gear.style, { cursor: 'pointer', opacity: '0.7', flexShrink: '0', padding: '2px' });
		gear.onclick = (e) => { e.stopPropagation(); void this.commandService.executeCommand('aria.autopipe.vm.editResources').then(() => this.refresh()); };

		row.onclick = () => { void this.commandService.executeCommand('aria.autopipe.vm.setup').then(() => this.refresh()); };
	}

	private renderSshForm(parent: HTMLElement): void {
		const form = append(parent, $('div'));
		form.style.marginTop = '10px';
		form.style.borderTop = '1px solid var(--vscode-widget-border, transparent)';
		form.style.paddingTop = '10px';

		labelInput(form, 'Name', this.sshDraft.name, 'e.g. lab server', (v) => { this.sshDraft.name = v; });
		labelInput(form, 'Host', this.sshDraft.host, 'server.example.com or 10.0.0.5', (v) => { this.sshDraft.host = v; });
		labelInput(form, 'Port', this.sshDraft.port, '22', (v) => { this.sshDraft.port = v; });
		labelInput(form, 'Username', this.sshDraft.username, 'remote login', (v) => { this.sshDraft.username = v; });
		const pwInput = labelInput(form, 'Password', this.sshDraft.password, 'remote login password', (v) => { this.sshDraft.password = v; });
		pwInput.type = 'password';

		labelInput(form, 'Remote workspace directory', this.sshDraft.repoPath, '/home/you/aria', (v) => { this.sshDraft.repoPath = v; });

		const buttons = append(form, $('div'));
		buttons.style.marginTop = '10px';

		const saveBtn = append(buttons, $('button')) as HTMLButtonElement;
		saveBtn.textContent = 'Save profile';
		stylePrimaryButton(saveBtn);
		saveBtn.onclick = () => void this.saveSshProfile();

		const cancelBtn = append(buttons, $('button')) as HTMLButtonElement;
		cancelBtn.textContent = 'Cancel';
		styleSecondaryButton(cancelBtn);
		cancelBtn.onclick = () => {
			this.sshFormOpen = false;
			this.sshDraft = { ...EMPTY_DRAFT };
			void this.refresh();
		};
	}

	private async saveSshProfile(): Promise<void> {
		const d = this.sshDraft;
		if (!d.name || !d.host || !d.username || !d.password || !d.repoPath) {
			void this.commandService.executeCommand('workbench.action.showErrorMessage', 'Fill in name, host, username, password, and remote workspace directory.');
			return;
		}
		const port = Number(d.port);
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			void this.commandService.executeCommand('workbench.action.showErrorMessage', 'Port must be 1–65535.');
			return;
		}

		try {
			await this.commandService.executeCommand('aria.autopipe.ssh.saveFromDraft', {
				name: d.name, host: d.host, port,
				username: d.username, auth: 'password', password: d.password,
				repoPath: d.repoPath,
			});
		} catch {
			return;
		}
		this.sshFormOpen = false;
		this.sshDraft = { ...EMPTY_DRAFT };
		void this.refresh();
	}

	/** Inline edit form for an existing SSH server (like the add form). Pre-filled
	 *  from getProfile; password left blank keeps the current one. */
	private renderEditForm(parent: HTMLElement, id: string): void {
		const form = append(parent, $('div'));
		form.style.marginTop = '8px';
		form.style.marginBottom = '8px';
		form.style.marginLeft = '20px';
		form.style.borderLeft = '2px solid var(--vscode-focusBorder, #4098ff)';
		form.style.paddingLeft = '10px';

		labelInput(form, 'Name', this.editDraft.name, 'e.g. lab server', (v) => { this.editDraft.name = v; });
		labelInput(form, 'Host', this.editDraft.host, 'server.example.com', (v) => { this.editDraft.host = v; });
		labelInput(form, 'Port', this.editDraft.port, '22', (v) => { this.editDraft.port = v; });
		labelInput(form, 'Username', this.editDraft.username, 'remote login', (v) => { this.editDraft.username = v; });
		const pw = labelInput(form, 'Password (leave blank to keep current)', this.editDraft.password, '••••••••', (v) => { this.editDraft.password = v; });
		pw.type = 'password';
		labelInput(form, 'Remote workspace directory', this.editDraft.repoPath, '/home/you/aria', (v) => { this.editDraft.repoPath = v; });

		const buttons = append(form, $('div'));
		buttons.style.marginTop = '10px';
		const save = append(buttons, $('button')) as HTMLButtonElement;
		save.textContent = 'Save changes';
		stylePrimaryButton(save);
		save.onclick = () => void this.saveEdit(id);
		const cancel = append(buttons, $('button')) as HTMLButtonElement;
		cancel.textContent = 'Cancel';
		styleSecondaryButton(cancel);
		cancel.onclick = () => { this.editingId = undefined; void this.refresh(); };
	}

	private async saveEdit(id: string): Promise<void> {
		const d = this.editDraft;
		if (!d.name || !d.host || !d.username || !d.repoPath) {
			void this.commandService.executeCommand('workbench.action.showErrorMessage', 'Fill in name, host, username, and remote workspace directory.');
			return;
		}
		const port = Number(d.port);
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			void this.commandService.executeCommand('workbench.action.showErrorMessage', 'Port must be 1–65535.');
			return;
		}
		try {
			await this.commandService.executeCommand('aria.autopipe.ssh.saveFromDraft', {
				id, name: d.name, host: d.host, port,
				username: d.username, auth: 'password', password: d.password || undefined,
				repoPath: d.repoPath,
			});
		} catch {
			return;
		}
		this.editingId = undefined;
		void this.refresh();
	}
}

/** Map our short glyph names to actual VS Code codicon classes. */
const CODICON_GLYPHS: Record<string, string> = {
	refresh: 'refresh',
	add: 'add',
};

const ACTION_TITLES: Record<string, string> = {
	'+': 'Add',
	'x': 'Close',
	refresh: 'Refresh',
};

/**
 * A bordered section card with a small action button (e.g. "+"/"x") pinned to
 * the right of the title row.
 */
function appendSectionWithAction(root: HTMLElement, titleText: string, actionGlyph: string, onClick: () => void): HTMLElement {
	const wrapper = append(root, $('div'));
	wrapper.style.border = '1px solid var(--vscode-widget-border, transparent)';
	wrapper.style.borderRadius = '4px';
	wrapper.style.padding = '10px 12px';
	wrapper.style.marginBottom = '10px';
	wrapper.style.background = 'var(--vscode-editorWidget-background)';

	const headRow = append(wrapper, $('div'));
	headRow.style.display = 'flex';
	headRow.style.alignItems = 'center';
	headRow.style.justifyContent = 'space-between';
	headRow.style.marginBottom = '6px';

	const heading = append(headRow, $('div'));
	heading.style.fontWeight = '600';
	heading.style.fontSize = '12px';
	heading.textContent = titleText;

	const codiconName = CODICON_GLYPHS[actionGlyph];
	let actionBtn: HTMLElement;
	if (codiconName) {
		actionBtn = append(headRow, $('span.codicon.codicon-' + codiconName)) as HTMLElement;
	} else {
		actionBtn = append(headRow, $('span')) as HTMLElement;
		actionBtn.textContent = actionGlyph;
	}
	actionBtn.title = ACTION_TITLES[actionGlyph] ?? actionGlyph;
	actionBtn.style.cursor = 'pointer';
	actionBtn.style.fontSize = '16px';
	actionBtn.style.lineHeight = '1';
	actionBtn.style.padding = '2px 8px';
	actionBtn.style.borderRadius = '3px';
	actionBtn.style.opacity = '0.75';
	actionBtn.style.userSelect = 'none';
	actionBtn.onmouseenter = () => { actionBtn.style.opacity = '1'; actionBtn.style.background = 'var(--vscode-toolbar-hoverBackground, transparent)'; };
	actionBtn.onmouseleave = () => { actionBtn.style.opacity = '0.75'; actionBtn.style.background = 'transparent'; };
	actionBtn.onclick = onClick;
	return wrapper;
}

function labelInput(parent: HTMLElement, labelText: string, value: string, placeholder: string, onInput: (v: string) => void): HTMLInputElement {
	const wrap = append(parent, $('div'));
	wrap.style.marginTop = '6px';
	const label = append(wrap, $('div'));
	label.style.fontSize = '11px';
	label.style.opacity = '0.85';
	label.textContent = labelText;
	const input = append(wrap, $('input')) as HTMLInputElement;
	input.type = 'text';
	input.value = value;
	input.placeholder = placeholder;
	input.style.width = '100%';
	input.style.boxSizing = 'border-box';
	input.style.padding = '4px 6px';
	input.style.fontSize = '12px';
	input.style.background = 'var(--vscode-input-background)';
	input.style.color = 'var(--vscode-input-foreground)';
	input.style.border = '1px solid var(--vscode-input-border, transparent)';
	input.style.borderRadius = '3px';
	input.style.marginTop = '2px';
	input.oninput = () => onInput(input.value);
	return input;
}

function stylePrimaryButton(btn: HTMLButtonElement): void {
	btn.style.padding = '4px 10px';
	btn.style.fontSize = '12px';
	btn.style.cursor = 'pointer';
	btn.style.borderRadius = '3px';
	btn.style.marginRight = '6px';
	btn.style.marginTop = '4px';
	btn.style.color = 'var(--vscode-button-foreground)';
	btn.style.background = 'var(--vscode-button-background)';
	btn.style.border = '1px solid transparent';
}

function styleSecondaryButton(btn: HTMLButtonElement): void {
	btn.style.padding = '4px 10px';
	btn.style.fontSize = '12px';
	btn.style.cursor = 'pointer';
	btn.style.borderRadius = '3px';
	btn.style.marginRight = '6px';
	btn.style.marginTop = '4px';
	btn.style.color = 'var(--vscode-foreground)';
	btn.style.background = 'transparent';
	btn.style.border = '1px solid var(--vscode-widget-border, var(--vscode-foreground))';
	btn.style.opacity = '0.85';
}
