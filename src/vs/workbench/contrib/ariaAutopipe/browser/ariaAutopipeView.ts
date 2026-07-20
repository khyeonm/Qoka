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
import { localize } from '../../../../nls.js';
import { IAction } from '../../../../base/common/actions.js';
import { IActionViewItem } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IDropdownMenuActionViewItemOptions } from '../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { ensureAriaPaneScrollbarStyle } from '../../ariaSkills/browser/ariaSkillsView.js';
import { renderAriaTabSummary, createAriaHelpTitleActionViewItem } from '../../aria/browser/ariaHelpEditor.js';

interface AiProviderState {
	kind: 'claude-code' | 'codex';
	displayName: string;
	installed: boolean;
	active: boolean;
}

interface AutopipeStatus {
	providers?: AiProviderState[];
	mcpServer?: { running: boolean; port: number | null };
	registration?: { ok: boolean; message: string };
	sshActiveProfileId?: string | null;
	sshActiveProfile?: string | null;
	sshProfiles?: { id: string; name: string; host: string; username: string; port: number }[];
	githubConnected?: boolean;
	githubLogin?: string | null;
	uploadMode?: 'per-pipeline' | 'single';
	uploadRepoName?: string;
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

/** Pending values for the unified "Save all changes" button. Anything the
 *  user can edit inline (without a dedicated multi-step form) goes here so
 *  it doesn't write to globalState until they explicitly commit. */
interface SettingsDraft {
	activeProfileId: string | null;
	uploadMode: 'per-pipeline' | 'single';
	uploadRepoName: string;
}

/**
 * Autopipe panel. Hosts:
 *   1. Title bar with the autopipe label and a small refresh button.
 *   2. Status section - installed AI assistant only (Claude Code / Codex).
 *   3. SSH section - profile dropdown + add-new inline form (password auth).
 *   4. GitHub section - connect/disconnect + upload-mode controls.
 *
 * Earlier iterations also showed CLI status, MCP server port, the Claude
 * Code registration string, and a separate "Autopipe Hub" section.
 * Removed per user request: those are internal details the user doesn't
 * need to see.
 */
export class AriaAutopipeView extends ViewPane {

	static readonly ID = 'aria.autopipe.main';

	private viewBody: HTMLElement | undefined;
	private sshFormOpen = false;
	private sshDraft: SshFormDraft = { ...EMPTY_DRAFT };
	private settingsDraft: SettingsDraft | null = null;
	private currentSnapshot: SettingsDraft | null = null;
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

