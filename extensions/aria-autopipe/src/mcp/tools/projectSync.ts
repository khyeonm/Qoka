/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDefinition, textResult, errorResult } from './types';
import { services } from '../../common/services';
import { SshProfile, LOCAL_VM_ID } from '../../common/types';
import { resolveOutputDir } from '../../common/dockerEnv';
import { shellEscape } from '../../common/roCrate';
import {
	listRunOutputs,
	saveResultsToProject,
	workspaceFolderPath,
	humanSize,
} from '../../common/workspaceSync';

/**
 * Durable-save tools: copy autopipe pipeline CODE and selected RESULTS from the
 * run target (the built-in VM or a remote SSH host - both are SshProfiles) into
 * the user's open VS Code workspace folder. The built-in VM's disk is scratch
 * (wiped on base-image updates), so the project folder is the only durable home.
 *
 * Conversational flow the assistant should follow (encoded in the descriptions
 * below so the AI drives it, not the tool): after a run completes, offer to save
 * results to the project; call list_run_outputs to show files with sizes; ASK
 * the user which files to save; for large files WARN it may take a while and
 * confirm first; then call save_results_to_project. Pipeline code is auto-saved
 * on completion, so never ask about it. Input data is never copied - only a
 * manifest of it is written.
 */

function requireProfile() {
	const { config } = services();
	const profile = config.activeProfile();
	if (!profile) {
		throw new Error('No active SSH profile. Configure one via Qoka > Autopipe > SSH.');
	}
	return profile;
}

// "This copy will take a while" thresholds - profile-aware, because transfer
// speed differs by an order of magnitude. The built-in VM is a 127.0.0.1 loopback
// (hundreds of MB/s), so even several GB copy in seconds - only warn when it's
// genuinely huge. A remote SSH host is a real network where ~1 GB already takes
// minutes on a typical connection. The gate only WARNS (needs confirm_large); it
// never skips.
function largeCopyThresholds(profile: SshProfile): { total: number; single: number } {
	const GB = 1024 * 1024 * 1024;
	return profile.id === LOCAL_VM_ID
		? { total: 5 * GB, single: 5 * GB }   // built-in VM (loopback): only very large
		: { total: 1 * GB, single: 1 * GB };  // remote SSH: ~1 GB starts to drag
}

