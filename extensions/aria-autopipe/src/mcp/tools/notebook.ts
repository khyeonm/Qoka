/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { ToolDefinition, textResult, errorResult } from './types';
import { getRunPathMapping, rewriteCellPaths, pathMappingNote, RunPathMapping } from '../../common/pathMapping';

/**
 * Notebook authoring tools. The AI AUTHORS a Jupyter notebook (.ipynb) and edits
 * its cells; it does NOT run them. The user runs cells with the native "Qoka Run
 * Environment" kernel (NotebookController), which executes in the active run
 * environment (WSL / vfkit / SSH). This is the authoring half; execution is the
 * NotebookController.
 *
 *   - create_notebook : write a NEW notebook, split into cells, and open it.
 *   - edit_notebook   : modify cells of an EXISTING notebook (replace/insert/delete
 *                       ONE cell at a time) without rewriting the whole file, so
 *                       untouched cells and their outputs are preserved.
 *   - read_notebook   : list a notebook's cells (index, kind, source) so the AI can
 *                       target an edit precisely.
 *
 * Local paths a cell references are rewritten to the active run environment's
 * mounted form (see common/pathMapping) so a cell that reads the user's local data
 * resolves inside the VM instead of erroring with FileNotFound.
 */

interface CellIn { source: string; kind: 'code' | 'markdown'; }

/** Normalize a raw `{ source, kind? }` from tool args, rewriting local paths in
 *  CODE cells to the run environment's mounted form. Markdown is left untouched. */
function normalizeCell(raw: unknown, m: RunPathMapping): CellIn {
	const o = (raw ?? {}) as Record<string, unknown>;
	const source = typeof o.source === 'string' ? o.source : '';
	if (o.kind === 'markdown') { return { source, kind: 'markdown' }; }
	return { source: rewriteCellPaths(source, m), kind: 'code' };
}

/** A cell object in nbformat 4.5 JSON. */
function toNbJsonCell(c: CellIn): Record<string, unknown> {
	if (c.kind === 'markdown') {
		return { cell_type: 'markdown', metadata: {}, source: c.source };
	}
	return { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: c.source };
}

/** A VSCode NotebookCellData for the WorkspaceEdit path (edit_notebook). */
function toCellData(c: CellIn): vscode.NotebookCellData {
	return c.kind === 'markdown'
		? new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, c.source, 'markdown')
		: new vscode.NotebookCellData(vscode.NotebookCellKind.Code, c.source, 'python');
}

/** Resolve a project-relative notebook path, forcing a .ipynb extension. */
function resolveNbPath(folder: vscode.WorkspaceFolder, rawPath: unknown, fallback: string): { rel: string; uri: vscode.Uri } {
	const relRaw = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : fallback;
	const rel = relRaw.endsWith('.ipynb') ? relRaw : relRaw + '.ipynb';
	return { rel, uri: vscode.Uri.joinPath(folder.uri, rel) };
}