	override createActionViewItem(action: IAction, options?: IDropdownMenuActionViewItemOptions): IActionViewItem | undefined {
		return createAriaHelpTitleActionViewItem(action, 'autopipe', options ?? {})
			?? super.createActionViewItem(action, options);
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
		// Fetch state first; swap DOM only when we have it. Otherwise the
		// panel blanks during every async hop, which the user perceives as
		// "the whole tab is reloading".
		let status: AutopipeStatus = {};
		try {
			status = (await this.commandService.executeCommand<AutopipeStatus>('aria.autopipe.getStatus', true)) ?? {};
		} catch {
			// extension still booting
		}
		try {
			this.vmStatus = await this.commandService.executeCommand('aria.autopipe.vm.status');
		} catch {
			this.vmStatus = undefined;
		}
		// Keep the built-in server row in sync with reality. While it's
		// downloading/booting, poll fast for progress. Also poll (slower) whenever
		// the built-in server is the active target but not yet ready - so a start
		// kicked off elsewhere (e.g. the assistant calling start_built_in_server
		// from chat) flips the row to "Running" on its own, without the user
		// reopening the tab. Stops once it's ready or no longer the target.
		const vmSt = this.vmStatus?.status;
		const vmIsActiveTarget = (status.sshActiveProfileId ?? null) === LOCAL_VM_ID;
		if (vmSt === 'provisioning' || vmSt === 'booting') {
			setTimeout(() => { void this.refresh(); }, 2000);
		} else if (vmIsActiveTarget && vmSt !== 'ready') {
			setTimeout(() => { void this.refresh(); }, 4000);
		}

		clearNode(root);

		// Full-width one-line summary. The container title bar already shows
		// "AUTOPIPE" and the "How to use?" link, so we don't repeat the title or a
		// description here - just keep the refresh control in the summary's slot.
		const summaryActions = renderAriaTabSummary(root, 'autopipe');
		if (summaryActions) {
			const refreshBtn = append(summaryActions, $('span.codicon.codicon-refresh')) as HTMLElement;
			refreshBtn.title = localize('aria.autopipe.refresh', "Refresh");
			refreshBtn.style.cursor = 'pointer';
			refreshBtn.style.opacity = '0.75';
			refreshBtn.style.padding = '2px 4px';
			refreshBtn.style.borderRadius = '3px';
			refreshBtn.onmouseenter = () => { refreshBtn.style.opacity = '1'; };
			refreshBtn.onmouseleave = () => { refreshBtn.style.opacity = '0.75'; };
			refreshBtn.onclick = () => { void this.refresh(); };
		}

		// Snapshot what's currently persisted so we can tell pending edits
		// apart from "matches current". Initialise the draft from the
		// snapshot on first render, or reuse the draft if the user is
		// mid-edit.
		this.currentSnapshot = {
			activeProfileId: status.sshActiveProfileId ?? null,
			uploadMode: status.uploadMode ?? 'per-pipeline',
			uploadRepoName: status.uploadRepoName ?? '',
		};
		if (this.settingsDraft === null) {
			this.settingsDraft = { ...this.currentSnapshot };
		}

		this.renderStatusSection(root, status);
		this.renderSshSection(root, status);
		this.renderGithubSection(root, status);
		// No Save button - every setting (run environment, upload mode, repo
		// name, GitHub) auto-saves the moment it changes.
		this.renderDivider(root);
		this.renderBrowseSection(root);
	}

	private renderDivider(root: HTMLElement): void {
		const divider = append(root, $('div'));
		divider.style.height = '1px';
		divider.style.background = 'var(--vscode-widget-border, transparent)';
		divider.style.margin = '12px 0 14px 0';
		divider.style.opacity = '0.6';
	}

	/**
	 * Two side-by-side launchers for the editor-area webviews. They open
	 * full-screen tabs because the actual browsing UX (pipeline grid /
	 * plugin manager) needs more room than the sidebar gives us.
	 */
	private renderBrowseSection(root: HTMLElement): void {
		const section = appendSection(root, 'Discover');
		const row = append(section, $('div'));
		row.style.display = 'flex';
		row.style.gap = '8px';
		row.style.marginTop = '4px';

		const hubBtn = append(row, $('button')) as HTMLButtonElement;
		hubBtn.textContent = 'Pipeline Hub';
		stylePrimaryButton(hubBtn);
		hubBtn.style.flex = '1';
		hubBtn.onclick = () => { void this.commandService.executeCommand('aria.autopipe.openHub'); };

		const pluginsBtn = append(row, $('button')) as HTMLButtonElement;
		pluginsBtn.textContent = 'Plugins';
		stylePrimaryButton(pluginsBtn);
		pluginsBtn.style.flex = '1';
		pluginsBtn.onclick = () => { void this.commandService.executeCommand('aria.autopipe.openPlugins'); };
	}

	private renderStatusSection(root: HTMLElement, status: AutopipeStatus): void {
		// No per-section refresh here - the single refresh in the summary row at
		// the top re-fetches status too (it calls refresh(), which re-runs
		// detection), so a freshly installed AI assistant shows up from there.
		const section = appendSection(root, 'Status');
		// Always show every supported provider so the user knows which AI
		// assistants Qoka works with - even the ones they haven't installed.
		// Color and label change to reflect installed-and-active vs
		// installed vs not installed.
		const providers = status.providers ?? [];
		if (providers.length === 0) {
			appendRow(section, false, 'Detecting AI assistants…');
			return;
		}
		for (const p of providers) {
			const label = !p.installed
				? `${p.displayName} (not installed)`
				: p.active
					? `${p.displayName} (active)`
					: `${p.displayName} (installed, not yet active)`;
			appendRow(section, p.installed && p.active, label);
		}
	}

