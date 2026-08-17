/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { ToolDefinition, textResult, errorResult } from './types';

/**
 * `create_notebook` - the AI authors a Jupyter notebook (.ipynb) split into cells
 * and opens it. It does NOT run the cells: the user runs them with the native
 * "Qoka Run Environment" kernel (NotebookKernel), which executes in the active run
 * environment. This is the authoring half; execution is the NotebookController.
 */
export const NOTEBOOK_TOOLS: ToolDefinition[] = [
	{
		name: 'create_notebook',
		description: 'Create a Jupyter notebook (.ipynb) in the project, split into cells, and open it. Use this when the user asks for a notebook or wants an analysis authored CELL BY CELL. The cells run with the "Qoka Run Environment" kernel, which executes in the active run environment (local or SSH) - so do NOT run the cells yourself and do NOT use run_code for a notebook; just author it and tell the user to run the cells. Each cell is { source: string, kind?: "code" | "markdown" } (default "code"). Split logically (imports, load data, each analysis step, plots) so the user can run and inspect step by step. `path` defaults to analysis/notebook.ipynb.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Target path relative to the project root, e.g. "analysis/qc.ipynb". Defaults to "analysis/notebook.ipynb".' },
				cells: {
					type: 'array',
					description: 'Ordered cells. Each: { source: string, kind?: "code" | "markdown" }.',
					items: { type: 'object' },
				},
			},
			required: ['cells'],
		},
		handler: async (args) => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) { return errorResult('Open a project folder first, then create the notebook.'); }
			const cellsIn = Array.isArray(args.cells) ? args.cells : [];
			if (cellsIn.length === 0) { return errorResult('`cells` must be a non-empty array of { source, kind? }.'); }

			const relRaw = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : 'analysis/notebook.ipynb';
			const rel = relRaw.endsWith('.ipynb') ? relRaw : relRaw + '.ipynb';

			const cells = cellsIn.map((c) => {
				const o = (c ?? {}) as Record<string, unknown>;
				const source = typeof o.source === 'string' ? o.source : '';
				if (o.kind === 'markdown') {
					return { cell_type: 'markdown', metadata: {}, source };
				}
				return { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source };
			});
			const nb = {
				cells,
				metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } },
				nbformat: 4,
				nbformat_minor: 5,
			};

			const uri = vscode.Uri.joinPath(folder.uri, rel);
			try {
				const dir = path.dirname(rel);
				if (dir && dir !== '.') { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, dir)); }
				await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(nb, null, 1), 'utf8'));
				try { await vscode.commands.executeCommand('vscode.openWith', uri, 'jupyter-notebook'); } catch { /* opening is best-effort */ }
				return textResult(`Created notebook "${rel}" with ${cells.length} cell(s) and opened it. Tell the user to pick the "Qoka Run Environment" kernel (top-right of the notebook) and run the cells - do NOT run them yourself. To add packages, a cell can use conda, uv, or pip - all install into the same kernel env: \`!conda install -c conda-forge -c bioconda samtools\`, \`!uv pip install scanpy\`, or \`%pip install scanpy\`.`);
			} catch (e) {
				return errorResult('create_notebook failed: ' + (e as Error).message);
			}
		},
	},
];