export const NOTEBOOK_TOOLS: ToolDefinition[] = [
	{
		name: 'create_notebook',
		description: 'Create a NEW Jupyter notebook (.ipynb) in the project, split into cells, and open it. Use this when the user asks for a notebook or wants an analysis authored CELL BY CELL. To modify an EXISTING notebook, use edit_notebook (NOT this - this overwrites the whole file). The cells run with the "Qoka Run Environment" kernel, which executes in the active run environment (local WSL/vfkit or SSH) - so do NOT run the cells yourself and do NOT use run_code for a notebook; just author it and tell the user to run the cells. Each cell is { source: string, kind?: "code" | "markdown" } (default "code"), and `source` IS the code you write for that cell. Split logically (imports, load data, each analysis step, plots) so the user can run and inspect step by step. Prefer RELATIVE data paths (e.g. "data/counts.csv") so cells stay portable across run environments; if you must use an absolute LOCAL path it is auto-rewritten to the run environment mount (Windows C:\\… -> /mnt/c/…, Mac project path -> /mnt/qoka/…). `path` defaults to analysis/notebook.ipynb.',
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

			const mapping = getRunPathMapping();
			const cells = cellsIn.map((c) => normalizeCell(c, mapping));
			const nb = {
				cells: cells.map(toNbJsonCell),
				metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } },
				nbformat: 4,
				nbformat_minor: 5,
			};

			const { rel, uri } = resolveNbPath(folder, args.path, 'analysis/notebook.ipynb');
			try {
				const dir = path.dirname(rel);
				if (dir && dir !== '.') { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, dir)); }
				await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(nb, null, 1), 'utf8'));
				try { await vscode.commands.executeCommand('vscode.openWith', uri, 'jupyter-notebook'); } catch { /* opening is best-effort */ }
				const lines = [
					`Created notebook "${rel}" with ${cells.length} cell(s) and opened it. Tell the user to pick the "Qoka Run Environment" kernel (top-right of the notebook) and run the cells - do NOT run them yourself. To add packages, a cell can use conda, uv, or pip - all install into the same kernel env: \`!conda install -c conda-forge -c bioconda samtools\`, \`!uv pip install scanpy\`, or \`%pip install scanpy\`.`,
				];
				const note = pathMappingNote(mapping);
				if (note) { lines.push('', note); }
				return textResult(lines.join('\n'));
			} catch (e) {
				return errorResult('create_notebook failed: ' + (e as Error).message);
			}
		},
	},
	{
		name: 'read_notebook',
		description: 'List the cells of an existing notebook (.ipynb) as index + kind + source, so you can decide exactly which cell to change with edit_notebook. Read this FIRST before editing a notebook you did not just create. Returns cell indices starting at 0.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Notebook path relative to the project root, e.g. "analysis/qc.ipynb".' },
			},
			required: ['path'],
		},
		handler: async (args) => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) { return errorResult('Open a project folder first.'); }
			const { rel, uri } = resolveNbPath(folder, args.path, 'analysis/notebook.ipynb');
			let doc: vscode.NotebookDocument;
			try {
				doc = await vscode.workspace.openNotebookDocument(uri);
			} catch {
				return errorResult(`Notebook "${rel}" was not found. Use create_notebook to make a new one.`);
			}
			if (doc.cellCount === 0) { return textResult(`Notebook "${rel}" has no cells.`); }
			const parts: string[] = [`Notebook "${rel}" - ${doc.cellCount} cell(s):`, ''];
			for (let i = 0; i < doc.cellCount; i++) {
				const cell = doc.cellAt(i);
				const kind = cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
				const src = cell.document.getText();
				const shown = src.length > 800 ? src.slice(0, 800) + '\n…[truncated]' : src;
				parts.push(`[${i}] (${kind})`, shown, '');
			}
			return textResult(parts.join('\n'));
		},
	},
	{
		name: 'edit_notebook',
		description: 'Modify an EXISTING notebook (.ipynb) one cell at a time, WITHOUT rewriting the whole file - untouched cells and their outputs are preserved. Use this (not create_notebook) whenever the user asks to change, fix, add, or remove a cell in a notebook that already exists. Call read_notebook first to see current cell indices. Provide `edits`, each: { op: "replace" | "insert" | "delete", index: number, source?: string, kind?: "code" | "markdown" }. "replace" swaps cell `index`\'s content; "insert" adds a NEW cell BEFORE `index` (use index = cell count to append); "delete" removes cell `index`. `source` is the new code (required for replace/insert). Indices refer to the notebook\'s CURRENT cell order. `source` gets the same local-path rewriting as create_notebook. Does NOT run cells - tell the user to run them with the Qoka Run Environment kernel.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Notebook path relative to the project root, e.g. "analysis/qc.ipynb".' },
				edits: {
					type: 'array',
					description: 'Ordered edits, each { op: "replace"|"insert"|"delete", index: number, source?: string, kind?: "code"|"markdown" }.',
					items: { type: 'object' },
				},
			},
			required: ['path', 'edits'],
		},
		handler: async (args) => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) { return errorResult('Open a project folder first.'); }
			const editsIn = Array.isArray(args.edits) ? args.edits : [];
			if (editsIn.length === 0) { return errorResult('`edits` must be a non-empty array of { op, index, source?, kind? }.'); }
			const { rel, uri } = resolveNbPath(folder, args.path, 'analysis/notebook.ipynb');

			let doc: vscode.NotebookDocument;
			try {
				doc = await vscode.workspace.openNotebookDocument(uri);
			} catch {
				return errorResult(`Notebook "${rel}" was not found. Use create_notebook to make a new one.`);
			}

			const mapping = getRunPathMapping();
			// Parse + validate every edit up front so a bad one fails before any change.
			type Edit = { op: 'replace' | 'insert' | 'delete'; index: number; cell?: CellIn };
			const edits: Edit[] = [];
			for (const raw of editsIn) {
				const o = (raw ?? {}) as Record<string, unknown>;
				const op = o.op === 'replace' || o.op === 'insert' || o.op === 'delete' ? o.op : undefined;
				if (!op) { return errorResult(`Each edit needs op = "replace" | "insert" | "delete" (got ${JSON.stringify(o.op)}).`); }
				const index = Number(o.index);
				if (!Number.isInteger(index) || index < 0) { return errorResult(`Edit op "${op}" needs an integer index >= 0.`); }
				const max = op === 'insert' ? doc.cellCount : doc.cellCount - 1;
				if (index > max) { return errorResult(`Edit op "${op}" index ${index} is out of range (notebook has ${doc.cellCount} cell(s)).`); }
				if (op === 'delete') {
					edits.push({ op, index });
				} else {
					if (typeof o.source !== 'string') { return errorResult(`Edit op "${op}" at index ${index} needs a "source" string.`); }
					edits.push({ op, index, cell: normalizeCell(o, mapping) });
				}
			}

			// Apply structurally-safe: highest index first, so earlier indices stay valid
			// across inserts/deletes. Each edit is its own applyEdit so the doc updates in
			// between. Replaces are index-stable; the sort keeps them correct too.
			const ordered = [...edits].sort((a, b) => b.index - a.index);
			let replaced = 0, inserted = 0, deleted = 0;
			for (const e of ordered) {
				const we = new vscode.WorkspaceEdit();
				if (e.op === 'delete') {
					we.set(uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(e.index, e.index + 1))]);
					deleted++;
				} else if (e.op === 'insert') {
					we.set(uri, [vscode.NotebookEdit.insertCells(e.index, [toCellData(e.cell!)])]);
					inserted++;
				} else {
					we.set(uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(e.index, e.index + 1), [toCellData(e.cell!)])]);
					replaced++;
				}
				const ok = await vscode.workspace.applyEdit(we);
				if (!ok) { return errorResult(`Failed to apply an edit (op "${e.op}" at index ${e.index}).`); }
			}
			try { await doc.save(); } catch (e) { return errorResult('edit_notebook applied but saving failed: ' + (e as Error).message); }
			try { await vscode.commands.executeCommand('vscode.openWith', uri, 'jupyter-notebook'); } catch { /* best-effort */ }

			const summary = [
				`Edited "${rel}": ${replaced} replaced, ${inserted} inserted, ${deleted} deleted. It now has ${doc.cellCount} cell(s).`,
				'Tell the user to run the changed cells with the "Qoka Run Environment" kernel - do NOT run them yourself.',
			];
			const note = pathMappingNote(mapping);
			if (note) { summary.push('', note); }
			return textResult(summary.join('\n'));
		},
	},
];
