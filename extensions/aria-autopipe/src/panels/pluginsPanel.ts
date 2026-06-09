/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { services } from '../common/services';
import { HubPlugin } from '../hub/apiClient';

let activePanel: vscode.WebviewPanel | undefined;

interface PluginRow {
	name: string;
	description: string;
	extensions: string[];
	author: string;
	hubVersion: string;
	installedVersion: string | null;
	isDefault: boolean;
}

/**
 * Editor-area webview panel listing every plugin Aria knows about. Combines
 * the Hub catalog with the user's local install directory so each row
 * shows install/update state alongside the description.
 */
export async function openPluginsPanel(): Promise<void> {
	if (activePanel) {
		activePanel.reveal(vscode.ViewColumn.Active);
		return;
	}
	const panel = vscode.window.createWebviewPanel(
		'aria.autopipe.plugins',
		'Autopipe Plugins',
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	activePanel = panel;
	panel.onDidDispose(() => { activePanel = undefined; });

	panel.webview.html = renderHtml(panel.webview);

	const sendRows = async () => {
		try {
			const hub: HubPlugin[] = await services().hub.listPlugins();
			const rows = buildRows(hub);
			panel.webview.postMessage({ type: 'aria.plugins.list.ok', rows });
		} catch (err) {
			panel.webview.postMessage({ type: 'aria.plugins.list.error', error: (err as Error).message });
		}
	};

	panel.webview.onDidReceiveMessage(async (msg: { type?: string; name?: string }) => {
		if (msg?.type === 'aria.plugins.list') {
			await sendRows();
		} else if (msg?.type === 'aria.plugins.install' && msg.name) {
			try {
				const hub = await services().hub.getPluginByName(msg.name);
				if (!hub) {
					panel.webview.postMessage({ type: 'aria.plugins.action.error', name: msg.name, error: 'Plugin not found on Hub.' });
					return;
				}
				await services().plugins.install(hub);
				panel.webview.postMessage({ type: 'aria.plugins.action.ok', name: msg.name });
				await sendRows();
			} catch (err) {
				panel.webview.postMessage({ type: 'aria.plugins.action.error', name: msg.name, error: (err as Error).message });
			}
		}
	});

	// Auto-fetch on open.
	await sendRows();
}

function buildRows(hubPlugins: HubPlugin[]): PluginRow[] {
	const { plugins } = services();
	const installedMap = new Map<string, string>();
	for (const installed of plugins.listInstalled()) {
		installedMap.set(installed.manifest.name, installed.manifest.version);
	}
	const defaults = new Set([
		'bam-viewer', 'bcf-viewer', 'bed-viewer', 'cram-viewer', 'csv-viewer',
		'fasta-viewer', 'fastq-viewer', 'gff-viewer', 'hdf5-viewer', 'image-viewer',
		'pdf-viewer', 'text-viewer', 'vcf-viewer',
	]);

	const rows: PluginRow[] = hubPlugins.map(p => ({
		name: p.name,
		description: p.description ?? '',
		extensions: p.extensions ?? [],
		author: p.author ?? '',
		hubVersion: p.version,
		installedVersion: installedMap.get(p.name) ?? null,
		isDefault: defaults.has(p.name),
	}));
	// Defaults first, then alphabetical so the user can scan their familiar
	// set without scrolling.
	rows.sort((a, b) => {
		if (a.isDefault !== b.isDefault) {
			return a.isDefault ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});
	return rows;
}

function renderHtml(webview: vscode.Webview): string {
	const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ${webview.cspSource}; img-src ${webview.cspSource} data:`;
	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>Autopipe Plugins</title>
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px; }
		h1 { font-size: 16px; margin: 0 0 4px 0; }
		.subtitle { font-size: 12px; opacity: 0.7; margin-bottom: 16px; }
		.search { margin-bottom: 12px; }
		.search input {
			width: 100%;
			padding: 6px 8px;
			font-size: 13px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 3px;
			box-sizing: border-box;
		}
		.row { display: flex; align-items: flex-start; gap: 12px; padding: 12px; border: 1px solid var(--vscode-widget-border, transparent); border-radius: 4px; background: var(--vscode-editorWidget-background); margin-bottom: 8px; }
		.row .body { flex: 1; }
		.row .name { font-size: 13px; font-weight: 600; }
		.row .meta { font-size: 11px; opacity: 0.7; margin-top: 2px; }
		.row .desc { font-size: 12px; opacity: 0.9; margin-top: 4px; }
		.row .exts { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
		.chip {
			display: inline-block;
			padding: 1px 7px;
			border-radius: 10px;
			font-size: 10.5px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			opacity: 0.85;
		}
		.row .actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
		.btn { padding: 4px 10px; font-size: 12px; cursor: pointer; border-radius: 3px; border: 1px solid transparent; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
		.btn[disabled] { opacity: 0.5; cursor: default; }
		.badge { padding: 2px 6px; font-size: 11px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
		.default-tag { font-size: 10px; opacity: 0.7; padding: 1px 5px; border: 1px solid var(--vscode-widget-border, currentColor); border-radius: 3px; }
		.empty { padding: 24px; text-align: center; opacity: 0.6; }
		.err { padding: 12px; background: var(--vscode-inputValidation-errorBackground, #fee); border: 1px solid var(--vscode-inputValidation-errorBorder, #c44); color: var(--vscode-inputValidation-errorForeground, #c44); border-radius: 3px; }
		.toast { position: fixed; bottom: 16px; right: 16px; padding: 8px 12px; border-radius: 4px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); font-size: 12px; max-width: 320px; }
		.toast.error { color: var(--vscode-errorForeground); }
	</style>
</head>
<body>
	<h1>Autopipe Plugins</h1>
	<div class="subtitle">Viewer plugins matched to file extensions. Defaults install automatically the first time Aria starts.</div>
	<div class="search"><input id="q" placeholder="Search by name, description, or extension…" /></div>
	<div id="results"></div>
	<div id="toast"></div>
	<script>
		const vscode = acquireVsCodeApi();
		const $ = (id) => document.getElementById(id);
		function escapeHtml(s) {
			return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		}
		function statusFor(row) {
			if (!row.installedVersion) return { text: 'Install', kind: 'install' };
			if (row.installedVersion !== row.hubVersion) return { text: 'Update', kind: 'update' };
			return { text: 'Installed', kind: 'installed' };
		}

		// Live client-side filter. We cache the full list so the search box
		// can narrow without re-hitting Hub on every keystroke.
		let allRows = [];
		function applyFilter() {
			const q = $('q').value.trim().toLowerCase();
			if (!q) {
				render(allRows);
				return;
			}
			const filtered = allRows.filter(r => {
				if (r.name && r.name.toLowerCase().includes(q)) return true;
				if (r.description && r.description.toLowerCase().includes(q)) return true;
				if (r.author && r.author.toLowerCase().includes(q)) return true;
				if (r.extensions && r.extensions.some(e => e.toLowerCase().includes(q))) return true;
				return false;
			});
			render(filtered);
		}
		$('q').addEventListener('input', applyFilter);

		function render(rows) {
			if (!rows || rows.length === 0) {
				$('results').innerHTML = '<div class="empty">No plugins found.</div>';
				return;
			}
			const html = rows.map(row => {
				const s = statusFor(row);
				const tag = row.isDefault ? '<span class="default-tag">default</span>' : '';
				// Split meta into clearly separated lines: author + version
				// stay as text since they're short, but the file-extension
				// list becomes a row of chips so each extension is visually
				// isolated from the next.
				const meta = [
					row.author ? '@' + row.author : '',
					'v' + row.hubVersion + (row.installedVersion && row.installedVersion !== row.hubVersion ? ' (have v' + row.installedVersion + ')' : ''),
				].filter(Boolean).join(' · ');
				const exts = (row.extensions || []).map(e => '<span class="chip">.' + escapeHtml(e) + '</span>').join('');
				const btn = s.kind === 'installed'
					? '<button class="btn" disabled>Installed</button>'
					: '<button class="btn" data-name="' + escapeHtml(row.name) + '">' + s.text + '</button>';
				return '<div class="row">'
					+ '<div class="body">'
					+ '<div class="name">' + escapeHtml(row.name) + ' ' + tag + '</div>'
					+ '<div class="meta">' + escapeHtml(meta) + '</div>'
					+ '<div class="desc">' + escapeHtml(row.description) + '</div>'
					+ (exts ? '<div class="exts">' + exts + '</div>' : '')
					+ '</div>'
					+ '<div class="actions">' + btn + '</div>'
					+ '</div>';
			}).join('');
			$('results').innerHTML = html;
			document.querySelectorAll('.btn[data-name]').forEach(btn => {
				btn.onclick = () => {
					const name = btn.getAttribute('data-name');
					btn.disabled = true;
					btn.textContent = 'Working…';
					vscode.postMessage({ type: 'aria.plugins.install', name });
				};
			});
		}
		function toast(msg, error) {
			const t = $('toast');
			t.innerHTML = '<div class="toast' + (error ? ' error' : '') + '">' + escapeHtml(msg) + '</div>';
			setTimeout(() => { t.innerHTML = ''; }, 4000);
		}
		window.addEventListener('message', (e) => {
			if (e.data.type === 'aria.plugins.list.ok') { allRows = e.data.rows || []; applyFilter(); }
			else if (e.data.type === 'aria.plugins.list.error') $('results').innerHTML = '<div class="err">' + escapeHtml(e.data.error) + '</div>';
			else if (e.data.type === 'aria.plugins.action.ok') toast(e.data.name + ' installed.', false);
			else if (e.data.type === 'aria.plugins.action.error') toast(e.data.name + ': ' + e.data.error, true);
		});
		vscode.postMessage({ type: 'aria.plugins.list' });
	</script>
</body>
</html>`;
}
