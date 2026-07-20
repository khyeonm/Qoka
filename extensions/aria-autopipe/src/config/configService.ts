/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AriaConfig, LocalVmConfig, LOCAL_VM_ID, SshProfile, defaultConfig, defaultLocalVmConfig } from '../common/types';

const STATE_KEY = 'aria.autopipe.config';

/** User-visible mirror of the config: lets the user (or a debugger)
 *  inspect what the MCP tools see, and gives `get_workspace_info` a
 *  paper trail beyond VS Code's opaque globalState blob. */
const DISK_CONFIG_PATH = path.join(os.homedir(), '.aria-autopipe-config.json');

/**
 * Persists Qoka Autopipe configuration in the extension's globalState. The
 * shape matches autopipe-app's `AppConfig` so a JSON dump from one can be
 * fed to the other for migrations later.
 *
 * Subscribers wire to `onDidChange` to refresh their UI when the user edits
 * SSH profiles or signs into GitHub.
 */
export class ConfigService {

	private current: AriaConfig;
	private readonly _onDidChange = new vscode.EventEmitter<AriaConfig>();
	readonly onDidChange = this._onDidChange.event;

	/** Runtime SSH endpoint of the built-in local VM, set by the VMManager once
	 *  the VM (or its dev stand-in) is reachable, cleared when it stops. Not
	 *  persisted - the port/key are per-boot. `activeProfile()` returns this when
	 *  the active target is the local VM. */
	private localVmEndpoint: SshProfile | null = null;

	constructor(private readonly context: vscode.ExtensionContext) {
		const raw = context.globalState.get<unknown>(STATE_KEY);
		this.current = mergeIntoDefaults(raw);
	}

	/** VMManager registers the live SSH endpoint of the built-in VM here. Passing
	 *  null (VM stopped) makes `activeProfile()` report "not ready" so callers
	 *  can prompt to set it up. Fires onDidChange so the UI reflects readiness. */
	setLocalVmEndpoint(profile: SshProfile | null): void {
		this.localVmEndpoint = profile;
		this._onDidChange.fire(this.current);
	}

	/** True when the built-in local VM is the selected run target. */
	isLocalVmActive(): boolean {
		return this.current.active_ssh_profile_id === LOCAL_VM_ID;
	}

	/** Select the built-in local VM as the active run target. */
	async activateLocalVm(): Promise<AriaConfig> {
		return this.update({ active_ssh_profile_id: LOCAL_VM_ID });
	}

	/** Persist local-VM resource overrides (RAM/CPU/disk). */
	async setLocalVmResources(patch: Partial<LocalVmConfig>): Promise<AriaConfig> {
		return this.update({ local_vm: { ...this.current.local_vm, ...patch } });
	}

	get(): AriaConfig {
		// Return a shallow copy so callers can't mutate our internal state by
		// reference. The arrays inside are still shared - callers that need to
		// mutate should call `update()` with a new object.
		return { ...this.current };
	}

	async update(patch: Partial<AriaConfig>): Promise<AriaConfig> {
		this.current = { ...this.current, ...patch };
		await this.context.globalState.update(STATE_KEY, this.current);
		this.writeDiskMirror();
		this._onDidChange.fire(this.current);
		return this.current;
	}

	/**
	 * Path on disk where the user-visible config mirror lives. Exposed so
	 * the UI and `get_workspace_info` can quote it ("settings live at
	 * /home/.../config.json").
	 */
	diskConfigPath(): string {
		return DISK_CONFIG_PATH;
	}

	/**
	 * Write a redacted JSON dump of the current config to a stable path
	 * under the user's home so the data is both inspectable and feedable
	 * to other tooling. Synchronous so observers (toast, MCP handler) see
	 * the file the moment `update()` resolves.
	 */
	private writeDiskMirror(): void {
		try {
			// Strip the GitHub token before mirroring - the rest of the
			// config is non-sensitive (SSH host metadata, repo settings),
			// but the OAuth token would let anyone reading the file
			// impersonate the user against GitHub.
			const safe: AriaConfig = {
				...this.current,
				github: this.current.github
					? { token: '<redacted>', login: this.current.github.login }
					: null,
			};
			fs.writeFileSync(DISK_CONFIG_PATH, JSON.stringify(safe, null, 2) + '\n', 'utf8');
		} catch (err) {
			console.error(`[aria-autopipe] writeDiskMirror failed:`, err);
		}
	}

