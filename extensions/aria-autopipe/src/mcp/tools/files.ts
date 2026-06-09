/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDefinition, textResult, errorResult } from './types';
import { services } from '../../common/services';
import { workspacePathsFor } from '../../common/types';
import { shellEscape } from '../../common/roCrate';
import { windowsToWsl } from '../../common/dockerEnv';

/**
 * File tools — faithful ports of create_symlink, remove_symlink, list_files,
 * read_file, write_file, prepare_input, check_download_status, and
 * remove_input from autopipe-app's `mcp/server.rs`.
 */

function requireProfile() {
	const { config } = services();
	const profile = config.activeProfile();
	if (!profile) {
		throw new Error('No active SSH profile. Configure one via Aria > Autopipe > SSH.');
	}
	return profile;
}

function parentOf(p: string): string {
	const idx = p.lastIndexOf('/');
	return idx > 0 ? p.slice(0, idx) : '';
}

function basenameOf(p: string): string {
	const idx = p.lastIndexOf('/');
	return idx >= 0 ? p.slice(idx + 1) : p;
}

export const FILE_TOOLS: ToolDefinition[] = [
	{
		name: 'create_symlink',
		description: 'Create a symbolic link on the remote SSH server. Use this to link input/output data instead of copying files. Prefer symlinks over cp for accessing result files and plots.',
		inputSchema: {
			type: 'object',
			properties: {
				source: { type: 'string' },
				target: { type: 'string' },
			},
			required: ['source', 'target'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const source = windowsToWsl(String(args.source ?? ''));
				const target = windowsToWsl(String(args.target ?? ''));
				if (!source || !target) {
					return errorResult('create_symlink: `source` and `target` are required');
				}

				const exists = await ssh.run(profile, `test -e '${shellEscape(source)}' && echo 'exists'`);
				if (!(exists.exitCode === 0 && exists.stdout.includes('exists'))) {
					return errorResult(`Source path '${source}' does not exist on remote server`);
				}

				const parent = parentOf(target);
				if (parent) {
					await ssh.run(profile, `mkdir -p '${shellEscape(parent)}'`);
				}

				const r = await ssh.run(profile, `ln -sf '${shellEscape(source)}' '${shellEscape(target)}'`);
				if (r.exitCode === 0) {
					return textResult(`Symlink created: ${target} -> ${source}`);
				}
				return errorResult(`Failed to create symlink: ${r.stdout.trim() || r.stderr.trim()}`);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'remove_symlink',
		description: 'Remove a symbolic link on the remote SSH server',
		inputSchema: {
			type: 'object',
			properties: { symlink_path: { type: 'string' } },
			required: ['symlink_path'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const symlinkPath = windowsToWsl(String(args.symlink_path ?? ''));
				if (!symlinkPath) {
					return errorResult('remove_symlink: `symlink_path` is required');
				}
				const cmd = `test -L '${shellEscape(symlinkPath)}' && rm '${shellEscape(symlinkPath)}' && echo 'removed' || echo 'not_a_symlink'`;
				const r = await ssh.run(profile, cmd);
				if (r.exitCode === 0) {
					if (r.stdout.includes('removed')) {
						return textResult(`Symlink '${symlinkPath}' removed`);
					}
					return errorResult(`'${symlinkPath}' is not a symlink or does not exist`);
				}
				return errorResult(`Failed: ${r.stdout.trim() || r.stderr.trim()}`);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'list_files',
		description: "List files and directories at a remote path on the SSH server. RESULTS-VIEWING WORKFLOW: when the user asks to view, check, or see results/output files: (1) call list_files to see what's there, (2) give the user a brief one-paragraph summary in chat (file count, names, sizes, optionally a 5-10 line excerpt from a single small text/log/summary file when it adds context), (3) tell them the visual viewer (show_results) is available for detailed inspection. Do NOT ask 'viewer or chat?' and do NOT dump entire file contents into chat.",
		inputSchema: {
			type: 'object',
			properties: { path: { type: 'string' } },
			required: ['path'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const p = windowsToWsl(String(args.path ?? ''));
				if (!p) {
					return errorResult('list_files: `path` is required');
				}
				const r = await ssh.run(profile, `ls -la '${shellEscape(p)}'`);
				if (r.exitCode === 0) {
					return textResult(r.stdout);
				}
				return errorResult(`Cannot list '${p}': ${r.stdout.trim() || r.stderr.trim()}`);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'read_file',
		description: "Read a file's contents on the remote SSH server. Two valid uses:\n(1) INTERNAL ANALYSIS — you (the AI) need to inspect a code or config file for your own work, e.g. the pre-download security review required by download_pipeline. In this mode read silently: do NOT echo the full contents to the user.\n(2) USER ASKED FOR ONE FILE'S CONTENTS — the user explicitly said something like 'show me X'. For binary/image/large/genomic files do NOT use read_file — direct the user to show_results instead.\nINPUT DATA — SENSITIVE: Files under the input directory must NOT be read without the user's consent. If you call read_file on one, the tool returns a consent request — relay it to the user and only re-call with confirm_read=true after they explicitly agree.",
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				confirm_read: { type: 'boolean' },
			},
			required: ['path'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const path = windowsToWsl(String(args.path ?? ''));
				if (!path) {
					return errorResult('read_file: `path` is required');
				}
				const paths = workspacePathsFor(profile);
				const inputTrim = paths.input_dir.replace(/\/+$/, '');
				const underInput = inputTrim.length > 0 && (path === inputTrim || path.startsWith(`${inputTrim}/`));
				if (underInput && args.confirm_read !== true) {
					return textResult(
						`NOT READ — consent required. '${path}' is in the input directory and may be user-provided data, which can be sensitive (e.g. patient/PHI data). Do NOT load it into the conversation without the user's permission.\n\n`
						+ 'Ask the user, in their language, whether you may read this input file:\n'
						+ '- If they agree: call read_file again with confirm_read=true.\n'
						+ '- If they decline: do NOT read it — instead ask them to tell you the specific information you need (e.g. column names, group labels, sample IDs) so you can proceed without exposing the data.',
					);
				}

				const MAX = 2 * 1024 * 1024; // 2 MB
				const readCmd = `head -c ${MAX + 1} '${shellEscape(path)}'`;
				const r = await ssh.run(profile, readCmd);
				if (r.exitCode !== 0) {
					return errorResult(`Cannot read '${path}': ${r.stdout.trim() || r.stderr.trim()}`);
				}
				const content = r.stdout;
				if (content.length > MAX) {
					return textResult(
						`NOT READ — '${path}' is too large to load into the conversation (> ${MAX / (1024 * 1024)} MB). Large files are usually raw data; view it with show_results (in the browser) or save it with download_results instead.`,
					);
				}
				const head = content.slice(0, 8192);
				if (head.includes('\x00')) {
					return textResult(
						`NOT READ — '${path}' looks like a binary file (contains NUL bytes). Use show_results to view it in the browser instead of read_file.`,
					);
				}
				return textResult(content);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'write_file',
		description: 'Write content to a file on the remote SSH server. Creates parent directories if needed.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				content: { type: 'string' },
			},
			required: ['path', 'content'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const path = windowsToWsl(String(args.path ?? ''));
				const content = String(args.content ?? '');
				if (!path) {
					return errorResult('write_file: `path` is required');
				}
				const parent = parentOf(path);
				if (parent) {
					await ssh.run(profile, `mkdir -p '${shellEscape(parent)}'`);
				}
				try {
					await ssh.writeFile(profile, path, content);
					return textResult(`File written: ${path}`);
				} catch (err) {
					return errorResult(`Cannot write '${path}': ${(err as Error).message}`);
				}
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'prepare_input',
		description: 'Prepare input data for pipeline execution by downloading a file from a URL or symlinking an existing file on the remote server into the configured pipelines_input directory. If source starts with http://, https://, or ftp://, the download runs in the background and returns immediately. After calling this for a URL, automatically call check_download_status with the returned filename every 10 seconds until complete. Otherwise, a symlink is created pointing to the given absolute path. Returns the destination directory path — pass this as input_dir to dry_run or execute_pipeline. Always stage user-provided data here before inspecting it: read_file applies a consent gate to files in this input directory.',
		inputSchema: {
			type: 'object',
			properties: {
				source: { type: 'string' },
				filename: { type: 'string' },
				subdir: { type: 'string' },
			},
			required: ['source'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const paths = workspacePathsFor(profile);
				const base = paths.input_dir;
				const subdir = args.subdir && String(args.subdir).length > 0
					? String(args.subdir).replace(/^\/+|\/+$/g, '')
					: '';
				const destDir = subdir ? `${base.replace(/\/+$/, '')}/${subdir}` : base;

				const mkdirRes = await ssh.run(profile, `mkdir -p '${shellEscape(destDir)}'`, { timeoutMs: 60000 });
				if (mkdirRes.exitCode !== 0) {
					return errorResult(
						`Failed to create input directory '${destDir}': ${mkdirRes.stdout.trim() || mkdirRes.stderr.trim()}\n`
						+ `Fallback: use create_symlink with target='${destDir}/<filename>'`,
					);
				}

				const source = String(args.source ?? '');
				const isUrl = /^(https?|ftp):\/\//.test(source);

				if (isUrl) {
					let filename = args.filename ? String(args.filename) : '';
					if (!filename) {
						const slashIdx = source.lastIndexOf('/');
						filename = slashIdx >= 0 ? source.slice(slashIdx + 1) : '';
						if (!filename) {
							filename = 'downloaded_file';
						}
					}
					const destFile = `${destDir.replace(/\/+$/, '')}/${filename}`;
					const logPath = `/tmp/autopipe_dl_${filename}.log`;
					const exitPath = `/tmp/autopipe_dl_${filename}.exit`;

					await ssh.run(
						profile,
						`rm -f '${shellEscape(logPath)}' '${shellEscape(exitPath)}'`,
						{ timeoutMs: 10000 },
					);

					const cmd =
						`nohup sh -c "docker run --rm --network host -v '${shellEscape(destDir)}:/downloads' alpine sh -c `
						+ `\\"wget -qO '/downloads/${shellEscape(filename)}' '${shellEscape(source)}' 2>&1 || curl -fsSL -o '/downloads/${shellEscape(filename)}' '${shellEscape(source)}'\\" `
						+ `> '${shellEscape(logPath)}' 2>&1; echo \\$? > '${shellEscape(exitPath)}'" >/dev/null 2>&1 & echo $!`;

					const r = await ssh.run(profile, cmd, { timeoutMs: 10000 });
					if (r.exitCode === 0) {
						const pid = r.stdout.trim();
						return textResult(
							`Download started in background (PID: ${pid}).\n`
							+ `Destination: ${destFile}\n`
							+ `Now call check_download_status with filename='${filename}' every 10 seconds to monitor progress.`,
						);
					}
					return errorResult(`Failed to start download for '${source}':\n${r.stdout.trim() || r.stderr.trim()}`);
				}

				// Symlink branch
				const sourceTranslated = windowsToWsl(source);
				const linkName = basenameOf(sourceTranslated) || 'input';
				const linkPath = `${destDir.replace(/\/+$/, '')}/${linkName}`;

				const exists = await ssh.run(
					profile,
					`test -e '${shellEscape(sourceTranslated)}' && echo 'exists'`,
					{ timeoutMs: 60000 },
				);
				if (!(exists.exitCode === 0 && exists.stdout.includes('exists'))) {
					return errorResult(
						`Source path '${sourceTranslated}' does not exist on the remote server.\n`
						+ `Fallback: use create_symlink with source='${sourceTranslated}' target='${linkPath}'`,
					);
				}
				const ln = await ssh.run(
					profile,
					`ln -sf '${shellEscape(sourceTranslated)}' '${shellEscape(linkPath)}'`,
					{ timeoutMs: 60000 },
				);
				if (ln.exitCode === 0) {
					return textResult(`Linked: ${linkPath} -> ${sourceTranslated}\nUse as input_dir: ${destDir}`);
				}
				return errorResult(
					`Failed to create symlink: ${ln.stdout.trim() || ln.stderr.trim()}\n`
					+ `Fallback: use create_symlink with source='${sourceTranslated}' target='${linkPath}'`,
				);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'check_download_status',
		description: 'Check the status of a background file download started by prepare_input. Returns downloading/success/failed status with recent log output. Call this automatically every 10 seconds after prepare_input — do NOT wait for the user to ask.',
		inputSchema: {
			type: 'object',
			properties: { filename: { type: 'string' } },
			required: ['filename'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const filename = String(args.filename ?? '');
				if (!filename) {
					return errorResult('check_download_status: `filename` is required');
				}
				const logPath = `/tmp/autopipe_dl_${filename}.log`;
				const exitPath = `/tmp/autopipe_dl_${filename}.exit`;

				const exitRes = await ssh.run(profile, `cat '${shellEscape(exitPath)}' 2>/dev/null`, { timeoutMs: 10000 });
				const exitCode = (exitRes.exitCode === 0 && exitRes.stdout.trim()) ? exitRes.stdout.trim() : null;

				const tailRes = await ssh.run(profile, `tail -20 '${shellEscape(logPath)}' 2>/dev/null`, { timeoutMs: 10000 });
				const recentLog = tailRes.stdout || '';

				if (exitCode === '0') {
					await ssh.run(
						profile,
						`rm -f '${shellEscape(logPath)}' '${shellEscape(exitPath)}'`,
						{ timeoutMs: 10000 },
					);
					return textResult(`Download completed successfully: ${filename}\n\nLog:\n${recentLog}`);
				}
				if (exitCode !== null) {
					return errorResult(`Download failed (exit code: ${exitCode}).\n\nLog:\n${recentLog}`);
				}
				return textResult(`Download in progress...\n\nRecent log:\n${recentLog}`);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'remove_input',
		description: 'Remove a file or symlink from the pipelines_input directory. Symlinks are removed directly. Regular files (including root-owned files created by Docker downloads) are removed via Docker to handle permission issues. relative_path is relative to pipelines_input (e.g. "run-001/data.fastq" or "data.fastq").',
		inputSchema: {
			type: 'object',
			properties: { relative_path: { type: 'string' } },
			required: ['relative_path'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const paths = workspacePathsFor(profile);
				const inputBase = paths.input_dir;
				const rel = String(args.relative_path ?? '').replace(/^\/+|\/+$/g, '');
				if (!rel) {
					return errorResult('remove_input: `relative_path` is required');
				}
				const fullPath = `${inputBase.replace(/\/+$/, '')}/${rel}`;

				const isSym = await ssh.run(profile, `test -L '${shellEscape(fullPath)}' && echo 'symlink'`);
				if (isSym.exitCode === 0 && isSym.stdout.includes('symlink')) {
					const rm = await ssh.run(profile, `rm '${shellEscape(fullPath)}'`);
					if (rm.exitCode === 0) {
						return textResult(`Removed symlink: ${fullPath}`);
					}
					return errorResult(`Failed to remove symlink: ${rm.stdout.trim() || rm.stderr.trim()}`);
				}

				const directRm = await ssh.run(profile, `rm -rf '${shellEscape(fullPath)}'`);
				if (directRm.exitCode === 0) {
					return textResult(`Removed: ${fullPath}`);
				}
				const parent = parentOf(fullPath) || inputBase;
				const basename = basenameOf(fullPath);
				const dockerCmd =
					`docker run --rm -v '${shellEscape(parent)}:/target' alpine rm -rf '/target/${shellEscape(basename)}'`;
				const dockerRm = await ssh.run(profile, dockerCmd);
				if (dockerRm.exitCode === 0) {
					return textResult(`Removed via Docker (root-owned): ${fullPath}`);
				}
				return errorResult(`Failed to remove '${fullPath}': ${dockerRm.stdout.trim() || dockerRm.stderr.trim()}`);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
];
