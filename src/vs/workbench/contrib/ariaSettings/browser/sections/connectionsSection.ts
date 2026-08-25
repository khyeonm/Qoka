/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { isLinux, isWindows } from '../../../../../base/common/platform.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { SettingsSection } from './settingsSection.js';

interface SshProfile { id: string; name: string; host: string; username: string; port: number }
interface ConnectionsStatus { sshProfiles?: SshProfile[]; sshActiveProfileId?: string | null }
interface Probe { kind?: string; connected?: boolean }
/** Lifecycle of the built-in server, from `aria.autopipe.vm.status`. */
interface VmStatus { status?: string; progress?: { message?: string; pct?: number } }
/** From `aria.autopipe.vm.wslProbe`: whether the WSL engine and an Ubuntu distro are
 *  actually installed, so a not-connected row can say "install" vs "not connected". */
interface WslProbe { wsl?: boolean; ubuntu?: boolean; serviceError?: boolean }

const LOCAL_VM_ID = '__local_vm__';

/** User-facing name for the built-in local run target, by platform. The row is
 *  hidden on Linux, so only Windows (WSL) and Mac (vfkit) are shown. */
const BUILTIN_LABEL = isWindows ? 'Local (WSL)' : 'Local (vfkit)';

interface Draft { name: string; host: string; port: string; username: string; password: string; repoPath: string }
const EMPTY_DRAFT: Draft = { name: '', host: '', port: '22', username: '', password: '', repoPath: '' };

/**
 * Subtitle for the built-in server row.
 *
 * It used to read "built-in", which describes what the row IS and tells the user
 * nothing about whether their code can actually run there. Report the live state
 * instead, in the same words the Connections tab uses.
 *
 * `reachable` is undefined until the background probe answers, so the row shows
 * the lifecycle state first and firms up to connected / not connected after.
 */
// On Windows the built-in server IS a WSL2 Ubuntu distro, so when it isn't set up
// yet (error, or stopped without ever coming up - e.g. the user pressed "Continue
// without the run environment" during first-run setup) the row should say so. This
// only appears in the not-ready states: once WSL + Ubuntu are installed and the
// server is 'ready', the row reads "Connected", never this.
const WSL_NEEDED_TEXT = 'WSL and Ubuntu must be installed to use Local (WSL). See qoka.org for setup instructions.';

/** Did the user press "Continue without the run environment" during setup? A
 *  skipped user who is now 'stopped' means WSL/Ubuntu was never set up (a ready
 *  environment would have auto-started), so the row should point them at setup. */
function wslSetupSkipped(): boolean {
	try { return localStorage.getItem('aria.autopipe.wslSetupSkipped') === '1'; } catch { return false; }
}

/** The not-connected message on Windows, split by what is actually installed. The
 *  dot stays red for all of these (only the wording changes): the user needs to know
 *  whether to INSTALL something or just RECONNECT. `undefined` = probe still running. */
function wslNeededText(wsl: WslProbe | undefined): string {
	if (!wsl) { return 'Not connected - checking WSL and Ubuntu…'; }
	if (!wsl.wsl) { return WSL_NEEDED_TEXT; }
	// The WSL service is wedged (couldn't even list distros): Ubuntu IS installed,
	// so never say "install Ubuntu" here - the fix is a reset / PC restart.
	if (wsl.serviceError) { return 'Windows\' WSL service is stuck. Please restart your PC, then reopen Qoka. Your files are safe.'; }
	if (!wsl.ubuntu) { return 'WSL is installed, but Ubuntu isn\'t. Install Ubuntu to use Local (WSL). See qoka.org for setup instructions.'; }
	return 'WSL and Ubuntu are installed but not connected. Click to restart.';
}

