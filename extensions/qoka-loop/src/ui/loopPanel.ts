/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Qoka Loops tab (loop_engine_design.md section on the Loop panel + detail tab). A single
// DISPLAY-ONLY webview: a master list of this project's loops on the left, and the selected
// loop's live detail on the right (status, iteration history, flow, budget, the sha256-locked
// evaluator, and a file tree of its .qoka/loops/<id>/ artifacts). There are deliberately NO
// approval/start buttons here - all loop control happens in the chat (decision B); the tab is
// just a live window onto the loops the engine persists. It refreshes automatically whenever a
// loop's JSON changes on disk, so a running loop's iterations appear as they happen.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LoopRun } from '../schema';
import { listLoops, loopsDir, readLoop } from '../state';

/** URI scheme for read-only loop-artifact documents (registered in extension.ts). Opening loop
 *  files through this scheme keeps the hidden .qoka path out of the Analysis explorer. */
export const LOOP_FILE_SCHEME = 'qoka-loop-file';

let panel: vscode.WebviewPanel | undefined;
let watcher: vscode.FileSystemWatcher | undefined;
let focusId: string | undefined;
/** One-shot: set when the tab is opened for a specific loop, to force that loop selected. */
let forceSelectId: string | undefined;

/** A file inside a loop's .qoka/loops/<id>/ artifact folder, shown in the code tree. */
interface LoopFile { rel: string; abs: string; }

/** One loop, flattened for the webview (spec + run state + its on-disk artifact files). */
interface LoopView {
	id: string;
	title: string;
	goal: string;
	status: string;
	iteration: number;
	budget: { maxIter: number; maxMin: number; startedAt?: string };
	createdAt: string;
	updatedAt: string;
	reason?: string;
	flow: LoopRun['spec']['flow'];
	evaluator: LoopRun['spec']['evaluator'];
	lockedHash?: string;
	history: LoopRun['history'];
	provider?: string;
	files: LoopFile[];
}

/** Recursively list the files under a loop's artifact folder (evaluator, mcp-config, ...). */
function loopFiles(id: string): LoopFile[] {
	const dir = loopsDir();
	if (!dir) { return []; }
	const root = path.join(dir, id);
	const out: LoopFile[] = [];
	// Internal plumbing the user does not need to see in the Files list.
	const hidden = (name: string): boolean => name === 'mcp-config.json' || name.endsWith('.tmp') || name.startsWith('.');
	const walk = (abs: string, rel: string): void => {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (hidden(e.name)) { continue; }
			const childAbs = path.join(abs, e.name);
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) { walk(childAbs, childRel); }
			else { out.push({ rel: childRel, abs: childAbs }); }
		}
	};
	walk(root, '');
	return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function toView(run: LoopRun): LoopView {
	return {
		id: run.id,
		title: run.spec.title,
		goal: run.spec.goal,
		status: run.status,
		iteration: run.iteration,
		budget: run.budget,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		reason: run.reason,
		flow: run.spec.flow,
		evaluator: run.spec.evaluator,
		lockedHash: run.lockedEvaluatorRef?.hash ?? run.spec.evaluator.hash,
		history: run.history,
		provider: run.provider,
		files: loopFiles(run.id),
	};
}

function postData(): void {
	if (!panel) { return; }
	const loops = listLoops().map(toView);
	// Keep focus on the last-requested loop if it still exists, else the newest.
	const selectedId = (focusId && loops.some(l => l.id === focusId)) ? focusId : (loops[0]?.id);
	// `select` (one-shot) FORCES the client to switch selection - used when the tab is opened for a
	// specific loop (from the finish notification / save_loop / start_loop), so its detail shows even
	// if another loop was already selected. Cleared after sending so a live refresh doesn't hijack.
	const select = (forceSelectId && loops.some(l => l.id === forceSelectId)) ? forceSelectId : undefined;
	forceSelectId = undefined;
	panel.webview.postMessage({ type: 'data', loops, selectedId, select });
}

/**
 * Open (or reveal) the Qoka Loops tab, optionally focused on a specific loop. Called from the
 * command, and from the chat tools right after a loop is saved or started so the user sees it.
 */
