/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDefinition } from './types';
import { WORKSPACE_TOOLS } from './workspace';
import { PIPELINE_TOOLS } from './pipeline';
import { EXECUTION_TOOLS } from './execution';
import { FILE_TOOLS } from './files';
import { RESULT_TOOLS } from './results';
import { PROJECT_TOOLS } from './projectSync';
import { PLUGIN_TOOLS } from './plugins';
import { VM_TOOLS } from './vm';

// Concatenated in the order they appear in autopipe-app's server.rs so that
// `tools/list` returns tools in a consistent, predictable sequence.
export const ALL_TOOLS: ToolDefinition[] = [
	...WORKSPACE_TOOLS.slice(0, 1), // get_workspace_info up front - AI assistants are told to call it first
	...PIPELINE_TOOLS.slice(0, 2),   // search_pipelines, list_pipelines
	PIPELINE_TOOLS[2], // download_pipeline
	PIPELINE_TOOLS[3], // upload_pipeline
	PIPELINE_TOOLS[4], // publish_pipeline
	PIPELINE_TOOLS[5], // unpublish_pipeline
	PIPELINE_TOOLS[7], // validate_pipeline
	...EXECUTION_TOOLS,
	PIPELINE_TOOLS[6], // delete_pipeline (after execution group)
	FILE_TOOLS[3], FILE_TOOLS[4], // create_symlink, remove_symlink
	FILE_TOOLS[0], FILE_TOOLS[1], // list_files, read_file
	RESULT_TOOLS[0], // download_results
	FILE_TOOLS[2], // write_file
	FILE_TOOLS[5], FILE_TOOLS[6], FILE_TOOLS[7], // prepare_input, check_download_status, remove_input
	FILE_TOOLS[8], // upload_local_input (upload data from the user's local machine into pipelines_input)
	RESULT_TOOLS[1], // show_results
	...PROJECT_TOOLS, // list_run_outputs, save_results_to_project (durable save into the open project folder)
	...WORKSPACE_TOOLS.slice(1), // get_templates, get_generation_guide
	...PLUGIN_TOOLS,
	...VM_TOOLS, // built-in server resources (get/set) - only for the local VM

];

export function findTool(name: string): ToolDefinition | undefined {
	return ALL_TOOLS.find(t => t.name === name);
}

export { ToolDefinition } from './types';
