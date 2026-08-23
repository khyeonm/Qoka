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
import { NOTEBOOK_TOOLS } from './notebook';
import { CONFIGURE_INPUT_TOOLS } from './configureInput';

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
	...CONFIGURE_INPUT_TOOLS, // configure_input (open input tab) + run_configured_pipeline (run what was saved)
	PIPELINE_TOOLS[6], // delete_pipeline (after execution group)
	FILE_TOOLS[3], FILE_TOOLS[4], // create_symlink, remove_symlink
	FILE_TOOLS[0], FILE_TOOLS[1], // list_files, read_file
	RESULT_TOOLS[0], // download_results
	FILE_TOOLS[2], // write_file
	FILE_TOOLS[5], FILE_TOOLS[6], FILE_TOOLS[7], // prepare_input, check_download_status, remove_input
	FILE_TOOLS[8], // upload_local_input (upload data from the user's local machine into pipelines_input)
	// show_results (RESULT_TOOLS[1]) disabled: the in-app viewer is gone, results
	// are inspected in the Analysis tab under results/<run>/. Use
	// list_files to enumerate result files instead. Kept in results.ts so the tool
	// can be re-registered later if the viewer returns.
	// RESULT_TOOLS[1], // show_results
	...PROJECT_TOOLS, // list_run_outputs, save_results_to_project (durable save into the open project folder)
	...WORKSPACE_TOOLS.slice(1), // get_templates, get_generation_guide
	...PLUGIN_TOOLS,
	...VM_TOOLS, // local run environment resources (get/set) - only for the local VM
	...NOTEBOOK_TOOLS, // create_notebook - author a .ipynb the user runs with the Qoka Run Environment kernel

];

/**
 * Server-level guidance for the qoka-autopipe MCP, injected at `initialize`. The
 * autopipe server previously had NO instructions, so a model connected to it
 * (e.g. Codex) got no routing rule and would "check the environment" by running
 * commands in its OWN terminal. This mirrors the qoka-run guidance so EITHER
 * server enforces the same hard rule: run/check code through Qoka tools, never
 * the local shell.
 */