export function openLoopPanel(context: vscode.ExtensionContext, loopId?: string): void {
	if (loopId) { focusId = loopId; forceSelectId = loopId; }
	// Title the editor tab after the focused loop (the sidebar list opens this per loop).
	const title = (loopId ? readLoop(loopId)?.spec.title : undefined) || 'Loop';
	if (panel) {
		panel.title = title;
		panel.reveal(vscode.ViewColumn.Active);
		postData();
		return;
	}
	panel = vscode.window.createWebviewPanel(
		'qoka.loop.panel',
		title,
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	panel.webview.html = renderHtml(panel.webview);

	panel.webview.onDidReceiveMessage(async (msg: { type?: string; path?: string; id?: string; text?: string }) => {
		if (msg?.type === 'ready') {
			postData();
		} else if (msg?.type === 'select' && msg.id) {
			focusId = msg.id;
		} else if (msg?.type === 'openFile' && msg.path) {
			try {
				// Open a read-only virtual doc (scheme LOOP_FILE_SCHEME) whose query is the real path,
				// whose visible path keeps the filename (for language detection). Using this scheme
				// instead of a file: URI stops the Analysis explorer from revealing the hidden .qoka path.
				const name = msg.path.split(/[\\/]/).pop() || 'file';
				const uri = vscode.Uri.from({ scheme: LOOP_FILE_SCHEME, path: `/${name}`, query: msg.path });
				const doc = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
			} catch (e) {
				void vscode.window.showErrorMessage(`Cannot open file: ${(e as Error).message}`);
			}
		} else if (msg?.type === 'copy' && typeof msg.text === 'string') {
			await vscode.env.clipboard.writeText(msg.text);
			void vscode.window.showInformationMessage('Copied the example prompt to the clipboard.');
		}
	}, undefined, context.subscriptions);

	// Live refresh: re-post whenever any loop JSON under .qoka/loops changes.
	const dir = loopsDir();
	if (dir && !watcher) {
		watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '*.json'));
		const refresh = () => postData();
		watcher.onDidChange(refresh);
		watcher.onDidCreate(refresh);
		watcher.onDidDelete(refresh);
		context.subscriptions.push(watcher);
	}

	panel.onDidDispose(() => {
		panel = undefined;
		watcher?.dispose();
		watcher = undefined;
	});
}