function builtinStatusText(active: boolean, vm: VmStatus | undefined, reachable: boolean | undefined, wsl?: WslProbe): string {
	if (!active) { return 'Not in use'; }
	switch (vm?.status ?? 'stopped') {
		case 'provisioning':
			if (isWindows) { return 'Setting up WSL and Ubuntu…'; }
			return vm?.progress?.pct != null ? `Setting up, ${vm.progress.pct}%…` : 'Setting up…';
		case 'booting':
			return 'Starting…';
		case 'ready':
			if (reachable === undefined) { return 'Checking connection…'; }
			return reachable ? 'Connected - running on this computer' : 'Not connected - click to restart';
		case 'error':
			// A start error may be "WSL/Ubuntu not installed" OR "installed but not
			// connected" - the wslProbe tells them apart (see wslNeededText).
			return isWindows ? wslNeededText(wsl) : 'Not connected - click to restart';
		default:
			// 'stopped' is ambiguous - WSL may well be installed, the server just isn't
			// running. If the user SKIPPED setup, use the install-aware message; otherwise
			// keep the neutral start prompt.
			if (isWindows && wslSetupSkipped()) { return wslNeededText(wsl); }
			return 'Not running - click to start';
	}
}

function labelInput(parent: HTMLElement, labelText: string, value: string, placeholder: string, onInput: (v: string) => void): HTMLInputElement {
	const wrap = append(parent, $('div'));
	wrap.style.marginTop = '6px';
	const label = append(wrap, $('div'));
	Object.assign(label.style, { fontSize: '11px', opacity: '0.85' });
	label.textContent = labelText;
	const input = append(wrap, $('input')) as HTMLInputElement;
	input.type = 'text';
	input.value = value;
	input.placeholder = placeholder;
	Object.assign(input.style, { width: '100%', boxSizing: 'border-box', padding: '4px 6px', fontSize: '12px' });
	input.oninput = () => onInput(input.value);
	return input;
}

/**
 * Connections section: choose where code runs - the built-in server (Mac/Windows)
 * or a saved SSH server (add / select / remove / live status). Reuses the Autopipe
 * connection backend (`aria.autopipe.ssh.*`, `aria.autopipe.vm.*`,
 * `aria.autopipe.connection.probe`).
 */
export class ConnectionsSection extends SettingsSection {

	private formOpen = false;
	private draft: Draft = { ...EMPTY_DRAFT };
	private editingId: string | undefined;
	private editDraft: Draft = { ...EMPTY_DRAFT };
	private editTitleEl: HTMLElement | undefined;
	private editSubEl: HTMLElement | undefined;
	private editFormEl: HTMLElement | undefined;
	private pollTimer: ReturnType<typeof setTimeout> | undefined;
	/** Cached WSL/Ubuntu install probe, so the not-connected message can distinguish
	 *  "not installed" from "installed but not connected" (see wslNeededText). */
	private wslProbe: WslProbe | undefined;

	constructor(body: HTMLElement, commandService: ICommandService, header?: HTMLElement) {
		super(body, commandService, header);
		// A "+" on the section title row (like the notebook's add-note button) opens
		// the inline add-server form.
		this.addHeaderAction('codicon-add', 'Add server', () => {
			this.formOpen = !this.formOpen;
			this.editingId = undefined;
			this.draft = { ...EMPTY_DRAFT };
			void this.refresh();
		});
	}

