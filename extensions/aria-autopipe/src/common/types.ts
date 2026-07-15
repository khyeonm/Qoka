/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cross-module data models for Aria Autopipe. Mirrors autopipe-app's
 * `crates/common/src/models.rs` field-by-field so a stored config from the
 * Tauri app can theoretically round-trip through Aria without re-entry -
 * we adopt the same JSON shape.
 */

export type SshAuthType = 'password' | 'key' | 'agent';

export interface SshAuth {
	type: SshAuthType;
	/** Used only for `type: 'password'`. */
	password?: string;
	/** Used only for `type: 'key'`. Absolute path to the private key file. */
	key_path?: string;
}

export interface SshProfile {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	auth: SshAuth;
	/** Remote directory holding all Aria workspace state on this host. */
	repo_path: string;
}

export interface GitHubAuth {
	/** Personal access token or OAuth-Device-Flow token. */
	token: string;
	/** Login from `GET /user`, cached at auth time. */
	login?: string;
}

/** The built-in local VM's synthetic profile id. When this is the active target,
 *  pipelines run on Aria's bundled QEMU VM ("Aria built-in", Mac/Win) instead of
 *  a user SSH server. Its concrete SshProfile is produced at runtime by the
 *  VMManager (which owns the forwarded SSH port + key), not stored in config. */
export const LOCAL_VM_ID = '__local_vm__';

/** User-tunable resources for the built-in local VM. Defaults adapt to the host
 *  in VMManager; these are the persisted overrides. */
export interface LocalVmConfig {
	/** Guest RAM in MB. */
	memoryMB: number;
	/** Guest vCPUs. */
	cpus: number;
	/** Max virtual disk in GB - sparse, so only the actually-stored bytes count. */
	diskGB: number;
}

export function defaultLocalVmConfig(): LocalVmConfig {
	return { memoryMB: 4096, cpus: 2, diskGB: 60 };
}

export interface AriaConfig {
	ssh_profiles: SshProfile[];
	/** Active run target: an SshProfile id, `LOCAL_VM_ID` for the built-in VM, or
	 *  null when nothing is selected. */
	active_ssh_profile_id: string | null;
	/** Resources for the built-in local VM. */
	local_vm: LocalVmConfig;
	registry_url: string;
	github: GitHubAuth | null;
	/** GitHub repository name for pipeline uploads in single-repo mode. */
	github_repo: string;
	/** When true, each pipeline goes into its own GitHub repository. */
	per_pipeline_repo: boolean;
}

export const DEFAULT_REGISTRY_URL = 'https://hub.autopipe.org';

export function defaultConfig(): AriaConfig {
	return {
		ssh_profiles: [],
		active_ssh_profile_id: null,
		local_vm: defaultLocalVmConfig(),
		registry_url: DEFAULT_REGISTRY_URL,
		github: null,
		github_repo: '',
		per_pipeline_repo: true,
	};
}

/**
 * Workspace paths derived from the active SSH profile's `repo_path`. Aria
 * follows the same `{repo_path}/pipelines/`, `{repo_path}/pipelines_input/`
 * convention autopipe-app uses, so users coming from the Tauri app see the
 * same directory layout.
 */
export interface WorkspacePaths {
	repo_path: string;
	pipelines_dir: string;
	input_dir: string;
	output_dir: string;
	log_dir: string;
	plugins_dir: string;
}

export function workspacePathsFor(profile: SshProfile): WorkspacePaths {
	const trim = (s: string) => s.replace(/\/+$/, '');
	const repo = trim(profile.repo_path);
	return {
		repo_path: repo,
		pipelines_dir: `${repo}/pipelines`,
		input_dir: `${repo}/pipelines_input`,
		output_dir: `${repo}/pipelines_output`,
		log_dir: `${repo}/pipelines_output/.aria_logs`,
		plugins_dir: `${repo}/.aria_plugins`,
	};
}

export interface Pipeline {
	pipeline_id: number | null;
	name: string;
	description: string;
	tools: string[];
	input_formats: string[];
	output_formats: string[];
	tags: string[];
	github_url: string;
	author: string;
	version: string;
	verified: boolean;
	created_at: string | null;
	/** Tag the publisher anchored to at publish time. Used by
	 *  download_pipeline to pin clones to the published commit. */
	git_tag?: string | null;
	/** URL of the original workflow this pipeline is based on. */
	based_on_url?: string | null;
	forked_from?: number | null;
}