	activeProfile(): SshProfile | null {
		const id = this.current.active_ssh_profile_id;
		if (!id) {
			return null;
		}
		// The built-in VM has no stored profile - its concrete endpoint (host/port/
		// key) is provided at runtime by the VMManager. Returns null until ready.
		if (id === LOCAL_VM_ID) {
			return this.localVmEndpoint;
		}
		return this.current.ssh_profiles.find(p => p.id === id) ?? null;
	}

	/** The built-in local VM's live endpoint regardless of whether it is the
	 *  active run target. The qoka-run MCP always executes on the built-in
	 *  server, so it needs the endpoint even when a remote SSH host is active. */
	localVmProfile(): SshProfile | null {
		return this.localVmEndpoint;
	}

	async addOrUpdateProfile(profile: SshProfile): Promise<AriaConfig> {
		const existing = this.current.ssh_profiles.findIndex(p => p.id === profile.id);
		const isNew = existing < 0;
		const next = [...this.current.ssh_profiles];
		if (existing >= 0) {
			next[existing] = profile;
		} else {
			next.push(profile);
		}
		// Adding a NEW server takes over as the active target - this is how the
		// user "switches off" the built-in VM by configuring their own server.
		// (Also auto-activates the very first profile.)
		const patch: Partial<AriaConfig> = { ssh_profiles: next };
		if (isNew) {
			patch.active_ssh_profile_id = profile.id;
		}
		return this.update(patch);
	}

	async removeProfile(id: string): Promise<AriaConfig> {
		const next = this.current.ssh_profiles.filter(p => p.id !== id);
		// If the removed profile was active, hand the active selection to another
		// profile. When none remain, fall back to the built-in VM ONLY on
		// Windows/macOS (their default run environment). On Linux the built-in VM
		// is not the default, so leave it empty there - the user re-adds an SSH
		// server rather than being silently switched to the VM.
		let newActive = this.current.active_ssh_profile_id;
		if (newActive === id) {
			newActive = next[0]?.id ?? (process.platform === 'linux' ? '' : LOCAL_VM_ID);
		}
		return this.update({ ssh_profiles: next, active_ssh_profile_id: newActive });
	}

	async setActiveProfile(id: string | null): Promise<AriaConfig> {
		return this.update({ active_ssh_profile_id: id });
	}
}

function mergeIntoDefaults(raw: unknown): AriaConfig {
	// globalState may be empty (fresh install) or a partial object (older
	// schema). Defensive merge keeps newly-added fields from breaking older
	// installs.
	const defaults = defaultConfig();
	if (typeof raw !== 'object' || raw === null) {
		return defaults;
	}
	const r = raw as Partial<AriaConfig>;
	const rawVm = (r.local_vm ?? {}) as Partial<LocalVmConfig>;
	const dv = defaultLocalVmConfig();
	return {
		ssh_profiles: Array.isArray(r.ssh_profiles) ? r.ssh_profiles : defaults.ssh_profiles,
		active_ssh_profile_id: typeof r.active_ssh_profile_id === 'string' ? r.active_ssh_profile_id : defaults.active_ssh_profile_id,
		local_vm: {
			memoryMB: typeof rawVm.memoryMB === 'number' && rawVm.memoryMB > 0 ? rawVm.memoryMB : dv.memoryMB,
			cpus: typeof rawVm.cpus === 'number' && rawVm.cpus > 0 ? rawVm.cpus : dv.cpus,
			diskGB: typeof rawVm.diskGB === 'number' && rawVm.diskGB > 0 ? rawVm.diskGB : dv.diskGB,
		},
		registry_url: typeof r.registry_url === 'string' && r.registry_url ? r.registry_url : defaults.registry_url,
		github: typeof r.github === 'object' && r.github !== null ? r.github : defaults.github,
		github_repo: typeof r.github_repo === 'string' ? r.github_repo : defaults.github_repo,
		per_pipeline_repo: typeof r.per_pipeline_repo === 'boolean' ? r.per_pipeline_repo : defaults.per_pipeline_repo,
	};
}