	private renderSshSection(root: HTMLElement, status: AutopipeStatus): void {
		// Section with a header row that ends in a "+" add button on the
		// far right. The Add-profile form expands inline when the + is
		// pressed; clicking + again (it becomes ×) cancels.
		const section = appendSectionWithAction(root, 'Run environment', this.sshFormOpen ? 'x' : '+', () => {
			this.sshFormOpen = !this.sshFormOpen;
			this.sshDraft = { ...EMPTY_DRAFT };
			void this.refresh();
		});

		const desc = append(section, $('div'));
		desc.style.fontSize = '11px';
		desc.style.opacity = '0.7';
		desc.style.marginBottom = '8px';
		desc.textContent = isLinux
			? 'The AI builds and runs your pipelines and shows results. Press + to connect your lab server.'
			: 'The AI builds and runs your pipelines and shows results. Uses the built-in server, or press + to connect your own lab server.';

		const profiles = status.sshProfiles ?? [];
		const activeId = status.sshActiveProfileId ?? null;

		// Built-in local VM - the default target on Mac/Windows.
		this.renderBuiltInVmRow(section, activeId);

		// Each saved SSH profile as a selectable row, matching the built-in server
		// row: a radio dot on the left, the user's profile name as the title, and
		// user@host:port underneath in small text. Clicking selects it (active).
		for (const p of profiles) {
			const isActive = p.id === activeId;
			const row = append(section, $('div'));
			Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', cursor: 'pointer' });

			const dot = append(row, $('span'));
			Object.assign(dot.style, {
				width: '12px', height: '12px', borderRadius: '50%', flexShrink: '0', boxSizing: 'border-box',
				border: '1px solid', borderColor: isActive ? 'var(--vscode-focusBorder, #4098ff)' : 'var(--vscode-descriptionForeground)',
				background: isActive ? 'var(--vscode-focusBorder, #4098ff)' : 'transparent',
			});

			const text = append(row, $('div'));
			text.style.flex = '1';
			const title = append(text, $('div'));
			title.textContent = p.name;
			title.style.fontSize = '12px';
			const sub = append(text, $('div'));
			sub.textContent = `${p.username}@${p.host}:${p.port}`;
			Object.assign(sub.style, { fontSize: '10.5px', opacity: '0.6' });

			// Trash on the right (mirrors the built-in server's gear) removes this
			// server. Stops propagation so it doesn't also select the row.
			const trash = append(row, $('span.codicon.codicon-trash')) as HTMLElement;
			trash.title = 'Remove this server';
			Object.assign(trash.style, { cursor: 'pointer', opacity: '0.7', flexShrink: '0', padding: '2px' });
			trash.onclick = (e) => { e.stopPropagation(); void this.commandService.executeCommand('aria.autopipe.ssh.remove', p.id).then(() => this.refresh()); };

			row.onclick = () => { void this.commandService.executeCommand('aria.autopipe.ssh.setActiveById', p.id).then(() => this.refresh()); };
		}

		if (this.sshFormOpen) {
			this.renderSshForm(section);
		}
	}

	/** The "Qoka built-in" run target: a radio row whose subtitle shows live
	 *  status. Clicking it makes the built-in VM active and starts it; the gear
	 *  edits its memory/CPU. (Windows/macOS only - hidden on Linux.) */
	private renderBuiltInVmRow(section: HTMLElement, activeId: string | null): void {
		// The built-in server (local VM) is the default run environment only on
		// Windows/macOS. On Linux it isn't offered - those users connect an SSH
		// server instead - so don't render the row there.
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
			border: '1px solid', borderColor: isActive ? 'var(--vscode-focusBorder, #4098ff)' : 'var(--vscode-descriptionForeground)',
			background: isActive ? 'var(--vscode-focusBorder, #4098ff)' : 'transparent',
		});

