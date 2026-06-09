/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { services } from '../common/services';
import { Pipeline } from '../common/types';
import { openPipelineDetailPanel } from './pipelineDetailPanel';

/**
 * Editor-area webview panel that lists pipelines from Autopipe Hub. The
 * panel is reused on subsequent invocations: the second click on the
 * "Pipeline Hub" button focuses the existing tab instead of opening a
 * new one, so the editor area doesn't accumulate duplicates.
 */
let activePanel: vscode.WebviewPanel | undefined;

export async function openHubPanel(): Promise<void> {
	if (activePanel) {
		activePanel.reveal(vscode.ViewColumn.Active);
		return;
	}
	const panel = vscode.window.createWebviewPanel(
		'aria.autopipe.hub',
		'Autopipe Hub',
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	activePanel = panel;
	panel.onDidDispose(() => { activePanel = undefined; });

	panel.webview.html = renderHtml(panel.webview);

	// Cache the most recently fetched list so the click handler can resolve
	// a pipeline_id to its full payload without re-fetching from Hub.
	let lastList: Pipeline[] = [];

	panel.webview.onDidReceiveMessage(async (msg: { type?: string; query?: string; pipelineId?: number }) => {
		if (msg?.type === 'aria.hub.list') {
			try {
				lastList = await services().hub.listPipelines();
				panel.webview.postMessage({ type: 'aria.hub.list.ok', pipelines: lastList.slice(0, 200) });
			} catch (err) {
				panel.webview.postMessage({ type: 'aria.hub.list.error', error: (err as Error).message });
			}
		} else if (msg?.type === 'aria.hub.search') {
			try {
				lastList = await services().hub.searchPipelines(String(msg.query ?? ''));
				panel.webview.postMessage({ type: 'aria.hub.list.ok', pipelines: lastList.slice(0, 200) });
			} catch (err) {
				panel.webview.postMessage({ type: 'aria.hub.list.error', error: (err as Error).message });
			}
		} else if (msg?.type === 'aria.hub.open' && typeof msg.pipelineId === 'number') {
			const pipeline = lastList.find(p => p.pipeline_id === msg.pipelineId);
			if (pipeline) {
				await openPipelineDetailPanel(pipeline);
			}
		}
	});
}

function renderHtml(webview: vscode.Webview): string {
	const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ${webview.cspSource}; img-src ${webview.cspSource} data:`;
	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>Autopipe Hub</title>
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px; }
		.search { display: flex; gap: 8px; margin-bottom: 16px; }
		.search input { flex: 1; padding: 6px 8px; font-size: 13px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; }
		.search button { padding: 6px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; }
		/* One pipeline per row. Inside each card the elements are stacked
		 * vertically with explicit line breaks so the description never
		 * sits inline next to the tags row, and long descriptions wrap
		 * within the card instead of bleeding past its border. */
		.list { display: flex; flex-direction: column; gap: 8px; }
		.card {
			padding: 12px 14px;
			border: 1px solid var(--vscode-widget-border, transparent);
			border-radius: 4px;
			background: var(--vscode-editorWidget-background);
			cursor: pointer;
			display: flex;
			flex-direction: column;
			gap: 4px;
			box-sizing: border-box;
			overflow-wrap: break-word;
			word-break: break-word;
		}
		.card:hover { background: var(--vscode-list-hoverBackground); }
		.card .name-row { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
		.card .name { font-size: 13px; font-weight: 600; }
		.card .meta { font-size: 11px; opacity: 0.7; }
		.card .tags { display: flex; gap: 4px; flex-wrap: wrap; }
		.chip {
			display: inline-block;
			padding: 1px 7px;
			border-radius: 10px;
			font-size: 10.5px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			opacity: 0.85;
		}
		.card .desc {
			font-size: 12px;
			opacity: 0.85;
			margin-top: 4px;
			overflow-wrap: break-word;
			word-break: break-word;
		}
		.empty { padding: 24px; text-align: center; opacity: 0.6; }
		.err { padding: 12px; background: var(--vscode-inputValidation-errorBackground, #fee); border: 1px solid var(--vscode-inputValidation-errorBorder, #c44); color: var(--vscode-inputValidation-errorForeground, #c44); border-radius: 3px; }
	</style>
</head>
<body>
	<div class="search">
		<input id="q" placeholder="Search pipelines…" />
		<button id="refresh">Refresh</button>
	</div>
	<div id="results"></div>
	<script>
		const vscode = acquireVsCodeApi();
		const $ = (id) => document.getElementById(id);
		function render(pipelines) {
			if (!pipelines || pipelines.length === 0) {
				$('results').innerHTML = '<div class="empty">No pipelines.</div>';
				return;
			}
			const html = pipelines.map(p => {
				const name = (p.name || 'untitled');
				const author = p.author ? '@' + p.author : '';
				const version = p.version ? 'v' + p.version : '';
				const desc = p.description || '';
				// Each tag becomes its own chip so adjacent tags are
				// visually separated instead of running together in a
				// comma list. Matches the Plugins panel styling.
				const tagsHtml = (p.tags || []).map(t => '<span class="chip">' + escapeHtml(t) + '</span>').join('');
				const metaParts = [author, version].filter(Boolean).join(' · ');
				return '<div class="card" data-id="' + p.pipeline_id + '">'
					+ '<div class="name-row">'
						+ '<div class="name">' + escapeHtml(name) + '</div>'
						+ (metaParts ? '<div class="meta">' + escapeHtml(metaParts) + '</div>' : '')
					+ '</div>'
					+ (tagsHtml ? '<div class="tags">' + tagsHtml + '</div>' : '')
					+ (desc ? '<div class="desc">' + escapeHtml(desc) + '</div>' : '')
					+ '</div>';
			}).join('');
			$('results').innerHTML = '<div class="list">' + html + '</div>';
			document.querySelectorAll('.card').forEach(el => {
				el.onclick = () => {
					const id = Number(el.getAttribute('data-id'));
					if (Number.isFinite(id)) {
						vscode.postMessage({ type: 'aria.hub.open', pipelineId: id });
					}
				};
			});
		}
		function escapeHtml(s) {
			return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		}
		window.addEventListener('message', (e) => {
			if (e.data.type === 'aria.hub.list.ok') render(e.data.pipelines);
			else if (e.data.type === 'aria.hub.list.error') $('results').innerHTML = '<div class="err">' + escapeHtml(e.data.error) + '</div>';
		});
		// Live search: debounce 250 ms so we don't fire a request on every
		// keystroke, and fall back to a full list when the box is cleared.
		let searchTimer = null;
		$('q').addEventListener('input', () => {
			if (searchTimer) clearTimeout(searchTimer);
			searchTimer = setTimeout(() => {
				const q = $('q').value.trim();
				if (q) {
					vscode.postMessage({ type: 'aria.hub.search', query: q });
				} else {
					vscode.postMessage({ type: 'aria.hub.list' });
				}
			}, 250);
		});
		$('refresh').onclick = () => { $('q').value = ''; vscode.postMessage({ type: 'aria.hub.list' }); };
		vscode.postMessage({ type: 'aria.hub.list' });
	</script>
</body>
</html>`;
}
