/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { services } from './services';
import { SshProfile, workspacePathsFor } from './types';
import { shellEscape, cleanContent } from './roCrate';

/**
 * Docker / SSH environment helpers. Port `windows_to_wsl`,
 * `resolve_output_dir`, `resolve_docker_socket_mount`,
 * `resolve_symlink_targets`, `resolve_symlink_mounts`, and
 * `find_pipeline_dir` from autopipe-app.
 */

/**
 * Convert a Windows-style path (`C:\foo\bar` or `D:/foo/bar`) to its
 * WSL form (`/mnt/c/foo/bar`). Conservative: only rewrites paths that
 * really look like a Windows absolute path. Mirrors `windows_to_wsl`.
 */
export function windowsToWsl(path: string): string {
	if (!path) {
		return path;
	}
	if (path.length < 2 || path[1] !== ':') {
		return path;
	}
	const c0 = path.charCodeAt(0);
	const isLetter = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
	if (!isLetter) {
		return path;
	}
	// Third char must be '\', '/', or string-end.
	if (path.length > 2 && path[2] !== '\\' && path[2] !== '/') {
		return path;
	}
	const drive = path[0].toLowerCase();
	let rest = path.slice(2).replace(/\\/g, '/');
	if (rest.startsWith('/')) {
		rest = rest.slice(1);
	}
	if (!rest) {
		return `/mnt/${drive}`;
	}
	return `/mnt/${drive}/${rest}`;
}

/** Resolve the output directory for a run. Always `{output_dir}/{run_name}`. */
export function resolveOutputDir(profile: SshProfile, runName: string): string {
	const paths = workspacePathsFor(profile);
	return `${paths.output_dir.replace(/\/+$/, '')}/${runName}`;
}

/**
 * Detect the Docker socket path on the remote and return the `-v ...`
 * volume flags pinned to it (rootless vs root). Mirrors
 * `resolve_docker_socket_mount`.
 */
export async function resolveDockerSocketMount(profile: SshProfile): Promise<string> {
	const { ssh } = services();
	let socket = '/var/run/docker.sock';
	try {
		const probe = await ssh.run(profile, 'test -S /run/user/$(id -u)/docker.sock && echo rootless || echo root');
		if (probe.exitCode === 0 && cleanContent(probe.stdout).trim() === 'rootless') {
			const pathRes = await ssh.run(profile, 'echo /run/user/$(id -u)/docker.sock');
			if (pathRes.exitCode === 0) {
				const p = cleanContent(pathRes.stdout).trim();
				if (p) {
					socket = p;
				}
			}
		}
	} catch {
		// keep default socket
	}
	return ` -v '${socket}:/var/run/docker.sock' -v /usr/bin/docker:/usr/bin/docker`;
}

/**
 * Find the target paths of every symlink under `dir`. Resolves `dir`
 * itself with `readlink -f` first so the search descends into linked
 * directories. Returns deduplicated absolute paths excluding `dir`.
 */
export async function resolveSymlinkTargets(profile: SshProfile, dir: string): Promise<string[]> {
	const { ssh } = services();
	const cmd = `real=$(readlink -f '${shellEscape(dir)}' 2>/dev/null); find "$real" -maxdepth 3 -type l -exec readlink -f '{}' \\; 2>/dev/null | sort -u`;
	try {
		const r = await ssh.run(profile, cmd);
		if (r.exitCode !== 0) {
			return [];
		}
		return cleanContent(r.stdout)
			.split('\n')
			.map(l => l.trim())
			.filter(l => l && l !== dir && l.startsWith('/'));
	} catch {
		return [];
	}
}

/** Build extra `-v <target>:<target>:ro` mount flags for every symlink target found in `dir`. */
export async function resolveSymlinkMounts(profile: SshProfile, dir: string): Promise<string> {
	const targets = await resolveSymlinkTargets(profile, dir);
	let mounts = '';
	for (const t of targets) {
		mounts += ` -v '${shellEscape(t)}:${shellEscape(t)}:ro'`;
	}
	return mounts;
}

/**
 * Look up the pipeline source directory associated with a Docker image
 * name. Mirrors `find_pipeline_dir` - first under the configured
 * pipelines dir, then under output/{name}/{name}.
 */
export async function findPipelineDir(profile: SshProfile, imageName: string): Promise<string | null> {
	const { ssh } = services();
	const pipelineName = imageName.startsWith('autopipe-') ? imageName.slice('autopipe-'.length) : imageName;
	const paths = workspacePathsFor(profile);

	const candidates = [
		`${paths.pipelines_dir.replace(/\/+$/, '')}/${pipelineName}`,
		`${paths.output_dir.replace(/\/+$/, '')}/${pipelineName}/${pipelineName}`,
	];
	for (const candidate of candidates) {
		try {
			const r = await ssh.run(profile, `test -d '${shellEscape(candidate)}' && echo exists`);
			if (r.exitCode === 0 && r.stdout.trim().includes('exists')) {
				return candidate;
			}
		} catch {
			/* try next */
		}
	}
	return null;
}