		// Two lines only: title + one-line subtitle. No inline status text.
		const text = append(row, $('div'));
		text.style.flex = '1';
		const title = append(text, $('div'));
		title.textContent = 'Qoka built-in server';
		title.style.fontSize = '12px';
		// Subtitle carries the live status instead of a separate button: idle, or
		// downloading / starting / running / error while it's the active target.
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

		// Gear on the right → simple resource settings (memory / CPU) for the
		// built-in server. Stops propagation so it doesn't also toggle the row.
		const gear = append(row, $('span.codicon.codicon-settings-gear')) as HTMLElement;
		gear.title = 'Built-in server settings (memory, CPU)';
		Object.assign(gear.style, { cursor: 'pointer', opacity: '0.7', flexShrink: '0', padding: '2px' });
		gear.onclick = (e) => { e.stopPropagation(); void this.commandService.executeCommand('aria.autopipe.vm.editResources').then(() => this.refresh()); };

		// Clicking the row selects the built-in server AND starts it (idempotent;
		// downloads qemu/image on first use, retries after an error). No separate
		// "Set up" button - the subtitle shows progress, the gear restarts on change.
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

	private renderGithubSection(root: HTMLElement, status: AutopipeStatus): void {
		const section = appendSection(root, 'GitHub');
		const connected = status.githubConnected === true;

		if (connected) {
			// Stack the "Connected as @..." line and the Sign-out button on
			// the same row so the button hugs the right edge instead of
			// sitting awkwardly below the label.
			const row = append(section, $('div'));
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.gap = '8px';
			row.style.margin = '3px 0';

			const dot = append(row, $('span'));
			dot.style.width = '8px';
			dot.style.height = '8px';
			dot.style.borderRadius = '50%';
			dot.style.flexShrink = '0';
			dot.style.background = 'var(--vscode-charts-green, #4caf50)';

			const text = append(row, $('span'));
			text.style.flex = '1';
			text.textContent = status.githubLogin ? `Connected as @${status.githubLogin}` : 'Connected';

			const signOut = append(row, $('button')) as HTMLButtonElement;
			signOut.textContent = 'Sign out';
			styleSecondaryButton(signOut);
			signOut.style.marginTop = '0';
			signOut.style.marginRight = '0';
			signOut.onclick = async () => {
				try {
					await this.commandService.executeCommand('aria.autopipe.github.logout');
				} catch { /* command shows its own error */ }
				void this.refresh();
			};
		} else {
			appendRow(section, false, 'Not connected - needed to upload pipelines');
			const buttons = append(section, $('div'));
			buttons.style.marginTop = '8px';
			const btn = append(buttons, $('button')) as HTMLButtonElement;
			btn.textContent = 'Connect to GitHub';
			stylePrimaryButton(btn);
			btn.onclick = async () => {
				await this.commandService.executeCommand('aria.autopipe.github.login');
				void this.refresh();
			};
		}

		// Upload mode lives under the GitHub section because the choice
		// only matters once the user has GitHub credentials available.
		const subHeader = append(section, $('div'));
		subHeader.style.marginTop = '14px';
		subHeader.style.fontSize = '11.5px';
		subHeader.style.fontWeight = '600';
		subHeader.style.opacity = '0.9';
		subHeader.textContent = 'Pipeline upload mode';

		const note = append(section, $('p'));
		note.style.fontSize = '11px';
		note.style.opacity = '0.7';
		note.style.margin = '4px 0 6px 0';
		note.textContent = 'Whether each pipeline gets its own GitHub repo, or all share one.';

		const modeRow = append(section, $('div'));
		modeRow.style.display = 'flex';
		modeRow.style.gap = '12px';
		modeRow.style.fontSize = '12px';
		modeRow.style.marginTop = '2px';

		// Mode + repo name read from the draft so the user can toggle them
		// freely before pressing Save all changes at the bottom.
		const draftMode = this.settingsDraft?.uploadMode ?? status.uploadMode ?? 'per-pipeline';
		for (const opt of [
			{ value: 'per-pipeline' as const, label: 'Per-pipeline repo' },
			{ value: 'single' as const, label: 'Single shared repo' },
		]) {
			const wrap = append(modeRow, $('label'));
			wrap.style.display = 'flex';
			wrap.style.alignItems = 'center';
			wrap.style.gap = '4px';
			wrap.style.cursor = 'pointer';
			const radio = append(wrap, $('input')) as HTMLInputElement;
			radio.type = 'radio';
			radio.name = 'aria-autopipe-upload-mode';
			radio.checked = draftMode === opt.value;
			radio.onchange = () => {
				if (radio.checked) {
					if (this.settingsDraft) {
						this.settingsDraft.uploadMode = opt.value;
					}
					// Auto-save: apply the choice immediately (no Save button).
					void this.commandService.executeCommand('aria.autopipe.repo.setModeValue', opt.value)
						.then(() => this.refresh());
				}
			};
			const text = append(wrap, $('span'));
			text.textContent = opt.label;
		}

		if (draftMode === 'single') {
			const draftName = this.settingsDraft?.uploadRepoName ?? status.uploadRepoName ?? '';
			const repoInput = labelInput(section, 'Shared GitHub repo name', draftName, 'aria-pipelines',
				(v) => {
					if (this.settingsDraft) {
						this.settingsDraft.uploadRepoName = v;
					}
				});
			// Auto-save on blur (no Save button) - persist the typed name once
			// the user leaves the field rather than on every keystroke.
			repoInput.onchange = () => {
				void this.commandService.executeCommand('aria.autopipe.repo.setRepoName', repoInput.value.trim());
			};
		}
	}

