/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { services } from '../common/services';
import { resolveRunTarget } from '../runtime/builtinServer';
import { localToRunEnvPath } from '../common/pathMapping';
import { parseConfigFields, formatValue, setYamlValue, ConfigField } from '../common/configFields';
import { launchPipeline } from '../mcp/tools/execution';
import { workspacePathsFor, SshProfile } from '../common/types';
import { shellEscape } from '../common/roCrate';
import { findPipelineDir } from '../common/dockerEnv';

/**
 * "autopipe input" tab for a pipeline. Mirrors autopipe-app's web input form, but
 * rendered as a native Qoka webview tab: the pipeline's own config.yaml is parsed
 * into editable fields (values inferred from the YAML, file pickers for input-data
 * keys). On "Save and run" the tab stages the picked input files, writes the values
 * back into config.yaml (comments preserved), STARTS the run, and closes itself.
 *
 * Data lives on the run target (same rule as notebooks): a LOCAL run (WSL/vfkit)
 * picks a local file (native dialog) that is symlinked in through the mount; an SSH
 * run picks a path that already exists on the server (server-side file browser).
 */
const openPanels = new Map<string, vscode.WebviewPanel>();

export async function openInputFormPanel(pipelineName: string, descriptions: Record<string, string> = {}): Promise<void> {
	const name = String(pipelineName || '').trim();
	if (!name) { vscode.window.showErrorMessage('Qoka: a pipeline name is required to configure inputs.'); return; }

	const existing = openPanels.get(name);
	if (existing) { existing.reveal(vscode.ViewColumn.Active); return; }

	const { profile, isBuiltIn } = await resolveRunTarget();
	const { ssh } = services();
	const imageName = `autopipe-${name}`;
	const pipelineDir = await findPipelineDir(profile, imageName);
	if (!pipelineDir) {
		vscode.window.showErrorMessage(`Qoka: pipeline "${name}" was not found on the run environment. Download or build it first, then try again.`);
		return;
	}
	const configPath = `${pipelineDir.replace(/\/+$/, '')}/config.yaml`;
	const catRes = await ssh.run(profile, `cat '${shellEscape(configPath)}'`);
	if (catRes.exitCode !== 0) {
		vscode.window.showErrorMessage(`Qoka: could not read ${configPath}: ${catRes.stderr.trim() || 'read failed'}`);
		return;
	}
	const originalYaml = catRes.stdout;
	const fields = parseConfigFields(originalYaml, descriptions);

	// How many cores the run target actually has, so the Cores field is bounded to a
	// real number instead of an arbitrary one the machine cannot honour.
	const nprocRes = await ssh.run(profile, 'nproc 2>/dev/null || echo 4');
	const availCores = Math.max(1, parseInt((nprocRes.stdout || '').trim(), 10) || 4);
	// Where the SSH file browser starts (the configured project dir, else home).
	const serverStart = (workspacePathsFor(profile).repo_path || '').trim() || '$HOME';

	const panel = vscode.window.createWebviewPanel(
		'aria.autopipe.inputForm',
		'autopipe input',
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	openPanels.set(name, panel);
	panel.onDidDispose(() => { openPanels.delete(name); });
	panel.webview.html = renderHtml(panel.webview, name, fields, isBuiltIn, availCores);

	panel.webview.onDidReceiveMessage(async (msg: { type?: string; key?: string; dir?: string; runName?: string; cores?: number; values?: Record<string, string> }) => {
		try {
			if (msg?.type === 'aria.input.pickLocal' && msg.key) {
				const uris = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use this file' });
				if (uris && uris.length) {
					panel.webview.postMessage({ type: 'aria.input.picked', key: msg.key, path: uris[0].fsPath });
				}
			} else if (msg?.type === 'aria.input.browseServer' && msg.key) {
				const dir = (msg.dir && String(msg.dir).trim()) ? String(msg.dir).trim() : serverStart;
				// pwd resolves the absolute dir (also expands a leading $HOME); ls -1Ap
				// lists entries with a trailing / on directories (hidden included, . / ..
				// excluded). The webview adds its own ".." row for navigating up.
				const r = await ssh.run(profile, `cd ${dir === '$HOME' ? '$HOME' : `'${shellEscape(dir)}'`} 2>/dev/null && pwd && ls -1Ap 2>/dev/null`);
				if (r.exitCode !== 0) {
					panel.webview.postMessage({ type: 'aria.input.error', error: `Could not open ${dir} on the server.` });
					return;
				}
				const lines = r.stdout.split('\n');
				const cwd = (lines.shift() || dir).trim();
				const entries = lines.filter(Boolean).map(n => ({ name: n.replace(/\/$/, ''), isDir: n.endsWith('/') })).filter(e => e.name);
				panel.webview.postMessage({ type: 'aria.input.serverList', key: msg.key, cwd, entries });
			} else if (msg?.type === 'aria.input.cancel') {
				panel.dispose();
			} else if (msg?.type === 'aria.input.save') {
				await handleSave(panel, profile, isBuiltIn, imageName, configPath, originalYaml, fields, msg);
			}
		} catch (err) {
			panel.webview.postMessage({ type: 'aria.input.error', error: (err as Error).message });
		}
	});
}

async function handleSave(
	panel: vscode.WebviewPanel,
	profile: SshProfile,
	isBuiltIn: boolean,
	imageName: string,
	configPath: string,
	originalYaml: string,
	fields: ConfigField[],
	msg: { runName?: string; cores?: number; values?: Record<string, string> },
): Promise<void> {
	const { ssh } = services();
	const runName = String(msg.runName ?? '').trim();
	if (!runName) { panel.webview.postMessage({ type: 'aria.input.error', error: 'Please enter a run name.' }); return; }
	const cores = Number.isInteger(msg.cores) && Number(msg.cores) > 0 ? Number(msg.cores) : 4;
	const values = msg.values ?? {};

	// NOTE: `required` is only a visual hint (a red *), never a hard block. Pipelines
	// are often staged - e.g. a "run_meme: false" flag makes the meme-only fields
	// irrelevant - and the flat config comment cannot express that dependency, so
	// blocking on a blank "required" field would wedge those pipelines. The pipeline
	// (snakemake) validates what it actually needs at run time.

	const inputDir = `${workspacePathsFor(profile).input_dir.replace(/\/+$/, '')}/${runName}`;
	await ssh.run(profile, `mkdir -p '${shellEscape(inputDir)}'`);

	let yaml = originalYaml;
	for (const f of fields) {
		const raw = String(values[f.key] ?? f.value).trim();
		// Only rewrite fields the user actually CHANGED. Leaving untouched keys alone
		// keeps the original line verbatim - important for a key that heads a nested
		// mapping (e.g. `groups:` with indented children), which parses as an empty
		// scalar here and would otherwise be clobbered into `groups: ""`, orphaning
		// the block below it.
		if (raw === String(f.value).trim()) { continue; }
		// A file field with a NEW source path (not already the container /input/ form)
		// is staged: symlink it into the run's input dir, then point the config at the
		// container path. Everything else is written back with its detected type.
		if (f.isFile && raw !== '' && !raw.startsWith('/input/')) {
			let src = raw;
			if (isBuiltIn) {
				const mapped = localToRunEnvPath(src);
				if ('error' in mapped) { panel.webview.postMessage({ type: 'aria.input.error', error: `${f.key}: ${mapped.error}` }); return; }
				src = mapped.path;
			}
			const base = (src.split('/').pop() || 'input').replace(/\\/g, '');
			const target = `${inputDir}/${base}`;
			const ln = await ssh.run(profile, `ln -sf '${shellEscape(src)}' '${shellEscape(target)}'`);
			if (ln.exitCode !== 0) {
				panel.webview.postMessage({ type: 'aria.input.error', error: `Could not stage "${f.key}": ${ln.stderr.trim() || 'symlink failed'}` });
				return;
			}
			yaml = setYamlValue(yaml, f.key, formatValue(`/input/${base}`, 'string'));
		} else {
			yaml = setYamlValue(yaml, f.key, formatValue(raw, f.type));
		}
	}

	await ssh.writeFile(profile, configPath, yaml);

	try {
		await launchPipeline(profile, { imageName, runName, inputDir, cores });
	} catch (e) {
		panel.webview.postMessage({ type: 'aria.input.error', error: `The run could not start: ${(e as Error).message}` });
		return;
	}
	panel.dispose();
}

function escapeHtml(s: string): string {
	return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderHtml(webview: vscode.Webview, pipelineName: string, fields: ConfigField[], isBuiltIn: boolean, availCores: number): string {
	const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ${webview.cspSource}; img-src ${webview.cspSource} data:`;
	const defaultRun = `${pipelineName}-run`;
	const serverHint = !isBuiltIn;

	const rows = fields.map(f => {
		const label = `<span class="fkey">${escapeHtml(f.key)}</span>${f.required ? '<span class="req">*</span>' : ''}`;
		const desc = f.description ? `<div class="fdesc">${escapeHtml(f.description)}</div>` : '';
		let control: string;
		if (f.isFile) {
			const btn = isBuiltIn
				? `<button type="button" class="btn btn-secondary pick" data-pick="${escapeHtml(f.key)}">Choose file…</button>`
				: `<button type="button" class="btn btn-secondary browse" data-browse="${escapeHtml(f.key)}">Browse server…</button>`;
			const ph = serverHint ? 'path on the SSH server' : 'file path';
			control = `<div class="filerow"><input type="text" data-key="${escapeHtml(f.key)}" data-type="string" data-file="1" value="${escapeHtml(f.value)}" placeholder="${ph}">${btn}</div>`;
		} else if (f.type === 'bool') {
			const t = f.value === 'true';
			control = `<select data-key="${escapeHtml(f.key)}" data-type="bool"><option value="true"${t ? ' selected' : ''}>true</option><option value="false"${!t ? ' selected' : ''}>false</option></select>`;
		} else if (f.type === 'int' || f.type === 'float') {
			const step = f.type === 'float' ? ' step="any"' : '';
			control = `<input type="number"${step} data-key="${escapeHtml(f.key)}" data-type="${f.type}" value="${escapeHtml(f.value)}">`;
		} else {
			control = `<input type="text" data-key="${escapeHtml(f.key)}" data-type="string" value="${escapeHtml(f.value)}">`;
		}
		return `<div class="field"><label>${label}</label>${desc}${control}</div>`;
	}).join('');

	const noFields = fields.length ? '' : '<div class="empty">This pipeline\'s config.yaml has no editable top-level values. You can still name the run and start it.</div>';

	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>autopipe input</title>
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; }
		.header { padding: 18px 22px; border-bottom: 1px solid var(--vscode-widget-border, transparent); flex-shrink: 0; }
		.header h1 { font-size: 17px; font-weight: 700; margin: 0 0 4px; }
		.header .sub { font-size: 12px; opacity: 0.8; }
		.scroll { flex: 1; overflow-y: auto; padding: 16px 22px; }
		.runbar { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 18px; padding-bottom: 16px; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
		.runbar .field { margin: 0; }
		.field { margin-bottom: 16px; max-width: 640px; }
		label { display: block; font-size: 12px; margin-bottom: 4px; }
		.fkey { font-weight: 600; }
		.req { color: var(--vscode-inputValidation-errorForeground, #e55); margin-left: 3px; }
		.fdesc, .fhint { font-size: 11px; opacity: 0.7; max-width: 620px; }
		.fdesc { margin-bottom: 6px; }
		.fhint { margin-top: 4px; }
		input[type=text], input[type=number], select { width: 100%; max-width: 620px; box-sizing: border-box; padding: 5px 8px; font-size: 12px; font-family: var(--vscode-font-family); color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); border-radius: 3px; }
		.runbar input { width: 220px; }
		.filerow { display: flex; gap: 8px; align-items: center; }
		.filerow input { flex: 1; }
		.btn { padding: 5px 12px; font-size: 12px; cursor: pointer; border-radius: 3px; border: none; white-space: nowrap; }
		.btn-primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
		.btn-primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
		.btn-secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-widget-border, currentColor); }
		.footer { flex-shrink: 0; padding: 14px 22px; border-top: 1px solid var(--vscode-widget-border, transparent); display: flex; gap: 10px; align-items: center; }
		.empty { opacity: 0.7; font-size: 12px; margin-bottom: 16px; }
		.err { display: none; margin: 0 22px 12px; padding: 10px 12px; background: var(--vscode-inputValidation-errorBackground, #fee); color: var(--vscode-inputValidation-errorForeground, #c44); border: 1px solid var(--vscode-inputValidation-errorBorder, #c44); border-radius: 3px; font-size: 12px; }
		.busy { opacity: 0.6; pointer-events: none; }
		.modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.45); align-items: center; justify-content: center; }
		.modal.open { display: flex; }
		.modal-box { width: 560px; max-width: 90vw; max-height: 76vh; display: flex; flex-direction: column; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-widget-border, currentColor); border-radius: 6px; overflow: hidden; }
		.modal-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
		.modal-head .cwd { flex: 1; font-size: 12px; font-family: var(--vscode-editor-font-family); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }
		.modal-list { overflow-y: auto; padding: 6px 0; }
		.mrow { padding: 5px 14px; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.mrow:hover { background: var(--vscode-list-hoverBackground); }
		.micon { width: 14px; text-align: center; opacity: 0.8; }
	</style>
</head>
<body>
	<div class="header">
		<h1>autopipe input: ${escapeHtml(pipelineName)}</h1>
		<div class="sub">Set the pipeline's parameters and pick input data, then Save and run. ${serverHint ? 'This run uses an SSH server, so input files must already exist on that server.' : 'Files you pick are read from your computer through the local run environment.'}</div>
	</div>
	<div class="err" id="err"></div>
	<div class="scroll">
		<div class="runbar">
			<div class="field">
				<label><span class="fkey">Run name</span></label>
				<input type="text" id="runName" value="${escapeHtml(defaultRun)}">
				<div class="fhint">Names this run's output folder (results/&lt;name&gt;/), its log file and container.</div>
			</div>
			<div class="field">
				<label><span class="fkey">Cores</span></label>
				<input type="number" id="cores" value="${availCores}" min="1" max="${availCores}">
				<div class="fhint">Available on the run target: ${availCores}.</div>
			</div>
		</div>
		${noFields}
		${rows}
	</div>
	<div class="footer">
		<button type="button" class="btn btn-primary" id="save">Save and run</button>
		<button type="button" class="btn btn-secondary" id="cancel">Cancel</button>
	</div>

	<div class="modal" id="modal">
		<div class="modal-box">
			<div class="modal-head">
				<span class="cwd" id="modal-cwd"></span>
				<button type="button" class="btn btn-secondary" id="modal-close">Close</button>
			</div>
			<div class="modal-list" id="modal-list"></div>
		</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		const $ = (id) => document.getElementById(id);
		const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		const sel = (key) => document.querySelector('[data-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
		function showErr(m) { const e = $('err'); e.textContent = m; e.style.display = 'block'; }
		function clearErr() { $('err').style.display = 'none'; }

		document.querySelectorAll('[data-pick]').forEach(b => {
			b.onclick = () => vscode.postMessage({ type: 'aria.input.pickLocal', key: b.getAttribute('data-pick') });
		});

		// Server-side file browser (SSH runs). Remembers which field it is picking for.
		let browseKey = null, browseCwd = '';
		document.querySelectorAll('[data-browse]').forEach(b => {
			b.onclick = () => {
				browseKey = b.getAttribute('data-browse');
				const cur = sel(browseKey);
				const start = cur && cur.value.trim() ? cur.value.trim().replace(/\\/[^\\/]*$/, '') : '';
				vscode.postMessage({ type: 'aria.input.browseServer', key: browseKey, dir: start });
			};
		});
		$('modal-close').onclick = () => $('modal').classList.remove('open');

		function renderServerList(cwd, entries) {
			browseCwd = cwd;
			$('modal-cwd').textContent = cwd;
			const parent = cwd.replace(/\\/+$/, '').split('/').slice(0, -1).join('/') || '/';
			let html = '<div class="mrow" data-nav="' + escapeHtml(parent) + '"><span class="micon">📁</span><span>..</span></div>';
			for (const e of entries) {
				if (e.isDir) {
					html += '<div class="mrow" data-nav="' + escapeHtml(cwd.replace(/\\/$/, '') + '/' + e.name) + '"><span class="micon">📁</span><span>' + escapeHtml(e.name) + '</span></div>';
				} else {
					html += '<div class="mrow" data-file="' + escapeHtml(e.name) + '"><span class="micon">📄</span><span>' + escapeHtml(e.name) + '</span></div>';
				}
			}
			$('modal-list').innerHTML = html;
			$('modal-list').querySelectorAll('[data-nav]').forEach(el => {
				el.onclick = () => vscode.postMessage({ type: 'aria.input.browseServer', key: browseKey, dir: el.getAttribute('data-nav') });
			});
			$('modal-list').querySelectorAll('[data-file]').forEach(el => {
				el.onclick = () => {
					const full = browseCwd.replace(/\\/$/, '') + '/' + el.getAttribute('data-file');
					const inp = sel(browseKey);
					if (inp) inp.value = full;
					$('modal').classList.remove('open');
				};
			});
			$('modal').classList.add('open');
		}

		$('cancel').onclick = () => vscode.postMessage({ type: 'aria.input.cancel' });
		$('save').onclick = () => {
			clearErr();
			const values = {};
			document.querySelectorAll('[data-key]').forEach(el => { values[el.getAttribute('data-key')] = el.value; });
			const runName = $('runName').value.trim();
			if (!runName) { showErr('Please enter a run name.'); return; }
			const cores = parseInt($('cores').value, 10) || 4;
			document.body.classList.add('busy');
			$('save').textContent = 'Starting…';
			vscode.postMessage({ type: 'aria.input.save', runName, cores, values });
		};

		window.addEventListener('message', (e) => {
			const msg = e.data;
			if (msg.type === 'aria.input.picked') {
				const el = sel(msg.key);
				if (el) el.value = msg.path;
			} else if (msg.type === 'aria.input.serverList') {
				renderServerList(msg.cwd, msg.entries || []);
			} else if (msg.type === 'aria.input.error') {
				document.body.classList.remove('busy');
				$('save').textContent = 'Save and run';
				showErr(msg.error);
			}
		});
	</script>
</body>
</html>`;
}
