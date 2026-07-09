/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Pipeline } from '../common/types';
import { fetchGitHubTree, fetchGitHubFile } from '../hub/githubFetch';
import { services } from '../common/services';

/**
 * Detail view for a single pipeline. Mirrors autopipe-app's PipelineDetail
 * component: header with metadata, file tree on the left, code viewer on
 * the right, and a Run-Pipeline button that asks Claude to execute the
 * pipeline via the `execute_pipeline` MCP tool.
 *
 * Each pipeline gets its own webview tab — the user can keep several
 * open side by side and switch between them like editor tabs.
 */
const openPanels = new Map<number | null, vscode.WebviewPanel>();

export async function openPipelineDetailPanel(pipeline: Pipeline): Promise<void> {
	const existing = openPanels.get(pipeline.pipeline_id);
	if (existing) {
		existing.reveal(vscode.ViewColumn.Active);
		return;
	}
	const panel = vscode.window.createWebviewPanel(
		'aria.autopipe.pipelineDetail',
		pipeline.name || `Pipeline ${pipeline.pipeline_id}`,
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	openPanels.set(pipeline.pipeline_id, panel);
	panel.onDidDispose(() => { openPanels.delete(pipeline.pipeline_id); });

	panel.webview.html = renderHtml(panel.webview, pipeline);

	panel.webview.onDidReceiveMessage(async (msg: { type?: string; path?: string }) => {
		try {
			if (msg?.type === 'aria.detail.tree') {
				const token = services().config.get().github?.token;
				const tree = await fetchGitHubTree(pipeline.github_url, token);
				panel.webview.postMessage({ type: 'aria.detail.tree.ok', tree });
			} else if (msg?.type === 'aria.detail.file' && msg.path) {
				const token = services().config.get().github?.token;
				const content = await fetchGitHubFile(pipeline.github_url, msg.path, token);
				panel.webview.postMessage({ type: 'aria.detail.file.ok', path: msg.path, content });
			} else if (msg?.type === 'aria.detail.openExternal' && typeof (msg as { url?: unknown }).url === 'string') {
				// Sandboxed webviews can't call window.open(); the Open on
				// GitHub button posts here instead and we open the URL via
				// the extension host's OS handler.
				await vscode.env.openExternal(vscode.Uri.parse((msg as { url: string }).url));
			}
		} catch (err) {
			panel.webview.postMessage({ type: 'aria.detail.error', error: (err as Error).message });
		}
	});
}


function escapeHtml(s: string): string {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function renderHtml(webview: vscode.Webview, pipeline: Pipeline): string {
	const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ${webview.cspSource}; img-src ${webview.cspSource} data:`;
	const metaJson = JSON.stringify(pipeline);
	const tagsHtml = (pipeline.tags ?? []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
	const toolsHtml = (pipeline.tools ?? []).map(t => `<span class="tag tag-tool">${escapeHtml(t)}</span>`).join('');

	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>${escapeHtml(pipeline.name)}</title>
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; }
		.header { padding: 20px 24px; border-bottom: 1px solid var(--vscode-widget-border, transparent); flex-shrink: 0; }
		.title-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
		.title-row h1 { font-size: 18px; font-weight: 700; margin: 0; }
		.verified { font-size: 11px; padding: 2px 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px; }
		.meta-row { display: flex; gap: 16px; font-size: 12px; opacity: 0.85; margin-top: 6px; flex-wrap: wrap; }
		.meta-item strong { opacity: 0.7; margin-right: 4px; }
		.desc { font-size: 13px; opacity: 0.9; margin-top: 10px; max-width: 760px; }
		.tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
		.tag { font-size: 11px; padding: 2px 8px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
		.tag-tool { background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-widget-border, currentColor); }
		.actions { display: flex; gap: 8px; margin-top: 14px; }
		.btn { padding: 6px 14px; font-size: 12px; cursor: pointer; border-radius: 3px; border: none; }
		.btn-primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
		.btn-secondary { color: var(--vscode-foreground); background: transparent; border: 1px solid var(--vscode-widget-border, currentColor); }

		.body { display: flex; flex: 1; min-height: 0; padding: 12px 16px; gap: 0; box-sizing: border-box; }
		.tree {
			width: 280px;
			flex-shrink: 0;
			border: 1px solid var(--vscode-widget-border, transparent);
			border-radius: 4px;
			background: var(--vscode-editorWidget-background);
			overflow-y: auto;
			padding: 8px 0;
			min-width: 150px;
		}
		/* Draggable gutter between the file tree and the code pane. We
		 * use the standard ew-resize cursor and give the gutter a thin
		 * hover hairline so it's discoverable without being noisy when
		 * idle. */
		.gutter {
			flex: 0 0 8px;
			cursor: ew-resize;
			position: relative;
		}
		.gutter::after {
			content: '';
			position: absolute;
			left: 50%;
			top: 0;
			bottom: 0;
			width: 1px;
			background: var(--vscode-widget-border, transparent);
			opacity: 0.6;
		}
		.gutter:hover::after { opacity: 1; }
		.tree-item {
			padding: 3px 12px 3px 8px;
			font-size: 12px;
			cursor: pointer;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			display: flex;
			align-items: center;
			gap: 6px;
			user-select: none;
		}
		.tree-item:hover { background: var(--vscode-list-hoverBackground); }
		.tree-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
		.tree-folder { font-weight: 600; }
		.tree-folder .tree-label { opacity: 0.85; }
		.tree-icon { width: 14px; text-align: center; flex-shrink: 0; font-size: 12px; }
		/* Pure-CSS triangle. .open rotates it 90deg so closed = pointing
		 * right (collapsed), open = pointing down (expanded). */
		.caret {
			width: 0; height: 0;
			border-top: 4px solid transparent;
			border-bottom: 4px solid transparent;
			border-left: 5px solid var(--vscode-foreground);
			opacity: 0.7;
			transition: transform 0.1s;
			flex-shrink: 0;
		}
		.caret.open { transform: rotate(90deg); }
		.caret-spacer { width: 5px; flex-shrink: 0; }
		/* Code pane with its own border so it visibly sits in a card next
		 * to the file tree instead of bleeding to the edges of the tab. */
		.code-pane {
			flex: 1;
			min-width: 0;
			overflow: auto;
			border: 1px solid var(--vscode-widget-border, transparent);
			border-radius: 4px;
			background: var(--vscode-editor-background);
		}
		.code-pane pre {
			margin: 0;
			padding: 12px 16px;
			font-family: var(--vscode-editor-font-family);
			font-size: 12px;
			white-space: pre;
			tab-size: 4;
			color: var(--vscode-editor-foreground);
		}
		.placeholder { padding: 32px; opacity: 0.6; text-align: center; }
		.err { padding: 12px; background: var(--vscode-inputValidation-errorBackground, #fee); color: var(--vscode-inputValidation-errorForeground, #c44); border: 1px solid var(--vscode-inputValidation-errorBorder, #c44); border-radius: 3px; margin: 12px; }
	</style>
</head>
<body>
	<div class="header">
		<div class="title-row">
			<h1>${escapeHtml(pipeline.name)}</h1>
			${pipeline.verified ? '<span class="verified">verified</span>' : ''}
		</div>
		<div class="meta-row">
			<div class="meta-item"><strong>Author</strong> ${escapeHtml(pipeline.author ?? '')}</div>
			<div class="meta-item"><strong>Version</strong> v${escapeHtml(pipeline.version ?? '')}</div>
			${pipeline.github_url ? `<div class="meta-item"><strong>GitHub</strong> ${escapeHtml(pipeline.github_url.replace('https://github.com/', ''))}</div>` : ''}
		</div>
		${pipeline.description ? `<div class="desc">${escapeHtml(pipeline.description)}</div>` : ''}
		<div class="tags">${toolsHtml}${tagsHtml}</div>
	</div>
	<div class="body">
		<div class="tree" id="tree"><div class="placeholder">Loading files…</div></div>
		<div class="gutter" id="gutter"></div>
		<div class="code-pane" id="code"><div class="placeholder">Pick a file to view its contents.</div></div>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		const meta = ${metaJson};
		const $ = (id) => document.getElementById(id);
		const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

		let selectedFile = null;
		let lastEntries = [];
		const expanded = new Set();

		// Build a nested directory tree from the flat list of paths we get
		// from GitHub. Each entry's slash-separated path becomes a chain
		// of directory nodes ending in a file node. We cache the original
		// entries so toggling a folder doesn't refetch — we just re-render
		// using the new expanded set.
		function buildHierarchy(entries) {
			const root = { name: '', path: '', type: 'dir', children: new Map() };
			for (const e of entries) {
				const parts = e.path.split('/').filter(Boolean);
				let node = root;
				for (let i = 0; i < parts.length - 1; i++) {
					const name = parts[i];
					if (!node.children.has(name)) {
						node.children.set(name, { name, path: parts.slice(0, i + 1).join('/'), type: 'dir', children: new Map() });
					}
					node = node.children.get(name);
				}
				const last = parts[parts.length - 1];
				if (!last) continue;
				if (e.entry_type === 'tree') {
					if (!node.children.has(last)) {
						node.children.set(last, { name: last, path: e.path, type: 'dir', children: new Map() });
					}
				} else {
					node.children.set(last, { name: last, path: e.path, type: 'file' });
				}
			}
			return root;
		}

		function nodeChildrenSorted(node) {
			return [...node.children.values()].sort((a, b) => {
				if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
		}

		function renderNode(node, depth) {
			let html = '';
			for (const child of nodeChildrenSorted(node)) {
				const indent = 'padding-left:' + (8 + depth * 14) + 'px;';
				if (child.type === 'dir') {
					const isOpen = expanded.has(child.path);
					// Caret + folder glyph mirrors autopipe-app's file tree
					// (▶/▼ as a CSS triangle, single folder emoji). Simple
					// and visually scannable.
					const caretCls = isOpen ? 'caret open' : 'caret';
					html += '<div class="tree-item tree-folder" data-path="' + escapeHtml(child.path) + '" data-type="dir" style="' + indent + '">'
						+ '<span class="' + caretCls + '"></span>'
						+ '<span class="tree-icon">📁</span>'
						+ '<span class="tree-label">' + escapeHtml(child.name) + '</span>'
						+ '</div>';
					if (isOpen) {
						html += renderNode(child, depth + 1);
					}
				} else {
					const selCls = (child.path === selectedFile) ? ' selected' : '';
					html += '<div class="tree-item' + selCls + '" data-path="' + escapeHtml(child.path) + '" data-type="blob" style="' + indent + '">'
						+ '<span class="caret-spacer"></span>'
						+ '<span class="tree-icon">📄</span>'
						+ '<span class="tree-label">' + escapeHtml(child.name) + '</span>'
						+ '</div>';
				}
			}
			return html;
		}

		function renderTree(entries) {
			if (entries && entries.length) {
				lastEntries = entries;
			}
			if (!lastEntries.length) {
				$('tree').innerHTML = '<div class="placeholder">Empty repository.</div>';
				return;
			}
			const root = buildHierarchy(lastEntries);
			$('tree').innerHTML = renderNode(root, 0);
			document.querySelectorAll('.tree-item').forEach(el => {
				el.onclick = () => {
					const type = el.getAttribute('data-type');
					const path = el.getAttribute('data-path');
					if (type === 'dir') {
						if (expanded.has(path)) expanded.delete(path);
						else expanded.add(path);
						renderTree();
					} else {
						selectedFile = path;
						$('code').innerHTML = '<div class="placeholder">Loading ' + escapeHtml(path) + '…</div>';
						vscode.postMessage({ type: 'aria.detail.file', path });
						renderTree();
					}
				};
			});
		}

		window.addEventListener('message', (e) => {
			const msg = e.data;
			if (msg.type === 'aria.detail.tree.ok') renderTree(msg.tree);
			else if (msg.type === 'aria.detail.file.ok' && msg.path === selectedFile) {
				$('code').innerHTML = '<pre>' + escapeHtml(msg.content) + '</pre>';
			}
			else if (msg.type === 'aria.detail.error') $('code').innerHTML = '<div class="err">' + escapeHtml(msg.error) + '</div>';
		});


		// Drag-to-resize for the file-tree / code split. We update the
		// tree's inline width on each mousemove and clamp to a min so
		// the user can't drag it all the way to zero.
		(function() {
			const gutter = document.getElementById('gutter');
			const tree = document.getElementById('tree');
			const body = document.querySelector('.body');
			if (!gutter || !tree || !body) return;
			let dragging = false;
			gutter.addEventListener('mousedown', (e) => {
				dragging = true;
				document.body.style.cursor = 'ew-resize';
				e.preventDefault();
			});
			document.addEventListener('mousemove', (e) => {
				if (!dragging) return;
				const rect = body.getBoundingClientRect();
				const newWidth = Math.max(150, Math.min(rect.width - 200, e.clientX - rect.left));
				tree.style.width = newWidth + 'px';
			});
			document.addEventListener('mouseup', () => {
				if (dragging) {
					dragging = false;
					document.body.style.cursor = '';
				}
			});
		})();

		// Initial load
		vscode.postMessage({ type: 'aria.detail.tree' });
	</script>
</body>
</html>`;
}