	async refresh(): Promise<void> {
		// A re-render supersedes any in-flight live poll (a new one is armed below if
		// the built-in server is still setting up).
		this.stopBuiltinPoll();
		let status: ConnectionsStatus = {};
		try { status = (await this.commandService.executeCommand<ConnectionsStatus>('aria.autopipe.getStatus', true)) ?? {}; } catch { /* booting */ }
		// Fetched up here, with the rest of the state: awaiting after clearNode would
		// leave the section blank for the duration.
		let vm: VmStatus | undefined;
		if (!isLinux) {
			try { vm = await this.commandService.executeCommand<VmStatus>('aria.autopipe.vm.status'); } catch { /* booting */ }
		}

		const activeId = status.sshActiveProfileId ?? null;
		const profiles = status.sshProfiles ?? [];

		// Render from status first. Clearing only now (after the fetch) keeps the old
		// content visible until the new content is ready, so the "+"/delete actions no
		// longer blank the description. Reachability is probed afterwards (below) so the
		// slow SSH check never blanks the section.
		clearNode(this.body);

		const desc = append(this.body, $('div'));
		desc.textContent = `Choose where your code runs. Add an SSH server, or use ${BUILTIN_LABEL}.`;
		Object.assign(desc.style, { fontSize: '11px', opacity: '0.7', marginBottom: '10px' });

		let activeDot: HTMLElement | undefined;
		let activeKind: 'vm' | 'ssh' | undefined;
		// Kept so the background probe can rewrite the built-in server's subtitle
		// once it knows whether the thing is actually reachable.
		let builtinSub: HTMLElement | undefined;

		// Built-in server row (hidden on Linux, where SSH is the norm).
		if (!isLinux) {
			const active = activeId === LOCAL_VM_ID;
			const { row, dot, sub } = this.serverRow(BUILTIN_LABEL, builtinStatusText(active, vm, undefined, this.wslProbe), active);
			if (active) { activeDot = dot; activeKind = 'vm'; builtinSub = sub; }
			row.onclick = () => {
				try { localStorage.removeItem('aria.autopipe.wslSetupSkipped'); } catch { /* ignore */ }
				if (active && vm?.status === 'ready') {
					// Already running - do NOT tear it down. A stray click used to restart a
					// working server back into "Setting up"; now it just re-checks status.
					void this.refresh();
				} else {
					// Not ready (or after the poll gave up) - (re)run setup, then refresh,
					// which resumes the live poll until it turns green.
					void this.commandService.executeCommand('aria.autopipe.vm.setup').then(() => this.refresh());
				}
			};
			// Windows: a dedicated "Install WSL & Ubuntu" button on the row so a user who
			// earlier opted out (or whose WSL/Ubuntu is missing) can re-open the first-run
			// WSL install popup any time. Shown whenever the built-in server is not ready.
			if (isWindows && !(active && vm?.status === 'ready')) {
				const install = append(row, $('span')) as HTMLElement;
				install.textContent = 'Install WSL & Ubuntu';
				install.title = 'Install the WSL engine and Ubuntu for Local (WSL)';
				Object.assign(install.style, {
					cursor: 'pointer', flexShrink: '0', fontSize: '11px', padding: '2px 8px', marginLeft: '8px',
					borderRadius: '4px', border: '1px solid var(--vscode-button-border, transparent)',
					background: 'var(--vscode-button-secondaryBackground, rgba(127,127,127,0.2))',
					color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
				});
				install.onclick = (e) => {
					e.stopPropagation();
					void this.commandService.executeCommand('aria.wslPrompt.show', 'install');
				};
			}
		}

		// Saved SSH servers.
		for (const p of profiles) {
			const active = p.id === activeId;
			const { row, title, sub, dot } = this.serverRow(p.name, `${p.username}@${p.host}:${p.port}`, active);
			if (active) { activeDot = dot; activeKind = 'ssh'; }
			row.onclick = () => { void this.commandService.executeCommand('aria.autopipe.ssh.setActiveById', p.id).then(() => this.refresh()); };
			const edit = append(row, $('span.codicon.codicon-edit')) as HTMLElement;
			edit.title = 'Edit this server';
			Object.assign(edit.style, { cursor: 'pointer', opacity: '0.7', flexShrink: '0', padding: '2px' });
			edit.onclick = async (e) => {
				e.stopPropagation();
				if (this.editingId === p.id) { this.editingId = undefined; await this.refresh(); return; }
				const full = await this.commandService.executeCommand<{ name: string; host: string; port: number; username: string; repoPath: string } | null>('aria.autopipe.ssh.getProfile', p.id);
				this.editingId = p.id;
				this.formOpen = false;
				this.editDraft = { name: full?.name ?? p.name, host: full?.host ?? p.host, port: String(full?.port ?? p.port), username: full?.username ?? p.username, password: '', repoPath: full?.repoPath ?? '' };
				await this.refresh();
			};
			const trash = append(row, $('span.codicon.codicon-trash')) as HTMLElement;
			trash.title = 'Remove this server';
			Object.assign(trash.style, { cursor: 'pointer', opacity: '0.7', flexShrink: '0', padding: '2px' });
			trash.onclick = async (e) => {
				e.stopPropagation();
				try { await this.commandService.executeCommand('aria.autopipe.ssh.remove', p.id); } catch { /* handled */ }
				await this.refresh();
			};
			if (this.editingId === p.id) {
				// Keep refs so saving updates this row in place (no full reload).
				this.editTitleEl = title;
				this.editSubEl = sub;
				this.editFormEl = this.renderEditForm(p.id);
			}
		}

		// The add-server form (opened by the "+" on the section header).
		if (this.formOpen) { this.renderForm(); }

		// Probe reachability in the background and paint the active dot when it returns,
		// so the (potentially slow) SSH check never blocks or blanks the section.
		if (activeDot && activeKind) {
			const dotEl = activeDot;
			const kind = activeKind;
			const subEl = builtinSub;
			this.commandService.executeCommand<Probe>('aria.autopipe.connection.probe').then(probe => {
				if (!dotEl.isConnected) { return; }
				// While the built-in server is still setting up (provisioning/booting),
				// keep the dot NEUTRAL rather than red - it isn't a failure, it's mid-
				// setup (this is the "red while starting" the settings row used to show).
				const settingUp = kind === 'vm' && (vm?.status === 'provisioning' || vm?.status === 'booting');
				const reachable = kind === 'vm' ? !!probe?.connected : (probe?.kind === 'ssh' && !!probe?.connected);
				this.paintDot(dotEl, true, settingUp ? undefined : reachable);
				// "built-in" said nothing about whether it works. Now that the probe
				// has answered, say plainly whether it is connected.
				if (subEl?.isConnected) { subEl.textContent = builtinStatusText(true, vm, settingUp ? undefined : reachable, this.wslProbe); }
			}, () => { /* offline: leave the dot and text in their pending state */ });
		}

		// On Windows, when the built-in server isn't connected, probe whether WSL and
		// Ubuntu are actually installed so the message can say "install" vs "not
		// connected". Slow (wsl --status/--list), so done in the background and cached.
		if (isWindows && builtinSub) {
			const st = vm?.status ?? 'stopped';
			const needsProbe = st === 'error' || (st === 'stopped' && wslSetupSkipped());
			if (needsProbe) {
				const subEl = builtinSub;
				const vmSnapshot = vm;
				this.commandService.executeCommand<WslProbe>('aria.autopipe.vm.wslProbe').then(p => {
					if (p) { this.wslProbe = p; }
					if (subEl.isConnected) { subEl.textContent = builtinStatusText(true, vmSnapshot, false, this.wslProbe); }
				}, () => { /* leave the pending text as-is */ });
			}
		}

		// If the built-in server is still setting up, live-update its dot until it's
		// ready (then it turns green on its own - no click needed). Bounded poll.
		if (activeDot && activeKind === 'vm' && (vm?.status === 'provisioning' || vm?.status === 'booting')) {
			this.startBuiltinPoll(activeDot, builtinSub);
		}
	}

