/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { KernelSession, RelayEvent } from './kernelSession';

/**
 * The "Qoka Run Environment" notebook kernel. A native VSCode NotebookController
 * (NOT an MCP tool): opening a .ipynb and picking this kernel runs each cell in
 * the active run environment (WSL / vfkit / SSH) via KernelSession, streaming
 * outputs back into the cell. One kernel session per notebook document.
 */
export class NotebookKernel {
	private readonly controller: vscode.NotebookController;
	private readonly sessions = new Map<string, KernelSession>();
	private order = 0;

	constructor(ctx: vscode.ExtensionContext, private readonly workspaceRoot: () => string | undefined) {
		this.controller = vscode.notebooks.createNotebookController('qoka-run-kernel', 'jupyter-notebook', 'Qoka Run Environment');
		this.controller.supportedLanguages = ['python'];
		this.controller.supportsExecutionOrder = true;
		this.controller.description = 'Runs cells in the active Qoka run environment (WSL / vfkit / SSH).';
		this.controller.executeHandler = (cells, notebook) => this.execute(cells, notebook);
		this.controller.interruptHandler = (notebook) => { this.sessions.get(notebook.uri.toString())?.interrupt(); };
		ctx.subscriptions.push(this.controller);
		ctx.subscriptions.push(vscode.workspace.onDidCloseNotebookDocument(nb => this.disposeSession(nb.uri.toString())));
	}

	private disposeSession(key: string): void {
		const s = this.sessions.get(key);
		if (s) { s.dispose(); this.sessions.delete(key); }
	}

	private sessionFor(notebook: vscode.NotebookDocument): KernelSession {
		const key = notebook.uri.toString();
		let s = this.sessions.get(key);
		if (!s) {
			const root = this.workspaceRoot() || path.dirname(notebook.uri.fsPath);
			s = new KernelSession(root);
			s.onExit(err => { this.sessions.delete(key); if (err) { void vscode.window.showWarningMessage('Qoka kernel stopped: ' + err); } });
			this.sessions.set(key, s);
		}
		return s;
	}

	private async execute(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void> {
		const session = this.sessionFor(notebook);
		try {
			await session.ensureStarted();
		} catch (e) {
			void vscode.window.showErrorMessage('Qoka kernel failed to start: ' + (e as Error).message);
			// Mark the requested cells as failed so they don't spin forever.
			for (const cell of cells) { const ex = this.controller.createNotebookCellExecution(cell); ex.start(Date.now()); ex.end(false, Date.now()); }
			return;
		}
		this.controller.detail = session.targetLabel;
		for (const cell of cells) { await this.runCell(session, cell); }
	}

	private runCell(session: KernelSession, cell: vscode.NotebookCell): Promise<void> {
		return new Promise<void>((resolve) => {
			const exec = this.controller.createNotebookCellExecution(cell);
			exec.executionOrder = ++this.order;
			exec.start(Date.now());
			void exec.clearOutput();

			const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
			let stream: { out: vscode.NotebookCellOutput; name: 'stdout' | 'stderr'; text: string } | undefined;
			let done = false;
			let sub: vscode.Disposable | undefined;
			let exitSub: vscode.Disposable | undefined;
			const finish = (ok: boolean) => { if (done) { return; } done = true; sub?.dispose(); exitSub?.dispose(); exec.end(ok, Date.now()); resolve(); };

			// Serialize output edits so fast events can't interleave/reorder.
			let chain: Promise<void> = Promise.resolve();
			sub = session.onEvent((e: RelayEvent) => {
				if (e.id !== id) { return; }
				chain = chain.then(() => this.handleEvent(e, exec, () => stream, s => { stream = s; }, finish)).catch(() => { /* keep chain alive */ });
			});
			// Safety: if the kernel dies mid-cell, don't hang.
			exitSub = session.onExit(() => finish(false));
			session.execute(id, cell.document.getText());
		});
	}

	private async handleEvent(
		e: RelayEvent,
		exec: vscode.NotebookCellExecution,
		getStream: () => { out: vscode.NotebookCellOutput; name: 'stdout' | 'stderr'; text: string } | undefined,
		setStream: (s: { out: vscode.NotebookCellOutput; name: 'stdout' | 'stderr'; text: string } | undefined) => void,
		finish: (ok: boolean) => void,
	): Promise<void> {
		const cur = getStream();
		if (e.type === 'stream') {
			const name: 'stdout' | 'stderr' = e.name === 'stderr' ? 'stderr' : 'stdout';
			const text = String(e.text ?? '');
			if (cur && cur.name === name) {
				cur.text += text;
				const item = name === 'stderr' ? vscode.NotebookCellOutputItem.stderr(cur.text) : vscode.NotebookCellOutputItem.stdout(cur.text);
				await exec.replaceOutputItems([item], cur.out);
			} else {
				const item = name === 'stderr' ? vscode.NotebookCellOutputItem.stderr(text) : vscode.NotebookCellOutputItem.stdout(text);
				const out = new vscode.NotebookCellOutput([item]);
				setStream({ out, name, text });
				await exec.appendOutput(out);
			}
		} else if (e.type === 'display') {
			setStream(undefined);
			const data = (e.data ?? {}) as Record<string, unknown>;
			const items = Object.entries(data).map(([mime, val]) => outputItem(mime, val)).filter((x): x is vscode.NotebookCellOutputItem => !!x);
			if (items.length) { await exec.appendOutput(new vscode.NotebookCellOutput(items)); }
		} else if (e.type === 'error') {
			setStream(undefined);
			const err = new Error(String(e.evalue ?? ''));
			err.name = String(e.ename ?? 'Error');
			if (Array.isArray(e.traceback)) { err.stack = (e.traceback as string[]).join('\n'); }
			await exec.appendOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(err)]));
		} else if (e.type === 'reply') {
			finish(e.status === 'ok');
		}
	}
}

/** Map one Jupyter MIME bundle entry to a NotebookCellOutputItem. */
function outputItem(mime: string, value: unknown): vscode.NotebookCellOutputItem | undefined {
	try {
		if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
			const b64 = typeof value === 'string' ? value : String(value);
			return new vscode.NotebookCellOutputItem(Buffer.from(b64, 'base64'), mime);
		}
		if (mime.includes('json')) {
			return vscode.NotebookCellOutputItem.json(value as unknown, mime);
		}
		const s = typeof value === 'string' ? value : Array.isArray(value) ? (value as string[]).join('') : JSON.stringify(value);
		return vscode.NotebookCellOutputItem.text(s, mime);
	} catch {
		return undefined;
	}
}
