/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDefinition, textResult, errorResult } from './types';
import { services } from '../../common/services';
import { SshProfile } from '../../common/types';
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
		throw new Error('No active SSH profile. Configure one via Aria > Autopipe > SSH.');
	}
	return profile;
}

export const PROJECT_TOOLS: ToolDefinition[] = [
	{
		name: 'list_run_outputs',
		description:
			"List a completed run's output files with sizes (recursive), so you can show the user what is available and ASK which files to save into their project. "
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
			"Durably SAVE a completed run into the user's open project folder (<workspaceFolder>/autopipe/). Use this after a run finishes and the user has chosen what to keep - the built-in VM's disk is scratch and can be wiped, so this is how results survive. "
			+ 'ALWAYS: (1) copies the pipeline CODE, and (2) writes an input MANIFEST (file list + sizes, NOT the input bytes). '
			+ 'OUTPUT files are copied only when you pass `files` (relative paths from list_run_outputs); omit `files` to save just code + manifest. '
			+ 'Recommended flow: call list_run_outputs first, ASK the user which files to save, WARN about large files and confirm, then call this. Do NOT ask about pipeline code - it is always saved. '
			+ 'Copies stream over SFTP (memory-safe for multi-GB files). Returns a per-file success/failure summary; if a file fails, tell the user it can still be opened in-app with show_results. '
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
						lines.push('Failed files (still viewable in-app with show_results):');
						for (const e of result.outputErrors) {
							lines.push(`  FAIL ${e}`);
						}
					}
				} else {
					lines.push('');
					lines.push('No output files requested - saved pipeline code' + (includeManifest ? ' and input manifest' : '') + ' only.');
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
