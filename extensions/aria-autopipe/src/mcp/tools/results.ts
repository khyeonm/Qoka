/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ToolDefinition, textResult, errorResult } from './types';
import { services } from '../../common/services';
// The in-app Autopipe Viewer is disabled: results are inspected in the Explorer
// under `autopipe/pipelines_output/<run>/` instead. Kept as a comment so the
// viewer can be re-enabled later without re-deriving the wiring.
// import { openViewerForDirectory } from '../../viewer/viewerPanel';
import { shellEscape } from '../../common/roCrate';
import { windowsToWsl } from '../../common/dockerEnv';

function requireProfile() {
	const { config } = services();
	const profile = config.activeProfile();
	if (!profile) {
		throw new Error('No active SSH profile. Configure one via Qoka → Autopipe → SSH.');
	}
	return profile;
}

export const RESULT_TOOLS: ToolDefinition[] = [
	{
		name: 'download_results',
		description: "Download file(s) from the remote SSH server to the user's local machine. Use this when the user wants to save result files locally. If local_dir is omitted, files are saved to the OS default Downloads folder. Tell the user the default path and ask if they want to change it. Supports single files and directories.",
		inputSchema: {
			type: 'object',
			properties: {
				remote_path: { type: 'string' },
				local_dir: { type: 'string' },
			},
			required: ['remote_path'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const { ssh } = services();
				const remotePath = windowsToWsl(String(args.remote_path ?? ''));
				if (!remotePath) {
					return errorResult('download_results: `remote_path` is required');
				}

				let localDir = args.local_dir ? String(args.local_dir) : '';
				if (!localDir) {
					localDir = path.join(os.homedir(), 'Downloads');
				}
				try {
					fs.mkdirSync(localDir, { recursive: true });
				} catch (e) {
					return errorResult(`Cannot create local directory '${localDir}': ${(e as Error).message}`);
				}

				const probe = await ssh.run(profile, `test -d '${shellEscape(remotePath)}' && echo DIR || echo FILE`);
				const isDir = probe.exitCode === 0 && probe.stdout.trim() === 'DIR';

				if (isDir) {
					const filesRes = await ssh.run(
						profile,
						`find '${shellEscape(remotePath)}' -maxdepth 1 -type f -printf '%f\\n'`,
					);
					if (filesRes.exitCode !== 0) {
						return errorResult(`Cannot list directory '${remotePath}': ${filesRes.stdout.trim() || filesRes.stderr.trim()}`);
					}
					const list = filesRes.stdout.trim().split('\n').filter(Boolean);
					if (list.length === 0) {
						return errorResult(`No files found in '${remotePath}'`);
					}
					const downloaded: string[] = [];
					const errors: string[] = [];
					for (const name of list) {
						const remoteFile = `${remotePath.replace(/\/+$/, '')}/${name}`;
						const localFile = `${localDir.replace(/\/+$/, '')}/${name}`;
						try {
							const size = await ssh.downloadBase64(profile, remoteFile, localFile);
							downloaded.push(`  ${name} (${size} bytes)`);
						} catch (err) {
							errors.push(`  ${name}: ${(err as Error).message}`);
						}
					}
					let msg = `Downloaded to: ${localDir}\n\n`;
					if (downloaded.length > 0) {
						msg += `OK ${downloaded.length} file(s) saved:\n${downloaded.join('\n')}\n`;
					}
					if (errors.length > 0) {
						msg += `\nFAIL ${errors.length} error(s):\n${errors.join('\n')}`;
					}
					return textResult(msg);
				}

				const fileName = (() => {
					const idx = remotePath.lastIndexOf('/');
					const n = idx >= 0 ? remotePath.slice(idx + 1) : remotePath;
					return n || 'downloaded_file';
				})();
				const localFile = `${localDir.replace(/\/+$/, '')}/${fileName}`;
				try {
					const size = await ssh.downloadBase64(profile, remotePath, localFile);
					return textResult(`Downloaded to: ${localFile}\nOK ${fileName} (${size} bytes)`);
				} catch (err) {
					return errorResult(`Download failed for '${remotePath}': ${(err as Error).message}`);
				}
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'show_results',
		description: "List the result files at a remote path and tell the user where to open them. There is NO in-app viewer: saved pipeline results live in the project's Explorer under `autopipe/pipelines_output/<run_name>/` (put there by save_results_to_project). This tool reports the files present so you can summarise them; then direct the user to open them from the Explorer file tree (autopipe/pipelines_output/<run_name>/). Never tell the user to open a browser, a 127.0.0.1 URL, or an in-app viewer panel. Pass a DIRECTORY path to list its files, or a single FILE path to report just that file.",
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Remote file or directory path whose result files should be listed.' },
				filter: { type: 'string', description: 'Optional filter: "image", "text", "genomics", "pdf", "hdf5".' },
				reference: { type: 'string', description: 'For BAM/BED/GFF/CRAM viewing: a FASTA filename in the same directory, or absolute path, or "none".' },
			},
			required: ['path'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const target = String(args.path ?? '');
				if (!target) {
					return errorResult('show_results: `path` is required');
				}
				const { ssh } = services();

				// Detect whether target is a directory or a file. `test -d`
				// is the simplest portable check.
				const probe = await ssh.run(profile, `test -d ${q(target)} && echo DIR || (test -f ${q(target)} && echo FILE || echo NONE)`);
				const kind = probe.stdout.trim().split('\n').pop() ?? 'NONE';

				if (kind === 'NONE') {
					return errorResult(`show_results: ${target} does not exist on the remote server.`);
				}

				if (kind === 'FILE') {
					// Viewer disabled: point the user to the file in the Explorer
					// instead of opening the in-app viewer.
					// const parent = target.replace(/\/[^/]+$/, '') || '/';
					// await openViewerForDirectory(parent, target);
					return textResult([
						`${path.basename(target)} is ready.`,
						`Open it from the Explorer under autopipe/pipelines_output/<run_name>/ (after the results are saved to the project with save_results_to_project).`,
					].join('\n'));
				}

				// Directory: viewer disabled. List the files so the AI can
				// summarise them, then direct the user to the Explorer.
				// await openViewerForDirectory(target);
				const { stdout } = await ssh.run(profile, `ls -1 -- ${q(target)}`);
				const entries = stdout.trim().split('\n').filter(Boolean);
				if (entries.length === 0) {
					return textResult(`${target} is empty.`);
				}

				const lines: string[] = [];
				lines.push(`Result files in ${target}:`);
				for (const name of entries) {
					lines.push(`  ${name}`);
				}
				lines.push('');
				lines.push('Tell the user these results open in the Explorer under autopipe/pipelines_output/<run_name>/ (save them there first with save_results_to_project if not done yet).');
				return textResult(lines.join('\n'));
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
];

function q(s: string): string {
	if (/^[A-Za-z0-9_./@:+,=-]+$/.test(s)) {
		return s;
	}
	return `'${s.replace(/'/g, "'\\''")}'`;
}