	private addCommandButton(parent: HTMLElement, label: string, commandId: string): void {
		const btn = append(parent, $('button')) as HTMLButtonElement;
		btn.textContent = label;
		styleSecondaryButton(btn);
		btn.onclick = async () => {
			try {
				await this.commandService.executeCommand(commandId);
			} catch {
				// commands handle their own user notifications
			}
			void this.refresh();
		};
	}
}

function appendSection(root: HTMLElement, titleText: string): HTMLElement {
	const wrapper = append(root, $('div'));
	wrapper.style.border = '1px solid var(--vscode-widget-border, transparent)';
	wrapper.style.borderRadius = '4px';
	wrapper.style.padding = '10px 12px';
	wrapper.style.marginBottom = '10px';
	wrapper.style.background = 'var(--vscode-editorWidget-background)';
	const heading = append(wrapper, $('div'));
	heading.style.fontWeight = '600';
	heading.style.fontSize = '12px';
	heading.style.marginBottom = '6px';
	heading.textContent = titleText;
	return wrapper;
}

/** Map our short glyph names to actual VS Code codicon classes. Keeps
 *  callers from leaking knowledge of codicon-* class names. */
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
 * Same shape as `appendSection`, with a small action button (e.g. "+"/"x")
 * pinned to the right of the title row. Used for sections where the
 * primary action belongs at the section header rather than at the bottom
 * of the body (matches how Versions shows its inline + button).
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

	// Special-case the well-known glyph names so the caller can request
	// "refresh" or "add" and get a proper codicon (matches VS Code's view
	// toolbars). Everything else falls back to the literal glyph text.
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

function appendRow(parent: HTMLElement, ok: boolean, label: string): void {
	const row = append(parent, $('div'));
	row.style.display = 'flex';
	row.style.alignItems = 'center';
	row.style.gap = '8px';
	row.style.margin = '3px 0';
	const dot = append(row, $('span'));
	dot.style.width = '8px';
	dot.style.height = '8px';
	dot.style.borderRadius = '50%';
	dot.style.flexShrink = '0';
	dot.style.background = ok ? 'var(--vscode-charts-green, #4caf50)' : 'var(--vscode-charts-yellow, #e6c200)';
	const text = append(row, $('span'));
	text.style.flex = '1';
	text.textContent = label;
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