	private stopBuiltinPoll(): void {
		if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
	}

	/**
	 * While the built-in server is setting up, poll its status (cheap) every 3s and
	 * repaint the dot/text in place, so it flips to green the moment it's ready -
	 * without the user clicking. Deliberately NOT a permanent live view: it stops as
	 * soon as the server leaves the transitional state, when the row leaves the DOM
	 * (settings closed / re-rendered), or after a 5-minute cap. After the cap the row
	 * simply stays as-is; clicking it re-runs setup, which arms a fresh poll.
	 */
	private startBuiltinPoll(dotEl: HTMLElement, subEl: HTMLElement | undefined): void {
		this.stopBuiltinPoll();
		const deadline = Date.now() + 5 * 60 * 1000; // 5-minute cap
		const tick = async (): Promise<void> => {
			this.pollTimer = undefined;
			if (!dotEl.isConnected || Date.now() >= deadline) { return; }
			let vm: VmStatus | undefined;
			try { vm = await this.commandService.executeCommand<VmStatus>('aria.autopipe.vm.status'); } catch { /* keep waiting */ }
			if (!dotEl.isConnected) { return; }
			if (vm?.status === 'provisioning' || vm?.status === 'booting') {
				// Still setting up: neutral dot, live text, check again shortly.
				this.paintDot(dotEl, true, undefined);
				if (subEl?.isConnected) { subEl.textContent = builtinStatusText(true, vm, undefined, this.wslProbe); }
				this.pollTimer = setTimeout(() => void tick(), 3000);
			} else {
				// Left the transitional state (ready/error/stopped): a full refresh paints
				// the final state (probing SSH for the green/red verdict) and won't re-arm.
				void this.refresh();
			}
		};
		this.pollTimer = setTimeout(() => void tick(), 3000);
	}