export const AUTOPIPE_MCP_INSTRUCTIONS = [
	'This server ("qoka-autopipe") builds and runs reproducible pipelines and exposes the shared run environment (local run environment or SSH).',
	'',
	'HARD RULE - HOW TO RUN OR CHECK CODE (this overrides your defaults):',
	'ANY request to run/execute code, OR to check the run environment / whether a package or tool is installed (실행, 돌려, run, execute, "is X installed", "환경 확인") MUST go through a Qoka MCP tool. NEVER use your own terminal / shell / bash / python for it.',
	'Do NOT run commands like `python -c ...`, `pip show`, `pip list`, `which`, `conda list`, `Rscript -e ...` in your OWN shell to "see what is installed" - that inspects YOUR machine, NOT the Qoka run environment where the user\'s code actually runs, so the answer is wrong and misleading.',
	'The correct sequence, EVERY time:',
	'  1) Call get_workspace_info FIRST - it reports the ACTIVE run connection (local run environment or SSH) and whether it is reachable.',
	'     - If it says the connection is not reachable / not running, call start_server, then call get_workspace_info again.',
	'  2) Then run on THAT connection:',
	'     - a QUICK one-off (a version/"is anndata installed" check, a short script, a single analysis) -> run_code on the qoka-run MCP. To check whether a package is installed, run a tiny script THERE (e.g. python that imports it) - never check your own machine.',
	'     - a LONG / multi-step / reproducible pipeline -> execute_pipeline on this server.',
'     - a NOTEBOOK the user runs step by step (they say "노트북"/"notebook"/"cell by cell", or want to inspect as they go) -> create_notebook on this server to AUTHOR a .ipynb; the user runs cells with the "Qoka Run Environment" kernel. Do NOT run the cells yourself. To change an existing notebook use edit_notebook (read_notebook first); do NOT re-create it.',
	'  ASK FIRST BY DEFAULT: when the request is just "run/execute this code" (실행/돌려/run) and does NOT clearly specify HOW, ASK before running, offering the THREE ways: "바로 실행(run_code), 재현 파이프라인(autopipe), 아니면 노트북으로 셀 단위 실행(create_notebook) 중 어떻게 할까요?". Do NOT default to building an autopipe pipeline - it needs a Snakefile/config/Dockerfile and is much heavier than run_code, and having used autopipe before in this project is NOT a reason to assume a pipeline this time. Only skip the question when the user was explicit (e.g. "그냥 빨리 돌려줘" -> run_code; "파이프라인으로 만들어줘" -> execute_pipeline; "노트북으로 만들어줘" -> create_notebook).',
	'FALLBACK: if you ever run something in your own terminal and it errors or looks wrong, STOP - that was the wrong tool. Call get_workspace_info to find the run environment, then redo it with run_code / execute_pipeline.',
	'When a Qoka skill (anndata, scanpy, …) matches the task, follow the skill - but still EXECUTE everything through run_code / execute_pipeline on the run connection, never locally.',
	'',
	'NOTEBOOK DATA PATHS: notebook cells run in the ACTIVE run environment (its own filesystem). Prefer RELATIVE paths (data/…). create_notebook/edit_notebook auto-rewrite an absolute LOCAL path to the run-env mount (Windows C:\\… -> /mnt/c/…; Mac vfkit open project -> /mnt/qoka/…). When an SSH server is the active connection there is NO local mount: the notebook runs ON that server and can only read data that already lives there, so a local path fails - tell the user to use data on the SSH server (or switch to the local run environment). If a cell errors with FileNotFound on a local path, fix it to the mounted path with edit_notebook and tell the user to re-run.',
	'NOTEBOOK PYTHON VERSION: each notebook has its OWN conda env, built on python 3.12 by default (broad wheel support - right for almost everything). You CANNOT change python from inside a cell (`!conda install python=…` does nothing to the running kernel and can break the env). If a package the user needs is incompatible with 3.12 (no wheel, or it pins another python) and an install fails for that reason, set the notebook to a compatible python via edit_notebook `python` (e.g. "3.11") and tell the user to RESTART the kernel - the env rebuilds on that version and packages reinstall. Do NOT change the version speculatively; 3.12 is correct unless a real conflict appears.',
	'NOTEBOOK RESULTS (where saved files land): a notebook writes to its cwd = the ACTIVE run environment. On the LOCAL run environment (WSL or vfkit) the open project is MOUNTED, so anything the notebook saves under results/ appears on the user\'s local disk immediately - nothing to copy back. On an SSH server there is NO mount: files the notebook saves stay ON the server and do NOT return by themselves (unlike run_code / execute_pipeline, which auto-copy). So for an SSH notebook, tell the user up front that outputs are saved on the SSH server and to ask when they want them locally; when they do, bring the results/ folder back with list_files + save_results_to_project (or download_results). Do NOT claim SSH notebook results are already local.',
	'NOTEBOOK PLOTS: figures render inline from the kernel\'s default inline backend. When a notebook makes plots, put `%matplotlib inline` in an early cell so they render reliably regardless of kernel state. If a figure does NOT appear right after matplotlib was installed in the SAME session, the kernel must be RESTARTED (a fresh kernel loads the newly-installed package and its inline backend) - image size is NOT the cause, and adding matplotlib.get_backend() only PRINTS the backend, it fixes nothing. Save important figures to results/ with plt.savefig(...) as well, so they persist even if the inline image is missed.',
	'',
	'PIPELINE INPUTS (configure_input + run_configured_pipeline): after download_pipeline succeeds, or before running a pipeline, call configure_input(pipeline) so the USER sets the pipeline\'s config values and picks its input data in a Qoka tab. Do NOT run execute_pipeline with the config\'s placeholder/default values without offering configure_input first. Pass a `descriptions` map (config key -> one-line help you write from reading the Snakefile/config) so each field is explained; write these in ENGLISH (the tab UI is English) and cover EVERY editable key. The tab\'s "Save" button stages the inputs and writes config.yaml but does NOT run - so after calling configure_input do NOT call execute_pipeline and do NOT poll check_status. Tell the user to fill the tab and click "Save", then WAIT and ask them to tell you once they have. When they confirm, call run_configured_pipeline(pipeline) to START the run (it reads what the tab saved), then report with list_running_pipelines / check_status. Data follows the same rule as notebooks: a LOCAL run (WSL/vfkit) picks a file on the user\'s computer (native file button); an SSH run picks data that already lives ON the server (server file browser). Only call execute_pipeline directly when the user explicitly wants to run with the existing config and no input form. ALWAYS open configure_input before running a pipeline so the user enters the inputs - even when that pipeline was run before and its config.yaml still holds the previous run\'s values (the form pre-fills them; the user keeps or changes them).',
	'RESULTS COME BACK BY THEMSELVES: when check_status sees a pipeline finish cleanly, its outputs are copied into the project at results/<run>/ on the user\'s LOCAL disk automatically - including runs on a remote SSH server. run_code does the same into results/<run-name>/. So never chain read_file (server) + write_file (local) to "bring results back", and do not ask the user for permission to save what is already saved. Just tell them the folder to open in the Analysis tab, and read from the LOCAL path if you need the contents. The only files still on the server are ones the tool explicitly reported as skipped for being over the auto-copy size limit, or as failed - handle those with list_run_outputs + save_results_to_project.',
].join('\n');

export function findTool(name: string): ToolDefinition | undefined {
	return ALL_TOOLS.find(t => t.name === name);
}

export { ToolDefinition } from './types';
