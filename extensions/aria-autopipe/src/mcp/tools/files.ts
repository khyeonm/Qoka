/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { ToolDefinition, textResult, errorResult } from './types';
import { ensureAutopipeTabOpen } from './autopipeTab';
import { services } from '../../common/services';
import { workspacePathsFor } from '../../common/types';
import { shellEscape } from '../../common/roCrate';
import { windowsToWsl } from '../../common/dockerEnv';
import { workspaceFolderPath, mirrorPipelineFileLocally, writeInputManifest } from '../../common/workspaceSync';

/**
 * File tools - faithful ports of create_symlink, remove_symlink, list_files,
 * read_file, write_file, prepare_input, check_download_status, and
 * remove_input from autopipe-app's `mcp/server.rs`.
 */

function requireProfile() {
	const { config } = services();
	const profile = config.activeProfile();
	if (!profile) {
		throw new Error('No active SSH profile. Configure one via Qoka > Autopipe > SSH.');
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

/** Recursively collect files under a local directory, with POSIX-relative paths
 *  (for building remote destinations). Directories become nested prefixes. */
function gatherLocalFiles(baseDir: string, relPrefix: string, out: { local: string; rel: string }[]): void {
	for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
		const localChild = path.join(baseDir, entry.name);
		const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			gatherLocalFiles(localChild, rel, out);
		} else if (entry.isFile()) {
			out.push({ local: localChild, rel });
		}
	}
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
		description: "List files and directories at a remote path on the SSH server. RESULTS-VIEWING WORKFLOW: when the user asks to view, check, or see results/output files: (1) call list_files to see what's there, (2) give the user a brief one-paragraph summary in chat (file count, names, sizes, optionally a 5-10 line excerpt from a single small text/log/summary file when it adds context), (3) tell them that once the results are saved to the project (save_results_to_project) they can be opened from the Explorer under autopipe/pipelines_output/<run_name>/. Do NOT dump entire file contents into chat.",
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
		description: "Read a file's contents on the remote SSH server. Two valid uses:\n(1) INTERNAL ANALYSIS - you (the AI) need to inspect a code or config file for your own work, e.g. the pre-download security review required by download_pipeline. In this mode read silently: do NOT echo the full contents to the user.\n(2) USER ASKED FOR ONE FILE'S CONTENTS - the user explicitly said something like 'show me X'. For binary/image/large/genomic files do NOT use read_file - direct the user to open them from the Explorer under autopipe/pipelines_output/<run_name>/ after saving with save_results_to_project.\nINPUT DATA - SENSITIVE: Files under the input directory must NOT be read without the user's consent. If you call read_file on one, the tool returns a consent request - relay it to the user and only re-call with confirm_read=true after they explicitly agree.",
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
						`NOT READ - consent required. '${path}' is in the input directory and may be user-provided data, which can be sensitive (e.g. patient/PHI data). Do NOT load it into the conversation without the user's permission.\n\n`
						+ 'Ask the user, in their language, whether you may read this input file:\n'
						+ '- If they agree: call read_file again with confirm_read=true.\n'
						+ '- If they decline: do NOT read it - instead ask them to tell you the specific information you need (e.g. column names, group labels, sample IDs) so you can proceed without exposing the data.',
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
						`NOT READ - '${path}' is too large to load into the conversation (> ${MAX / (1024 * 1024)} MB). Large files are usually raw data; save it into the project with save_results_to_project (then open it from the Explorer under autopipe/pipelines_output/<run_name>/) or download it with download_results instead.`,
					);
				}
				const head = content.slice(0, 8192);
				if (head.includes('\x00')) {
					return textResult(
						`NOT READ - '${path}' looks like a binary file (contains NUL bytes). Save it into the project with save_results_to_project and open it from the Explorer under autopipe/pipelines_output/<run_name>/ instead of read_file.`,
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
		description: 'Write content to a file on the remote SSH server. Creates parent directories if needed. Files written under the pipelines directory are also mirrored into the open project folder automatically (autopipe/pipelines/), on every create and edit - you do not need to copy pipeline code yourself.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				content: { type: 'string' },
			},
			required: ['path', 'content'],
		},
		handler: async (args) => {
			ensureAutopipeTabOpen();
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
					// Mirror pipeline code into the open project folder on every write
					// (create/edit), so it stays synced without the user asking.
					mirrorPipelineFileLocally(profile, path, content);
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
		description: 'Prepare input data for pipeline execution by downloading a file from a URL or symlinking an existing file on the remote server into the configured pipelines_input directory. If source starts with http://, https://, or ftp://, the download runs in the background and returns immediately. After calling this for a URL, automatically call check_download_status with the returned filename every 10 seconds until complete. Otherwise, a symlink is created pointing to the given absolute path. Returns the destination directory path - pass this as input_dir to dry_run or execute_pipeline. Always stage user-provided data here before inspecting it: read_file applies a consent gate to files in this input directory.',
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
					// Input data just staged - record a manifest (list + sizes, no bytes)
					// in the project folder. Best-effort.
					try { await writeInputManifest(profile, 'inputs'); } catch { /* best-effort */ }
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
		description: 'Check the status of a background file download started by prepare_input. Returns downloading/success/failed status with recent log output. Call this automatically every 10 seconds after prepare_input - do NOT wait for the user to ask.',
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
	{
		name: 'upload_local_input',
		description: "Upload input data from the USER'S LOCAL machine (the computer running Qoka) into the run target's pipelines_input directory, so a pipeline can use it. Use this when the user's data is on their own computer - NOT a URL (use prepare_input for URLs) and NOT already on the server (use create_symlink for that). `local_path` is a file OR a directory on the user's machine: absolute, or relative to the open project folder. Files stream over SFTP, so large genomic files (BAM/CRAM/FASTQ) are fine - but WARN the user first that a large upload may take a while. Optional `subdir` groups the upload under pipelines_input/<subdir>. Returns the remote directory to pass as `input_dir` to dry_run / execute_pipeline.",
		inputSchema: {
			type: 'object',
			properties: {
				local_path: { type: 'string', description: "Absolute path to a file or directory on the user's local machine, or a path relative to the open project folder." },
				subdir: { type: 'string', description: 'Optional subdirectory under pipelines_input to place the upload in (e.g. a run name).' },
			},
			required: ['local_path'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();

				const rawLocal = String(args.local_path ?? '');
				if (!rawLocal) {
					return errorResult('upload_local_input: `local_path` is required');
				}
				// Resolve local path: absolute as-is, else relative to the open project folder.
				let localPath = rawLocal;
				if (!path.isAbsolute(localPath)) {
					const folder = workspaceFolderPath();
					if (!folder) {
						return errorResult('`local_path` is relative but no project folder is open. Give an absolute path or open a folder.');
					}
					localPath = path.join(folder, localPath);
				}
				let stat: fs.Stats;
				try {
					stat = fs.statSync(localPath);
				} catch {
					return errorResult(`Local path not found: ${localPath}`);
				}

				const paths = workspacePathsFor(profile);
				const subdir = args.subdir && String(args.subdir).length > 0
					? String(args.subdir).replace(/^\/+|\/+$/g, '')
					: '';
				const destDir = subdir ? `${paths.input_dir.replace(/\/+$/, '')}/${subdir}` : paths.input_dir;

				// Create the remote input dir as the SSH user FIRST so it is user-owned
				// (never let a later docker mount create it as root - see execute_pipeline).
				const mk = await ssh.run(profile, `mkdir -p '${shellEscape(destDir)}'`, { timeoutMs: 60000 });
				if (mk.exitCode !== 0) {
					return errorResult(`Failed to create remote input dir '${destDir}': ${mk.stdout.trim() || mk.stderr.trim()}`);
				}

				// Gather local files (single file, or a whole directory tree).
				const files: { local: string; rel: string }[] = [];
				if (stat.isDirectory()) {
					gatherLocalFiles(localPath, '', files);
				} else {
					files.push({ local: localPath, rel: basenameOf(localPath.replace(/\\/g, '/')) });
				}
				if (files.length === 0) {
					return textResult(`Nothing to upload: '${localPath}' contains no files.`);
				}

				let uploaded = 0;
				const errors: string[] = [];
				const madeDirs = new Set<string>();
				for (const f of files) {
					const remoteFile = `${destDir.replace(/\/+$/, '')}/${f.rel}`;
					const remoteParent = parentOf(remoteFile);
					if (remoteParent && !madeDirs.has(remoteParent)) {
						await ssh.run(profile, `mkdir -p '${shellEscape(remoteParent)}'`);
						madeDirs.add(remoteParent);
					}
					try {
						await ssh.uploadFileSftp(profile, f.local, remoteFile);
						uploaded++;
					} catch (e) {
						errors.push(`${f.rel}: ${(e as Error).message}`);
					}
				}

				// User just provided input data - record a manifest (file list + sizes,
				// no bytes) in the project folder. Best-effort.
				try { await writeInputManifest(profile, 'inputs'); } catch { /* best-effort */ }

				const lines = [
					`Uploaded ${uploaded}/${files.length} file(s) into ${destDir}.`,
					`Use as input_dir: ${destDir}`,
				];
				if (errors.length > 0) {
					lines.push('', 'Failed:');
					for (const e of errors) { lines.push(`  ${e}`); }
				}
				return uploaded > 0 ? textResult(lines.join('\n')) : errorResult(lines.join('\n'));
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
];