	/** A selectable server row: a radio dot + title/sub. The dot starts in a neutral
	 *  "pending" state when active (reachability is painted in later by the probe).
	 *  Returns the row plus its title/sub spans and dot so callers can update in place. */
	private serverRow(title: string, sub: string, active: boolean): { row: HTMLElement; title: HTMLElement; sub: HTMLElement; dot: HTMLElement } {
		const row = append(this.body, $('div'));
		Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', cursor: 'pointer' });
		const dot = append(row, $('span'));
		Object.assign(dot.style, { width: '12px', height: '12px', borderRadius: '50%', flexShrink: '0', boxSizing: 'border-box', border: '1px solid' });
		this.paintDot(dot, active, undefined);
		const text = append(row, $('div'));
		text.style.flex = '1';
		const t = append(text, $('div')); t.textContent = title; t.style.fontSize = '12px';
		const s = append(text, $('div')); s.textContent = sub; Object.assign(s.style, { fontSize: '10.5px', opacity: '0.6' });
		return { row, title: t, sub: s, dot };
	}

	/** Color a server dot: gray outline when inactive, gray fill while its reachability
	 *  is still being probed (reachable === undefined), green when reachable, red when not. */
	private paintDot(dot: HTMLElement, active: boolean, reachable: boolean | undefined): void {
		const green = 'var(--vscode-charts-green, #4caf50)';
		const red = 'var(--vscode-charts-red, #f14c4c)';
		const gray = 'var(--vscode-descriptionForeground)';
		if (!active) {
			Object.assign(dot.style, { borderColor: gray, background: 'transparent' });
			return;
		}
		const color = reachable === undefined ? gray : reachable ? green : red;
		Object.assign(dot.style, { borderColor: color, background: color });
	}

	private renderForm(): void {
		const form = append(this.body, $('div'));
		Object.assign(form.style, { marginTop: '10px', borderTop: '1px solid var(--vscode-widget-border, transparent)', paddingTop: '10px' });
		labelInput(form, 'Name', this.draft.name, 'e.g. lab server', v => { this.draft.name = v; });
		labelInput(form, 'Host', this.draft.host, 'server.example.com or 10.0.0.5', v => { this.draft.host = v; });
		labelInput(form, 'Port', this.draft.port, '22', v => { this.draft.port = v; });
		labelInput(form, 'Username', this.draft.username, 'remote login', v => { this.draft.username = v; });
		const pw = labelInput(form, 'Password', this.draft.password, 'remote login password', v => { this.draft.password = v; });
		pw.type = 'password';
		labelInput(form, 'Remote workspace directory', this.draft.repoPath, '/home/you/aria', v => { this.draft.repoPath = v; });

		const save = append(form, $('button')) as HTMLButtonElement;
		save.textContent = 'Save profile';
		Object.assign(save.style, {
			marginTop: '10px', padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
			border: '1px solid var(--vscode-button-border, transparent)',
			background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
		});
		save.onclick = () => void this.save();
	}