function renderHtml(webview: vscode.Webview): string {
	const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'; img-src ${webview.cspSource} data:`;
	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>Qoka Loops</title>
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; height: 100vh; display: flex; }
		.list { width: 260px; flex-shrink: 0; border-right: 1px solid var(--vscode-widget-border, transparent); overflow-y: auto; background: var(--vscode-editorWidget-background); }
		.list-head { padding: 14px 16px 8px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.6; }
		.loop-item { padding: 10px 16px; cursor: pointer; border-left: 2px solid transparent; }
		.loop-item:hover { background: var(--vscode-list-hoverBackground); }
		.loop-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-left-color: var(--vscode-focusBorder); }
		.loop-item .lt { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.loop-item .lm { font-size: 11px; opacity: 0.8; margin-top: 3px; display: flex; align-items: center; gap: 6px; }
		.badge { font-size: 10px; padding: 1px 7px; border-radius: 9px; font-weight: 600; }
		.b-running { background: #2d6cdf22; color: #4c8dff; border: 1px solid #4c8dff66; }
		.b-success { background: #1e8e3e22; color: #4caf72; border: 1px solid #4caf7266; }
		.b-failed { background: #c5303022; color: #e06666; border: 1px solid #e0666666; }
		.b-paused { background: #b8860022; color: #e0b050; border: 1px solid #e0b05066; }
		.b-pending { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
		.b-stopped { background: #6b6b6b22; color: #9a9a9a; border: 1px solid #9a9a9a55; }

		/* Draggable divider between the loop list and the detail pane. */
		.gutter { flex: 0 0 6px; cursor: ew-resize; position: relative; }
		.gutter::after { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: var(--vscode-widget-border, transparent); opacity: 0.6; }
		.gutter:hover::after { opacity: 1; }
		.detail { flex: 1; min-width: 0; overflow-y: auto; padding: 22px 26px; box-sizing: border-box; }
		/* Flow diagram */
		.flow-diagram { width: 100%; max-width: 400px; height: auto; margin-bottom: 12px; }
		.flow-diagram .node-box { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-widget-border, currentColor); }
		.flow-diagram .node-eval { stroke: var(--vscode-focusBorder); }
		.flow-diagram text { fill: var(--vscode-foreground); font-family: var(--vscode-font-family); }
		.flow-diagram .edge { stroke: var(--vscode-foreground); opacity: 0.55; }
		.flow-diagram .edge-pass { stroke: #4caf72; opacity: 0.9; }
		.flow-diagram .edge-fail { stroke: #e06666; opacity: 0.9; }
		.flow-diagram .lbl-pass { fill: #4caf72; }
		.flow-diagram .lbl-fail { fill: #e06666; }
		.lock-line { font-size: 12px; opacity: 0.8; display: flex; align-items: center; gap: 8px; }
		.lock-line .lk { color: #e0b050; }
		.lock-line .hashmini { opacity: 0.6; font-family: var(--vscode-editor-font-family); font-size: 11px; word-break: break-all; }
		.detail h1 { font-size: 19px; margin: 0 0 4px; }
		.goal { font-size: 13px; opacity: 0.9; margin-bottom: 14px; }
		.meta { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; margin-bottom: 20px; }
		.meta div strong { opacity: 0.6; margin-right: 5px; font-weight: 500; }
		.reason { font-size: 12px; padding: 8px 12px; border-radius: 4px; margin-bottom: 18px; background: var(--vscode-inputValidation-warningBackground, #4a3c00); border: 1px solid var(--vscode-inputValidation-warningBorder, #b8860055); }
		.section { margin-bottom: 22px; }
		.section > h2 { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.6; margin: 0 0 8px; }
		.steps { margin: 0; padding-left: 18px; font-size: 13px; }
		.steps li { margin-bottom: 3px; }
		.checks { display: flex; flex-direction: column; gap: 7px; }
		.check { font-size: 12px; border-left: 2px solid var(--vscode-focusBorder); padding-left: 10px; }
		.check .cw { opacity: 0.7; margin-top: 2px; }
		.flowline { font-size: 12px; opacity: 0.9; margin-bottom: 4px; }
		.flowline strong { opacity: 0.6; margin-right: 5px; font-weight: 500; }
		pre.code { margin: 0; padding: 12px 14px; background: var(--vscode-textCodeBlock-background, #00000022); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 5px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre; tab-size: 4; }
		.hash { font-size: 11px; opacity: 0.6; margin-top: 6px; font-family: var(--vscode-editor-font-family); word-break: break-all; }
		table.hist { border-collapse: collapse; width: 100%; font-size: 12px; }
		table.hist th, table.hist td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border, transparent); vertical-align: top; }
		table.hist th { opacity: 0.6; font-weight: 500; }
		.v-pass { color: #4caf72; font-weight: 600; }
		.v-fail { color: #e06666; font-weight: 600; }
		.files { display: flex; flex-direction: column; gap: 1px; }
		.file { font-size: 12px; padding: 4px 8px; cursor: pointer; border-radius: 3px; display: flex; align-items: center; gap: 7px; font-family: var(--vscode-editor-font-family); }
		.file:hover { background: var(--vscode-list-hoverBackground); }
		.file .fi { opacity: 0.7; }
		.prompt-box { font-size: 12px; background: var(--vscode-textBlockQuote-background, #00000018); border-left: 3px solid var(--vscode-focusBorder); padding: 10px 12px; border-radius: 0 4px 4px 0; }
		.prompt-box .pe { font-style: italic; opacity: 0.85; margin: 6px 0; }
		.copy { font-size: 11px; padding: 3px 10px; cursor: pointer; border: 1px solid var(--vscode-widget-border, currentColor); background: transparent; color: var(--vscode-foreground); border-radius: 3px; }
		.copy:hover { background: var(--vscode-list-hoverBackground); }
		.empty { opacity: 0.6; padding: 40px; text-align: center; font-size: 13px; }
	</style>
</head>
<body>
	<div class="detail" id="detail"><div class="empty">Loading loop...</div></div>
	<script>
		const vscode = acquireVsCodeApi();
		const $ = (id) => document.getElementById(id);
		const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		// Timestamps are stored as UTC ISO strings; show them in the VIEWER'S local timezone
		// (toLocaleString uses the browser/system locale + zone) so everyone sees their own clock.
		const fmtTime = (iso) => { try { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleString(); } catch (e) { return ''; } };
		let loops = [];
		let selectedId = null;

		const badgeClass = (s) => ({ running:'b-running', success:'b-success', failed:'b-failed', paused:'b-paused', stopped:'b-stopped', 'pending-approval':'b-pending' }[s] || 'b-pending');
		const statusLabel = (s) => s === 'pending-approval' ? 'pending' : s;
		// While running, show which iteration is in flight (the engine works iteration-by-iteration;
		// it cannot see individual steps inside a sub-agent turn, so the iteration is the live unit).
		const statusText = (l) => l.status === 'running' ? ('running \\u00b7 iter ' + (l.iteration + 1)) : statusLabel(l.status);

		// Build an inline SVG of THIS loop's actual cycle: (Input ->) each real step -> Evaluator
		// (labelled with its first check) -> Output/Done on pass, with a red "fail -> retry" arrow
		// from the Evaluator back up to the first step. Vertical so any number of steps fits; each
		// node shows the loop's own text (truncated, full text on hover) so the diagram is specific
		// to this loop, not a generic template.
		// Width-aware truncation: CJK/full-width glyphs count as 2 (they render ~2x wider than Latin),
		// so a Korean label is cut at the right visual length to fit a node box. A clipPath in the SVG
		// is the safety net that hard-clips anything still over.
		function charW(ch) {
			const c = ch.charCodeAt(0);
			return (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
				|| (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6))) ? 2 : 1;
		}
		function trunc(s, units) {
			s = String(s || '');
			let w = 0, out = '';
			for (const ch of s) { const cw = charW(ch); if (w + cw > units) { return out + '\\u2026'; } w += cw; out += ch; }
			return out;
		}
		// Tidy a raw flow label for the DIAGRAM (hover title keeps the original): only collapse
		// whitespace. We do NOT strip parentheses - many steps put the real content inside them.
		function refine(s) {
			return String(s || '').replace(/\s+/g, ' ').trim();
		}
		function flowDiagram(l) {
			const f = l.flow || {};
			const steps = (f.steps || []);
			const nodes = [];
			if (f.input) { nodes.push({ kind: 'io', label: trunc(refine(f.input), 42), title: f.input }); }
			const firstStepIdx = nodes.length;
			steps.forEach((st, i) => nodes.push({ kind: 'step', label: (i + 1) + '. ' + trunc(refine(st), 40), title: st }));
			if (steps.length === 0) { nodes.push({ kind: 'step', label: 'do the work', title: 'the loop body' }); }
			const evalIdx = nodes.length;
			const check0 = (f.checks && f.checks[0] && f.checks[0].c) ? f.checks[0].c : (l.evaluator && l.evaluator.language ? l.evaluator.language + ' check' : 'pass/fail test');
			nodes.push({ kind: 'eval', label: 'Evaluator: ' + trunc(refine(check0), 32), title: check0 });
			nodes.push({ kind: 'io', label: f.output ? trunc(refine(f.output), 42) : 'Done', title: f.output || 'goal met' });

			const W = 300, H = 40, VGAP = 24, X0 = 10, Y0 = 12, RM = 66;
			const width = X0 + W + RM;
			const height = Y0 + nodes.length * H + (nodes.length - 1) * VGAP + 6;
			const ny = (i) => Y0 + i * (H + VGAP);
			let s = '<svg class="flow-diagram" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Loop flow for this loop: its steps, then the evaluator; pass goes to output, fail loops back to the first step">';
			s += '<defs>'
				+ '<marker id="ah" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#888"/></marker>'
				+ '<marker id="ahp" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#4caf72"/></marker>'
				+ '<marker id="ahf" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#e06666"/></marker>'
				+ '</defs>';
			// vertical edges between consecutive nodes
			for (let i = 0; i < nodes.length - 1; i++) {
				const x = X0 + W / 2, y1 = ny(i) + H, y2 = ny(i + 1);
				const isPass = (i === evalIdx); // evaluator -> output
				s += '<line class="' + (isPass ? 'edge-pass' : 'edge') + '" x1="' + x + '" y1="' + y1 + '" x2="' + x + '" y2="' + (y2 - 2) + '" marker-end="url(#' + (isPass ? 'ahp' : 'ah') + ')" stroke-width="1.6"/>';
				if (isPass) { s += '<text class="lbl-pass" x="' + (x + 8) + '" y="' + ((y1 + y2) / 2 + 3) + '" font-size="10">pass</text>'; }
			}
			// feedback: evaluator right side -> curve out right -> back to first step right side
			const rx = X0 + W;
			const ey = ny(evalIdx) + H / 2;
			const sy = ny(firstStepIdx) + H / 2;
			const ox = rx + RM - 12;
			s += '<path class="edge-fail" d="M' + rx + ',' + ey + ' C' + ox + ',' + ey + ' ' + ox + ',' + sy + ' ' + rx + ',' + sy + '" fill="none" marker-end="url(#ahf)" stroke-width="1.6"/>';
			s += '<text class="lbl-fail" x="' + (ox + 4) + '" y="' + ((ey + sy) / 2) + '" text-anchor="middle" font-size="10" transform="rotate(90 ' + (ox + 4) + ' ' + ((ey + sy) / 2) + ')">fail &#8594; retry</text>';
			// nodes
			nodes.forEach((nd, i) => {
				const y = ny(i);
				// clipPath hard-clips any label that still overruns the box (belt-and-suspenders with trunc).
				s += '<g><title>' + esc(nd.title || '') + '</title>'
					+ '<clipPath id="clip' + i + '"><rect x="' + (X0 + 6) + '" y="' + y + '" width="' + (W - 12) + '" height="' + H + '"/></clipPath>'
					+ '<rect class="node-box' + (nd.kind === 'eval' ? ' node-eval' : '') + '" x="' + X0 + '" y="' + y + '" width="' + W + '" height="' + H + '" rx="7" stroke-width="1.4"/>'
					+ '<text clip-path="url(#clip' + i + ')" x="' + (X0 + 12) + '" y="' + (y + H / 2 + 4) + '" font-size="12"' + (nd.kind === 'step' ? ' font-weight="600"' : '') + '>' + esc(nd.label) + '</text>'
					+ '</g>';
			});
			s += '</svg>';
			return s;
		}

		function renderDetail() {
			const l = loops.find(x => x.id === selectedId);
			if (!l) { $('detail').innerHTML = '<div class="empty">Select a loop.</div>'; return; }
			const f = l.flow || {};
			const running = l.status === 'running' || l.status === 'pending-approval';
			const totalMs = (l.history || []).reduce((a, h) => a + (typeof h.durationMs === 'number' ? h.durationMs : 0), 0);
			const fmtDurTop = (ms) => ms < 1000 ? ms + 'ms' : (ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's');
			const checks = (f.checks || []).map(c => '<div class="check"><div>' + esc(c.c) + '</div><div class="cw">' + esc(c.why) + '</div></div>').join('');
			const steps = (f.steps || []).map(s => '<li>' + esc(s) + '</li>').join('');
			const fmtDur = (ms) => (typeof ms !== 'number') ? '' : (ms < 1000 ? ms + 'ms' : (ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's'));
			const hist = (l.history || []).map(h => '<tr><td>' + h.iteration + '</td><td class="' + (h.verdict === 'pass' ? 'v-pass' : 'v-fail') + '">' + esc(h.verdict || '') + '</td><td>' + fmtDur(h.durationMs) + '</td><td>' + esc(h.detail || '') + '</td><td>' + fmtTime(h.at) + '</td></tr>').join('');
			const files = (l.files || []).map(fl => '<div class="file" data-path="' + esc(fl.abs) + '"><span class="fi">&#128196;</span>' + esc(fl.rel) + '</div>').join('') || '<div class="empty" style="padding:12px;text-align:left">No artifact files yet.</div>';
			const examplePrompt = 'Explain the result of the loop "' + l.title + '" (id ' + l.id + '). Use loop_status to read its status and verdict history.';

			let h = '<h1>' + esc(l.title) + '</h1><div class="goal">' + esc(l.goal) + '</div>';
			h += '<div class="meta">'
				+ '<div><strong>Status</strong><span class="badge ' + badgeClass(l.status) + '">' + esc(statusText(l)) + '</span></div>'
				+ '<div><strong>Iteration</strong>' + l.iteration + ' / ' + l.budget.maxIter + '</div>'
				+ '<div><strong>Budget</strong>' + l.budget.maxIter + ' iters, ' + l.budget.maxMin + ' min</div>'
				// While the loop is still running (or awaiting approval), the totals are partial and keep
				// changing, so show "-"; the finalized Tokens / Total time appear once the loop ends.
				+ '<div><strong>Tokens</strong>' + (running ? '-' : ((l.budget.usedTokens && l.budget.usedTokens > 0) ? l.budget.usedTokens.toLocaleString() : '0')) + '</div>'
				+ '<div><strong>Total time</strong>' + (running ? '-' : (totalMs > 0 ? fmtDurTop(totalMs) : '0s')) + '</div>'
				+ (l.provider ? '<div><strong>Provider</strong>' + esc(l.provider) + '</div>' : '')
				+ '<div><strong>Updated</strong>' + fmtTime(l.updatedAt) + '</div>'
				+ '</div>';
			if (l.reason) { h += '<div class="reason">' + esc(l.reason) + '</div>'; }

			// Input / Output are shown as nodes in the diagram (with full text on hover), so we do not
			// repeat them as text lines here - that was the cluttered part. Keep the readable step list.
			h += '<div class="section"><h2>Flow</h2>';
			h += flowDiagram(l);
			h += '<ol class="steps">' + steps + '</ol>';
			h += '</div>';

			if (checks) { h += '<div class="section"><h2>Checks</h2><div class="checks">' + checks + '</div></div>'; }

			// The loop stops on the FIRST of these. Derived from the authoritative budget + the engine's
			// fixed rules (not the free-form flow.stops), so it always matches what the engine actually does.
			// The success condition = THIS loop's actual evaluator checks (not a generic "passes").
			const passCond = (f.checks && f.checks.length) ? f.checks.map(c => c.c).filter(Boolean).join('; ') : (l.goal || 'the goal is met');
			const stopItems = [
				'Evaluator passes &#8594; success: ' + esc(passCond),
				l.budget.maxIter + ' iterations reached &#8594; stop',
				l.budget.maxMin + ' minutes elapsed &#8594; stop',
				'No progress: the same failure 3 times in a row &#8594; stop',
			];
			h += '<div class="section"><h2>Stops when (whichever comes first)</h2><ul class="steps">'
				+ stopItems.map(x => '<li>' + x + '</li>').join('') + '</ul></div>';

			if (hist) { h += '<div class="section"><h2>History</h2><table class="hist"><tr><th>#</th><th>verdict</th><th>time</th><th>detail</th><th>at</th></tr>' + hist + '</table></div>'; }

			h += '<div class="section"><h2>Files</h2><div class="files">' + files + '</div></div>';

			h += '<div class="section"><h2>Ask about this loop</h2><div class="prompt-box">'
				+ '<div>Ask in chat, for example:</div><div class="pe">' + esc(examplePrompt) + '</div>'
				+ '<button class="copy" id="copyPrompt">Copy example prompt</button></div></div>';

			$('detail').innerHTML = h;
			document.querySelectorAll('.file').forEach(el => {
				el.onclick = () => vscode.postMessage({ type: 'openFile', path: el.getAttribute('data-path') });
			});
			const cp = $('copyPrompt');
			if (cp) { cp.onclick = () => vscode.postMessage({ type: 'copy', text: examplePrompt }); }
		}

		// This webview shows ONE loop's detail (the loop list lives in the left sidebar view, which
		// opens this editor for the clicked loop). The server pushes the focused loop; we render it.
		window.addEventListener('message', (e) => {
			const msg = e.data;
			if (msg.type === 'data') {
				loops = msg.loops || [];
				if (msg.select && loops.some(l => l.id === msg.select)) { selectedId = msg.select; }
				else if (!selectedId || !loops.some(l => l.id === selectedId)) { selectedId = msg.selectedId || (loops[0] && loops[0].id) || null; }
				renderDetail();
			}
		});
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
}
