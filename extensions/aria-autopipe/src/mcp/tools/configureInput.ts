/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDefinition, textResult, errorResult } from './types';
import { openInputFormPanel } from '../../panels/inputFormPanel';

/**
 * configure_input - opens the Qoka pipeline-input tab (see panels/inputFormPanel).
 * The USER fills the pipeline's config values + picks input data there; the tab's
 * "Save and run" button stages inputs, rewrites config.yaml and starts the run
 * itself, so the AI must NOT also call execute_pipeline. Mirrors autopipe-app's
 * configure_input MCP tool, but as a native tab instead of a browser web form.
 */
export const CONFIGURE_INPUT_TOOLS: ToolDefinition[] = [
	{
		name: 'configure_input',
		description: 'Open a Qoka tab where the USER fills in a pipeline\'s config values and picks its input data files, then clicks "Save and run" to start the pipeline. Use this AFTER download_pipeline, or BEFORE running a pipeline, so the user sets real inputs instead of running with the config\'s placeholder defaults. `pipeline` is the pipeline name (its folder name, i.e. the part after "autopipe-" in the image name). Optional `descriptions` maps each config key to a short one-line help string you write (from reading the Snakefile/config/scripts) that is shown under that field. IMPORTANT: the tab\'s "Save and run" button stages the input data, writes config.yaml, and STARTS the run itself - so after calling this do NOT call execute_pipeline and do NOT poll check_status. Tell the user (in their language) that the input tab is open, to fill it in, pick input files, and click "Save and run", then to tell you once they have. When they confirm, use list_running_pipelines / check_status to report progress.',
		inputSchema: {
			type: 'object',
			properties: {
				pipeline: { type: 'string', description: 'Pipeline name (folder name; the part after "autopipe-" in the image).' },
				descriptions: {
					type: 'object',
					description: 'Optional map of config key -> one-line help text to show under each field.',
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
				+ `pick input files with the file buttons, and click "Save and run" - which stages the inputs, writes the `
				+ `config, STARTS the run, and closes the tab. Then STOP: do NOT call execute_pipeline, and do NOT poll `
				+ `check_status. Ask the user to tell you once they have clicked "Save and run". When they confirm, call `
				+ `list_running_pipelines / check_status to report progress.`,
			);
		},
	},
];