	private async save(): Promise<void> {
		const d = this.draft;
		if (!d.name || !d.host || !d.username || !d.password || !d.repoPath) {
			void this.commandService.executeCommand('workbench.action.showErrorMessage', 'Fill in name, host, username, password, and remote workspace directory.');
			return;
		}
		const port = Number(d.port);
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			void this.commandService.executeCommand('workbench.action.showErrorMessage', 'Port must be 1-65535.');
			return;
		}
		try {
			await this.commandService.executeCommand('aria.autopipe.ssh.saveFromDraft', {
				name: d.name, host: d.host, port, username: d.username, auth: 'password', password: d.password, repoPath: d.repoPath,
			});
		} catch { return; }
		this.formOpen = false;
		this.draft = { ...EMPTY_DRAFT };
		await this.refresh();
	}

	/** Inline edit form for an existing server (pre-filled; blank password keeps current).
	 *  Returns the form element so a save can remove it without a full re-render. */
	private renderEditForm(id: string): HTMLElement {
		const form = append(this.body, $('div'));
		Object.assign(form.style, { marginTop: '8px', marginBottom: '8px', borderTop: '1px solid var(--vscode-widget-border, transparent)', paddingTop: '10px' });
		labelInput(form, 'Name', this.editDraft.name, 'e.g. lab server', v => { this.editDraft.name = v; });
		labelInput(form, 'Host', this.editDraft.host, 'server.example.com', v => { this.editDraft.host = v; });
		labelInput(form, 'Port', this.editDraft.port, '22', v => { this.editDraft.port = v; });
		labelInput(form, 'Username', this.editDraft.username, 'remote login', v => { this.editDraft.username = v; });
		const pw = labelInput(form, 'Password (leave blank to keep current)', this.editDraft.password, '********', v => { this.editDraft.password = v; });
		pw.type = 'password';
		labelInput(form, 'Remote workspace directory', this.editDraft.repoPath, '/home/you/aria', v => { this.editDraft.repoPath = v; });

		const save = append(form, $('button')) as HTMLButtonElement;
		save.textContent = 'Save changes';
		Object.assign(save.style, {
			marginTop: '10px', padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
			border: '1px solid var(--vscode-button-border, transparent)',
			background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
		});
		save.onclick = () => void this.saveEdit(id);
		return form;
	}

	private async saveEdit(id: string): Promise<void> {
		const d = this.editDraft;
		if (!d.name || !d.host || !d.username || !d.repoPath) {
			void this.commandService.executeCommand('workbench.action.showErrorMessage', 'Fill in name, host, username, and remote workspace directory.');
			return;
		}
		const port = Number(d.port);
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			void this.commandService.executeCommand('workbench.action.showErrorMessage', 'Port must be 1-65535.');
			return;
		}
		try {
			await this.commandService.executeCommand('aria.autopipe.ssh.saveFromDraft', {
				id, name: d.name, host: d.host, port, username: d.username, auth: 'password', password: d.password || undefined, repoPath: d.repoPath,
			});
		} catch { return; }
		// Update just this row + drop the form, instead of reloading the whole section.
		if (this.editTitleEl) { this.editTitleEl.textContent = d.name; }
		if (this.editSubEl) { this.editSubEl.textContent = `${d.username}@${d.host}:${port}`; }
		this.editFormEl?.remove();
		this.editFormEl = undefined;
		this.editTitleEl = undefined;
		this.editSubEl = undefined;
		this.editingId = undefined;
	}
}
