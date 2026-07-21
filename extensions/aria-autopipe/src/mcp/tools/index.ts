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
	// show_results (RESULT_TOOLS[1]) disabled: the in-app viewer is gone, results
	// are inspected in the Explorer under autopipe/pipelines_output/<run>/. Use
	// list_files to enumerate result files instead. Kept in results.ts so the tool
	// can be re-registered later if the viewer returns.
	// RESULT_TOOLS[1], // show_results
	...PROJECT_TOOLS, // list_run_outputs, save_results_to_project (durable save into the open project folder)
	...WORKSPACE_TOOLS.slice(1), // get_templates, get_generation_guide
	...PLUGIN_TOOLS,
	...VM_TOOLS, // built-in server resources (get/set) - only for the local VM

];

/**
 * Server-level guidance for the autopipe MCP, injected at `initialize`. The
 * autopipe server previously had NO instructions, so a model connected to it
 * (e.g. Codex) got no routing rule and would "check the environment" by running
 * commands in its OWN terminal. This mirrors the qoka-run guidance so EITHER
 * server enforces the same hard rule: run/check code through Qoka tools, never
 * the local shell.
 */
export const AUTOPIPE_MCP_INSTRUCTIONS = [
	'This server ("autopipe") builds and runs reproducible pipelines and exposes the shared run environment (built-in server or SSH).',
	'',
	'HARD RULE - HOW TO RUN OR CHECK CODE (this overrides your defaults):',
	'ANY request to run/execute code, OR to check the run environment / whether a package or tool is installed (실행, 돌려, run, execute, "is X installed", "환경 확인") MUST go through a Qoka MCP tool. NEVER use your own terminal / shell / bash / python for it.',
	'Do NOT run commands like `python -c ...`, `pip show`, `pip list`, `which`, `conda list`, `Rscript -e ...` in your OWN shell to "see what is installed" - that inspects YOUR machine, NOT the Qoka run environment where the user\'s code actually runs, so the answer is wrong and misleading.',
	'The correct sequence, EVERY time:',
	'  1) Call get_workspace_info FIRST - it reports the ACTIVE run connection (built-in server or SSH) and whether it is reachable.',
	'     - If it says the connection is not reachable / not running, call start_server, then call get_workspace_info again.',
	'  2) Then run on THAT connection:',
	'     - a QUICK one-off (a version/"is anndata installed" check, a short script, a single analysis) -> run_code on the qoka-run MCP. To check whether a package is installed, run a tiny script THERE (e.g. python that imports it) - never check your own machine.',
	'     - a LONG / multi-step / reproducible pipeline -> execute_pipeline on this server.',
	'FALLBACK: if you ever run something in your own terminal and it errors or looks wrong, STOP - that was the wrong tool. Call get_workspace_info to find the run environment, then redo it with run_code / execute_pipeline.',
	'When a Qoka skill (anndata, scanpy, …) matches the task, follow the skill - but still EXECUTE everything through run_code / execute_pipeline on the run connection, never locally.',
].join('\n');

export function findTool(name: string): ToolDefinition | undefined {
	return ALL_TOOLS.find(t => t.name === name);
}

export { ToolDefinition } from './types';