export const PROJECT_TOOLS: ToolDefinition[] = [
	{
		name: 'list_run_outputs',
		description:
			"List a completed run's output files with sizes (recursive), on the SERVER. Note that check_status already copies a finished run's outputs into the project automatically (everything under the auto-copy size limit), so you normally do NOT need this to get results to the user - use it when a file was skipped for being too large, when a copy failed, or when the user asks what else is there. "
			+ 'Paths returned are relative to the run output directory - pass the ones the user picks to save_results_to_project as `files`. '
			+ 'Large files (hundreds of MB or GB, e.g. BAM/CRAM/FASTQ) should be flagged to the user with a warning that copying may take a while before you copy them.',
		inputSchema: {
			type: 'object',
			properties: {
				run_name: { type: 'string', description: 'The run whose outputs to list (same run_name used in execute_pipeline).' },
			},
			required: ['run_name'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const runName = String(args.run_name ?? '');
				if (!runName) {
					return errorResult('list_run_outputs: `run_name` is required');
				}
				const listing = await listRunOutputs(profile, runName);
				if (!listing.ok) {
					return errorResult(listing.message);
				}
				if (listing.files.length === 0) {
					return textResult(`No output files found for run '${runName}' (looked in ${listing.outputDir}).`);
				}
				const totalBytes = listing.files.reduce((n, f) => n + f.sizeBytes, 0);
				const lines = listing.files
					.slice()
					.sort((a, b) => b.sizeBytes - a.sizeBytes)
					.map(f => `  ${f.path}  (${f.sizeHuman})`);
				return textResult([
					`Outputs for run '${runName}' in ${listing.outputDir}:`,
					`${listing.files.length} file(s), ${humanSize(totalBytes)} total.`,
					'',
					...lines,
					'',
					'Ask the user which of these to save into the project. Warn before copying any large files (they can take a while). '
					+ 'Then call save_results_to_project with run_name and the chosen relative paths in `files`. '
					+ 'Pipeline code is already auto-saved on completion, and input data is not copied (only a manifest).',
				].join('\n'));
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'save_results_to_project',
		description:
			"Durably SAVE a completed run into the user's open project folder (<workspaceFolder>/autopipe/). Results under the auto-copy size limit are ALREADY saved automatically when check_status sees the run finish, so use this for the exceptions: a file left behind for being too large, a copy that failed, or a re-save the user asks for. Never use it (or read_file + write_file) to hand-copy results that were already saved. "
			+ 'ALWAYS: (1) copies the pipeline CODE, and (2) writes an input MANIFEST (file list + sizes, NOT the input bytes). '
			+ 'OUTPUT files are copied only when you pass `files` (relative paths from list_run_outputs); omit `files` to save just code + manifest. '
			+ 'Recommended flow: call list_run_outputs first, ASK the user which files to save, then call this. Do NOT ask about pipeline code - it is always saved. '
			+ 'SIZE GATE: if the selection is big enough to take a while to transfer (~1 GB+ on a remote host; only much larger on the fast built-in VM), this tool does NOT copy - it returns a warning with the total size. When that happens, tell the user it may take a while, get their OK, then call again with the SAME files and confirm_large: true. '
			+ 'Copies stream over SFTP (memory-safe for multi-GB files). Returns a per-file success/failure summary; if a file fails, tell the user it can be listed with list_files. '
			+ 'No-ops with a clear message if no project folder is open.',
		inputSchema: {
			type: 'object',
			properties: {
				run_name: { type: 'string', description: 'The completed run to save (same run_name used in execute_pipeline).' },
				files: {
					type: 'array',
					description: 'Relative paths (under the run output dir, from list_run_outputs) to copy. Omit to save only pipeline code + input manifest.',
					items: { type: 'string' },
				},
				image_name: { type: 'string', description: 'Optional Docker image name for the run; used to locate the pipeline code. If omitted, derived from the run metadata.' },
				include_input_manifest: { type: 'boolean', description: 'Write the input-file manifest (default true). The input bytes are never copied.' },
					confirm_large: { type: 'boolean', description: 'Set true ONLY after the user has confirmed a large copy (the tool asked). Skips the size warning and copies. Do not set it on the first call.' },
			},
			required: ['run_name'],
		},
		handler: async (args) => {
			try {
				const profile = requireProfile();
				const runName = String(args.run_name ?? '');
				if (!runName) {
					return errorResult('save_results_to_project: `run_name` is required');
				}
				if (!workspaceFolderPath()) {
					return errorResult('No project folder is open, so there is nowhere to save. Ask the user to open a folder (File > Open Folder), then retry.');
				}

				const files = Array.isArray(args.files)
					? args.files.map(f => String(f)).filter(Boolean)
					: undefined;
				const includeManifest = args.include_input_manifest === undefined ? true : args.include_input_manifest === true;

				// Size gate: if the selection is large, WARN and stop (don't copy) unless
				// the user already confirmed via confirm_large. This forces a "may take a
				// while - proceed?" step before a big download instead of silently pulling.
				const confirmLarge = args.confirm_large === true;
				if (files && files.length > 0 && !confirmLarge) {
					const { total: largeTotal, single: largeSingle } = largeCopyThresholds(profile);
					const listing = await listRunOutputs(profile, runName);
					if (listing.ok && listing.files.length > 0) {
						const sizeOf = new Map(listing.files.map(f => [f.path, f.sizeBytes] as [string, number]));
						let total = 0;
						const big: string[] = [];
						for (const rel of files) {
							const clean = rel.replace(/^\/+/, '');
							const sz = sizeOf.get(clean) ?? 0;
							total += sz;
							if (sz >= largeSingle) { big.push(`  ${clean} (${humanSize(sz)})`); }
						}
						if (total >= largeTotal || big.length > 0) {
							const warn = [
								`This copy is large: ${humanSize(total)} across ${files.length} file(s). Over a remote/network connection it may take a while.`,
							];
							if (big.length > 0) {
								warn.push('Large file(s):', ...big);
							}
							warn.push('', 'Tell the user the size and that it may take a while, ask them to confirm, then call save_results_to_project again with the SAME files and confirm_large: true. (Pipeline code is auto-saved regardless.)');
							return textResult(warn.join('\n'));
						}
					}
				}

				// Prefer an explicit image_name; otherwise recover it from the run
				// metadata written at execute time (.autopipe-run.json).
				let imageName = String(args.image_name ?? '');
				if (!imageName) {
					imageName = await imageNameFromRunMeta(profile, runName);
				}

				const result = await saveResultsToProject(profile, runName, imageName, files, includeManifest);

				const lines: string[] = [];
				lines.push(result.ok ? `Saved run '${runName}' to the project.` : `Saved run '${runName}' with some issues.`);
				lines.push('');
				for (const step of result.steps) {
					lines.push(`${step.ok ? 'OK  ' : 'WARN'} ${step.message}`);
				}
				if (files && files.length > 0) {
					lines.push('');
					lines.push(`Outputs: ${result.outputsCopied} copied, ${result.outputsFailed} failed${result.localOutputDir ? ` -> ${result.localOutputDir}` : ''}.`);
					if (result.outputErrors.length > 0) {
						lines.push('Failed files (can still be listed with list_files):');
						for (const e of result.outputErrors) {
							lines.push(`  FAIL ${e}`);
						}
					}
				} else {
					lines.push('');
					lines.push('No output files requested - saved pipeline code' + (includeManifest ? ' and input manifest' : '') + ' only.');
				}
				// After a successful output save, tell the user where the files landed.
				if (result.outputsCopied > 0) {
					lines.push('', `Tell the user the results were saved and can be opened from the Explorer under autopipe/pipelines_output/${runName}/.`);
				}
				return textResult(lines.join('\n'));
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
];

/** Recover the run's image_name from the `.autopipe-run.json` metadata the
 *  executor writes into the output dir. Returns '' when unavailable. */
async function imageNameFromRunMeta(profile: SshProfile, runName: string): Promise<string> {
	try {
		const { ssh } = services();
		const outputDir = resolveOutputDir(profile, runName);
		const metaPath = `${outputDir.replace(/\/+$/, '')}/.autopipe-run.json`;
		const r = await ssh.run(profile, `cat '${shellEscape(metaPath)}' 2>/dev/null`);
		if (r.exitCode === 0 && r.stdout.trim()) {
			const meta = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
			if (typeof meta.image_name === 'string') {
				return meta.image_name;
			}
		}
	} catch {
		/* fall through */
	}
	return '';
}
