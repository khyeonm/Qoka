/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDefinition, textResult, errorResult } from './types';
import { openInputFormPanel } from '../../panels/inputFormPanel';
import { services } from '../../common/services';
import { resolveRunTarget } from '../../runtime/builtinServer';
import { findPipelineDir } from '../../common/dockerEnv';
import { shellEscape } from '../../common/roCrate';
import { launchPipeline, watchPipelineStart, LaunchedPipeline } from './execution';

/**
 * configure_input opens the Qoka pipeline-input tab (panels/inputFormPanel). The
 * USER fills the pipeline's config values + picks input data there and clicks Save,
 * which stages inputs, rewrites config.yaml and writes a `.qoka-configured.json`
 * marker beside it - but does NOT run. run_configured_pipeline then reads that
 * marker and starts the run (when the user says they saved). Mirrors autopipe-app's
 * configure_input, but as a native tab and with the run kept a separate AI step.
 */
export const CONFIGURE_INPUT_TOOLS: ToolDefinition[] = [
	{
		name: 'configure_input',
		description: 'Open a Qoka tab where the USER fills in a pipeline\'s config values and picks its input data files, then clicks "Save". Use this AFTER download_pipeline, or BEFORE running a pipeline, so the user sets real inputs instead of running with the config\'s placeholder defaults. `pipeline` is the pipeline name (its folder name, i.e. the part after "autopipe-" in the image name). Provide `descriptions` - a map of each config key to a short one-line help string you write (from reading the Snakefile/config/scripts) shown under that field; write them in ENGLISH (the tab UI is English) and cover EVERY editable key. Saving does NOT run the pipeline: it stages the input data, rewrites config.yaml, and records the run settings. After calling this, tell the user (in their language) to fill the tab, pick input files, and click Save, then to tell you once they have. When they confirm, call run_configured_pipeline(pipeline) to START it. Do NOT poll check_status while waiting.',
		inputSchema: {
			type: 'object',
			properties: {
				pipeline: { type: 'string', description: 'Pipeline name (folder name; the part after "autopipe-" in the image).' },
				descriptions: {
					type: 'object',
					description: 'Optional map of config key -> one-line ENGLISH help text to show under each field.',
				},
			},
			required: ['pipeline'],
		},
		handler: async (args) => {
			const pipeline = String(args.pipeline ?? '').trim();
			if (!pipeline) { return errorResult('configure_input: `pipeline` (the pipeline name) is required'); }
			const descriptions = (args.descriptions && typeof args.descriptions === 'object')
				? (args.descriptions as Record<string, string>)
				: {};
			try {
				await openInputFormPanel(pipeline, descriptions);
			} catch (e) {
				return errorResult((e as Error).message);
			}
			return textResult(
				`The pipeline input tab is now open in Qoka. Tell the user (in their language) to fill in the values, `
				+ `pick input files with the file buttons, and click "Save" - which stages the inputs and writes the config, `
				+ `then closes the tab. Saving does NOT start the run. Then STOP: do NOT poll check_status. Ask the user to `
				+ `tell you once they have clicked Save. When they confirm, call run_configured_pipeline("${pipeline}") to `
				+ `start the pipeline, then report progress.`,
			);
		},
	},
	{
		name: 'run_configured_pipeline',
		description: 'Start a pipeline the user has just configured and SAVED in the configure_input tab. Call this ONLY after the user says they clicked Save in that tab. It reads the run settings the tab recorded (run name, cores, staged input dir), starts the pipeline in the background, watches ~90s for early failures, and reports. `pipeline` is the same pipeline name passed to configure_input. If it reports no saved configuration, the user has not clicked Save yet - ask them to, or (if they want to run with the current config unchanged) use execute_pipeline instead.',
		inputSchema: {
			type: 'object',
			properties: {
				pipeline: { type: 'string', description: 'Pipeline name (same as configure_input).' },
			},
			required: ['pipeline'],
		},
		handler: async (args) => {
			const pipeline = String(args.pipeline ?? '').trim();
			if (!pipeline) { return errorResult('run_configured_pipeline: `pipeline` (the pipeline name) is required'); }
			try {
				const { profile } = await resolveRunTarget();
				const { ssh } = services();
				const imageName = `autopipe-${pipeline}`;
				const pipelineDir = await findPipelineDir(profile, imageName);
				if (!pipelineDir) { return errorResult(`Pipeline "${pipeline}" was not found on the run environment.`); }
				const markerPath = `${pipelineDir.replace(/\/+$/, '')}/.qoka-configured.json`;
				const r = await ssh.run(profile, `cat '${shellEscape(markerPath)}'`);
				if (r.exitCode !== 0 || !r.stdout.trim()) {
					return errorResult('No saved input configuration was found for this pipeline. Ask the user to open the input form (configure_input) and click Save first. If they want to run with the config as-is, use execute_pipeline.');
				}
				let cfg: { run_name?: string; cores?: number; input_dir?: string; image_name?: string };
				try { cfg = JSON.parse(r.stdout); } catch { return errorResult('The saved input configuration could not be read. Ask the user to re-open configure_input and Save again.'); }
				const runName = String(cfg.run_name ?? '').trim();
				const inputDir = String(cfg.input_dir ?? '').trim();
				if (!runName || !inputDir) { return errorResult('The saved input configuration is incomplete. Ask the user to re-open configure_input and Save again.'); }
				let launched: LaunchedPipeline;
				try {
					launched = await launchPipeline(profile, { imageName: cfg.image_name || imageName, runName, inputDir, cores: cfg.cores });
				} catch (e) {
					return errorResult((e as Error).message);
				}
				return await watchPipelineStart(profile, launched, runName, cfg.image_name || imageName);
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
];
