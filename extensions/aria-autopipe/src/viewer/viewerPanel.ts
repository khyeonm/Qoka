/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { services } from '../common/services';
import { InstalledPlugin, DataSourceCommands } from '../plugins/pluginService';

/**
 * Location of the bundled PDF.js library files. Resolved off `__dirname`
 * (out/viewer at runtime) so the lookup works whether the extension is
 * loaded from the source tree or a built VSIX. The two files are:
 *
 *   media/pdfjs/pdf.mjs         — main API (window.pdfjsLib)
 *   media/pdfjs/pdf.worker.mjs  — Web Worker that does the parsing
 *
 * We don't bundle them through tsc — they're large ES modules pulled
 * verbatim from Mozilla's release. The webview loads them via
 * `asWebviewUri` so the strict CSP can include the cspSource.
 */
function pdfjsDir(): string {
	return path.join(__dirname, '..', '..', 'media', 'pdfjs');
}

/**
 * Single shared "Autopipe Viewer" tab. Subsequent show_results calls
 * retarget the same panel instead of stacking new tabs.
 *
 * The viewer hosts the AutoPipe plugins the user installed via Hub. Each
 * plugin exposes a `window.AutoPipePlugin.render(container, fileUrl,
 * filename)` API; we satisfy that contract by giving the plugin a blob:
 * URL pointing at the bytes we just streamed over SSH.
 *
 * Navigation is locked to the RUN-NAME directory (the segment just below an
 * autopipe output dir — see detectRunDir): the user can browse freely WITHIN
 * that run, but cannot walk up to sibling runs or above the output directory.
 * (If show_results targets the output dir itself, the ceiling is that output
 * dir so the run list is browsable.)
 */
let activePanel: vscode.WebviewPanel | undefined;
let activeRootDir: string | undefined;

interface DirEntry {
	name: string;
	path: string;
	is_dir: boolean;
}

/**
 * Files the user has opened in this viewer session. Plugins call
 * `fetch("/data/{filename}?page=...")`; the webview routes the call to
 * the extension, which uses this registry to map `filename` back to the
 * remote path on the SSH host. Caches per-file row-count + best
 * data-source candidate so repeat page requests don't re-probe.
 */
interface RegisteredFile {
	remotePath: string;
	plugin: InstalledPlugin;
	totalRows?: number;
	chosenDataSource?: DataSourceCommands;
}
const remoteFiles = new Map<string, RegisteredFile>();

function parentOf(p: string): string {
	if (!p || p === '/') {
		return '/';
	}
	const cleaned = p.replace(/\/+$/, '');
	const idx = cleaned.lastIndexOf('/');
	if (idx <= 0) {
		return '/';
	}
	return cleaned.slice(0, idx);
}

/**
 * Pick the upper bound for viewer navigation. Walks the path looking for
 * the run-name directory just below an autopipe output dir
 * (`pipelines_output`, `outputs`, or `output`) and uses that as the
 * navigation ceiling — so the user can move freely WITHIN the run but
 * can't step over to sibling runs or above the output dir.
 *
 * Examples (run-name segments in CAPS):
 *   /auto_test/outputs/RUN-1/nf/star_salmon/rseqc/bed -> /auto_test/outputs/run-1
 *   /home/x/aria/pipelines_output/RUN-A/sub/foo       -> /home/x/aria/pipelines_output/run-a
 *   /loose/path/file.csv (no output dir in path)      -> /loose/path  (fallback to parent)
 *   /auto_test/outputs (output dir itself, no run)    -> /auto_test/outputs (allow listing)
 */
function detectRunDir(p: string): string {
	const cleaned = (p || '').replace(/\/+$/, '');
	const segs = cleaned.split('/');
	const OUTPUT_DIRS = new Set(['pipelines_output', 'outputs', 'output']);
	for (let i = segs.length - 1; i >= 0; i--) {
		if (OUTPUT_DIRS.has(segs[i])) {
			// Found the output dir at index i. The run-name directory is
			// segs[i+1] — if it exists we lock to it, otherwise the user
			// passed the output dir itself and we fall back to listing
			// the runs at that level.
			if (i + 1 < segs.length) {
				return segs.slice(0, i + 2).join('/');
			}
			return cleaned;
		}
	}
	return parentOf(cleaned);
}

/**
 * Open (or focus) the Autopipe Viewer tab targeted at `initialDir`. The
 * upper-bound for navigation is the parent of `initialDir`: that's the
 * run-name's parent (= the output directory in the autopipe convention).
 */
export async function openViewerForDirectory(initialDir: string, initialFile?: string): Promise<void> {
	// Lock navigation to the run-name directory if the path contains an
	// autopipe output dir — the user can browse INTO subdirectories of
	// the run, but never up to sibling runs or above the output dir.
	const rootDir = detectRunDir(initialDir);
	activeRootDir = rootDir;
	console.log(`[aria-autopipe] openViewerForDirectory: initialDir=${initialDir} rootDir=${rootDir} initialFile=${initialFile ?? '(none)'}`);

	if (activePanel) {
		activePanel.reveal(vscode.ViewColumn.Active);
		activePanel.webview.postMessage({
			type: 'aria.viewer.setDirectory',
			directory: initialDir,
			rootDir,
			initialFile: initialFile ?? null,
		});
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'aria.autopipe.viewer',
		'Autopipe Viewer',
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			// The PDF.js bundle lives under media/pdfjs. Webviews refuse to
			// load resources from anywhere outside `localResourceRoots`, so
			// we explicitly allow that directory here. Plugin install dirs
			// (~/.aria-autopipe-plugins) are intentionally NOT listed —
			// their JS is injected inline so the file paths themselves
			// never appear on the webview side.
			localResourceRoots: [vscode.Uri.file(pdfjsDir())],
		},
	);
	activePanel = panel;
	panel.onDidDispose(() => { activePanel = undefined; activeRootDir = undefined; });

	panel.webview.html = renderShellHtml(panel.webview);

	panel.webview.onDidReceiveMessage(async (msg: { type?: string; directory?: string; filePath?: string }) => {
		try {
			if (msg?.type === 'aria.viewer.ready') {
				panel.webview.postMessage({
					type: 'aria.viewer.setDirectory',
					directory: initialDir,
					rootDir: activeRootDir,
					initialFile: initialFile ?? null,
				});
			} else if (msg?.type === 'aria.viewer.list' && msg.directory) {
				// Guard against navigation attempts above the root dir.
				if (activeRootDir && !isWithinRoot(msg.directory, activeRootDir)) {
					panel.webview.postMessage({ type: 'aria.viewer.error', error: 'Navigation blocked: outside the allowed output directory.' });
					return;
				}
				const entries = await listDirectory(msg.directory);
				panel.webview.postMessage({ type: 'aria.viewer.list.ok', directory: msg.directory, entries });
			} else if (msg?.type === 'aria.viewer.open' && msg.filePath) {
				await openFileInPanel(panel, msg.filePath);
			} else if (msg?.type === 'aria.viewer.fetchData') {
				const m = msg as { type?: string; reqId?: number; url?: string };
				if (typeof m.reqId === 'number' && typeof m.url === 'string') {
					const result = await handleDataFetch(m.url);
					panel.webview.postMessage({ type: 'aria.viewer.fetchData.response', reqId: m.reqId, data: result });
				}
			}
		} catch (err) {
			console.error('[aria-autopipe] viewer message handling failed', err);
			panel.webview.postMessage({ type: 'aria.viewer.error', error: (err as Error).message });
		}
	});
}

/** Convenience: file-input variant. Opens the viewer on the file's parent
 *  directory and pre-selects the file. Used by show_results when the AI
 *  passes a single file path instead of a run directory. */
export async function openViewerForFile(filePath: string, plugin: InstalledPlugin): Promise<void> {
	void plugin; // selection-by-extension happens inside the panel
	const parent = parentOf(filePath);
	await openViewerForDirectory(parent, filePath);
}

function isWithinRoot(targetPath: string, rootDir: string): boolean {
	if (targetPath === rootDir) {
		return true;
	}
	const normalised = targetPath.replace(/\/+$/, '');
	const rootNormalised = rootDir.replace(/\/+$/, '');
	return normalised === rootNormalised || normalised.startsWith(rootNormalised + '/');
}

async function listDirectory(dirPath: string): Promise<DirEntry[]> {
	const profile = services().config.activeProfile();
	if (!profile) {
		throw new Error('No active SSH profile.');
	}
	// `-1p` lists one per line and appends `/` to directories so we can
	// classify each entry in a single round trip. No `-A` so dotfiles stay
	// hidden — autopipe writes its bookkeeping into `.autopipe-run.json`
	// and the user shouldn't have to scroll past those.
	const cmd = `ls -1p -- ${shellQuote(dirPath)}`;
	const { stdout, exitCode, stderr } = await services().ssh.run(profile, cmd);
	if (exitCode !== 0) {
		throw new Error(`ls ${dirPath} failed: ${stderr.trim() || stdout.trim()}`);
	}
	const out: DirEntry[] = [];
	for (const rawLine of stdout.split('\n')) {
		const line = rawLine.trimEnd();
		if (!line) {
			continue;
		}
		const isDir = line.endsWith('/');
		const name = isDir ? line.slice(0, -1) : line;
		if (name.startsWith('.')) {
			// belt-and-braces dotfile filter — `ls` already hides them,
			// but if the user later flips on `-A` for debugging this
			// guard keeps the UI consistent.
			continue;
		}
		out.push({ name, path: joinRemote(dirPath, name), is_dir: isDir });
	}
	out.sort((a, b) => {
		if (a.is_dir !== b.is_dir) {
			return a.is_dir ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});
	return out;
}

async function openFileInPanel(panel: vscode.WebviewPanel, filePath: string): Promise<void> {
	const { plugins, ssh, config } = services();
	const profile = config.activeProfile();
	if (!profile) {
		panel.webview.postMessage({ type: 'aria.viewer.fileError', filePath, error: 'No active SSH profile.' });
		return;
	}
	const ext = path.extname(filePath);
	const plugin = ext ? plugins.findForExtension(ext) : null;
	if (!plugin) {
		panel.webview.postMessage({
			type: 'aria.viewer.fileError',
			filePath,
			error: `No installed plugin handles "${ext || filePath}". Install one from the Plugins tab.`,
		});
		return;
	}

	// Register the file for plugin's `/data/{filename}` fetches before we
	// stream any bytes; this lets plugins that issue their first metadata
	// request from inside render() find the lookup entry immediately.
	const filename = path.basename(filePath);
	remoteFiles.set(filename, { remotePath: filePath, plugin });

	// Big binary formats (BAM, CRAM, h5ad, ...) are paginated via the
	// /data/ endpoint — their plugin never touches the blob URL. Reading
	// the full file just to hand it a blob URL is a great way to crash
	// the extension host on multi-GB inputs (the user saw this with BAM).
	// Skip the blob read when the plugin declares a data_source.
	const hasDataSource = !!plugin.manifest.data_source;
	let bytesBase64 = '';
	let byteLength = 0;
	if (!hasDataSource) {
		try {
			const buffer = await ssh.readFile(profile, filePath);
			bytesBase64 = buffer.toString('base64');
			byteLength = buffer.length;
		} catch (err) {
			panel.webview.postMessage({ type: 'aria.viewer.fileError', filePath, error: (err as Error).message });
			return;
		}
	}

	const entryPath = path.join(plugin.dir, plugin.manifest.entry);
	const stylePath = plugin.manifest.style ? path.join(plugin.dir, plugin.manifest.style) : null;
	const entryJs = readFileOrEmpty(entryPath);
	const styleCss = stylePath ? readFileOrEmpty(stylePath) : '';
	panel.webview.postMessage({
		type: 'aria.viewer.fileLoaded',
		filePath,
		filename,
		base64: bytesBase64,
		byteLength,
		mimeType: guessMimeType(filePath),
		plugin: {
			name: plugin.manifest.name,
			version: plugin.manifest.version,
			extensions: plugin.manifest.extensions,
			entryJs,
			styleCss,
		},
	});
}

/**
 * Plugin's `fetch("/data/{filename}?page=N&page_size=K")` lands here.
 * Ports autopipe-app's `data_handler` (Rust) so the plugins (text-viewer,
 * csv-viewer, hdf5-viewer, etc.) work unchanged. The shape of the JSON
 * response — `{rows, total, page, page_size, meta?, header?, refs?,
 * col_headers?}` — matches what the plugins parse.
 */
async function handleDataFetch(url: string): Promise<unknown> {
	const parsed = parseDataUrl(url);
	if (!parsed) {
		return { error: `Unrecognized /data/ URL: ${url}` };
	}
	const { filename, page, pageSize } = parsed;
	console.log(`[aria-autopipe] /data/ request: filename=${filename} page=${page} size=${pageSize}`);

	const entry = remoteFiles.get(filename);
	if (!entry) {
		return { error: `File not registered: ${filename}` };
	}

	const ds = entry.plugin.manifest.data_source;
	if (!ds) {
		return { error: `Plugin "${entry.plugin.manifest.name}" has no data_source.` };
	}

	const profile = services().config.activeProfile();
	if (!profile) {
		return { error: 'No active SSH profile.' };
	}
	const { ssh } = services();

	const start = page * pageSize + 1; // sed is 1-indexed
	const end = start + pageSize - 1;

	const candidates: DataSourceCommands[] = [ds, ...(ds.fallback ?? [])];
	let active: DataSourceCommands | undefined = entry.chosenDataSource;

	// Docker-based plugins (samtools, bcftools, h5py images) pay a one-off
	// pull cost the first time. The 60s probe budget the original code
	// used was eating that pull and surfacing as a phantom timeout. Push
	// docker timeouts to 5 minutes and leave text at 1 minute.
	const probeTimeoutFor = (c: DataSourceCommands) => c.type === 'docker' ? 300000 : 60000;
	const rowsTimeoutFor = (c: DataSourceCommands) => c.type === 'docker' ? 600000 : 120000;

	if (!active) {
		for (const candidate of candidates) {
			if (!candidate.row_count) {
				active = candidate;
				break;
			}
			const probeCmd = buildDataCmd(candidate, candidate.row_count, entry.remotePath, 0, 0);
			console.log(`[aria-autopipe] data probe (${candidate.type}): ${probeCmd}`);
			try {
				const probeResult = await ssh.run(profile, probeCmd, { timeoutMs: probeTimeoutFor(candidate) });
				console.log(`[aria-autopipe] probe exit=${probeResult.exitCode} stdout="${probeResult.stdout.slice(0, 200)}" stderr="${probeResult.stderr.slice(0, 200)}"`);
				if ((probeResult.exitCode === 0 || candidate.allow_nonzero_exit) && /^\d+/.test(probeResult.stdout.trim())) {
					active = candidate;
					break;
				}
			} catch (err) {
				console.warn(`[aria-autopipe] probe failed:`, err);
			}
		}
		if (active) {
			entry.chosenDataSource = active;
		}
	}
	if (!active) {
		return {
			error: `No working data source for ${filename}. Plugin: ${entry.plugin.manifest.name}. Check the Aria DevTools console (Ctrl+Shift+I) for the probe commands and their stderr.`,
		};
	}

	// 1) Row count — cached.
	let total = entry.totalRows;
	if (total === undefined && active.row_count) {
		const countCmd = buildDataCmd(active, active.row_count, entry.remotePath, 0, 0);
		console.log(`[aria-autopipe] row_count cmd: ${countCmd}`);
		try {
			const countResult = await ssh.run(profile, countCmd, { timeoutMs: probeTimeoutFor(active) });
			console.log(`[aria-autopipe] row_count exit=${countResult.exitCode} stdout="${countResult.stdout.slice(0, 200)}" stderr="${countResult.stderr.slice(0, 200)}"`);
			if (countResult.exitCode === 0 || active.allow_nonzero_exit) {
				const n = parseInt(countResult.stdout.trim(), 10);
				if (Number.isFinite(n)) {
					total = n;
					entry.totalRows = n;
				}
			}
		} catch (err) {
			console.warn(`[aria-autopipe] row_count failed:`, err);
		}
	}

	// 2) Metadata (first page only).
	let meta: unknown = null;
	let header: unknown = null;
	let refs: unknown = null;
	let colHeaders: string[] = active.col_headers ? [...active.col_headers] : [];

	if (page === 0 && active.metadata) {
		const metaCmd = buildDataCmd(active, active.metadata, entry.remotePath, 0, 0);
		console.log(`[aria-autopipe] metadata cmd: ${metaCmd.slice(0, 500)}${metaCmd.length > 500 ? '…' : ''}`);
		try {
			const metaResult = await ssh.run(profile, metaCmd, { timeoutMs: 300000 });
			console.log(`[aria-autopipe] metadata exit=${metaResult.exitCode} stdout_len=${metaResult.stdout.length} stderr="${metaResult.stderr.slice(0, 400)}"`);
			if (metaResult.exitCode === 0 || active.allow_nonzero_exit) {
				const m = metaResult.stdout.trim();
				const parseMode = active.meta_parse ?? 'none';
				if (parseMode === 'bam_style') {
					header = m;
					const refList: Array<{ name: string; length: number }> = [];
					for (const line of m.split('\n')) {
						if (!line.startsWith('@SQ')) {
							continue;
						}
						let name = '';
						let length = 0;
						for (const field of line.split('\t')) {
							if (field.startsWith('SN:')) {
								name = field.slice(3);
							} else if (field.startsWith('LN:')) {
								length = parseInt(field.slice(3), 10) || 0;
							}
						}
						if (name) {
							refList.push({ name, length });
						}
					}
					if (refList.length > 0) {
						refs = refList;
					}
				} else if (parseMode === 'vcf_style') {
					const lines = m.split('\n');
					if (colHeaders.length === 0) {
						const hdr = lines.find(l => l.startsWith('#CHROM'));
						if (hdr) {
							colHeaders = hdr.replace(/^#+/, '').split('\t');
						}
					}
					const metaLines = lines.filter(l => l.startsWith('##'));
					if (metaLines.length > 0) {
						meta = metaLines.join('\n');
					}
				} else if (m.length > 0) {
					meta = m;
				}
			} else {
				// Metadata is best-effort — many formats don't have any
				// (the GTF the user hit just has no `#` comment lines, so
				// grep exits 1 without writing anything to stderr). Don't
				// fail the whole request; let the rows phase still run.
				if (metaResult.stderr.trim()) {
					console.warn(`[aria-autopipe] metadata exit ${metaResult.exitCode}: ${metaResult.stderr.trim()}`);
				}
			}
		} catch (err) {
			console.warn(`[aria-autopipe] metadata failed:`, err);
		}
	}

	// 3) Data rows.
	let rows: string[][] = [];
	if (active.rows && active.rows !== 'true') {
		const rowsCmd = buildDataCmd(active, active.rows, entry.remotePath, start, end);
		console.log(`[aria-autopipe] rows cmd: ${rowsCmd}`);
		try {
			const rowsResult = await ssh.run(profile, rowsCmd, { timeoutMs: rowsTimeoutFor(active) });
			console.log(`[aria-autopipe] rows exit=${rowsResult.exitCode} stdout_len=${rowsResult.stdout.length} stderr="${rowsResult.stderr.slice(0, 200)}"`);
			if (rowsResult.exitCode !== 0 && !active.allow_nonzero_exit) {
				return { error: rowsResult.stderr.trim() || rowsResult.stdout.trim() };
			}
			rows = rowsResult.stdout.split('\n').filter(l => l.length > 0).map(l => l.split('\t'));
		} catch (err) {
			return { error: (err as Error).message };
		}
	}

	const result: Record<string, unknown> = {
		rows,
		total: total ?? 0,
		page,
		page_size: pageSize,
	};
	if (meta !== null) { result.meta = meta; }
	if (header !== null) { result.header = header; }
	if (refs !== null) { result.refs = refs; }
	if (colHeaders.length > 0) { result.col_headers = colHeaders; }
	return result;
}

function parseDataUrl(url: string): { filename: string; page: number; pageSize: number } | null {
	const m = url.match(/^\/data\/([^?]+)(\?(.*))?$/);
	if (!m) {
		return null;
	}
	const filename = decodeURIComponent(m[1]);
	let page = 0;
	let pageSize = 100;
	if (m[3]) {
		for (const part of m[3].split('&')) {
			const [k, v] = part.split('=');
			if (k === 'page') {
				page = parseInt(decodeURIComponent(v ?? ''), 10) || 0;
			} else if (k === 'page_size') {
				pageSize = parseInt(decodeURIComponent(v ?? ''), 10) || 100;
			}
		}
	}
	return { filename, page, pageSize };
}

/**
 * Substitute the placeholders in a data_source template and wrap docker
 * commands in `docker run --rm -v $dir:/data:ro $image sh -c "..."`. Text
 * commands run as-is with `{file}` set to the remote absolute path.
 */
function buildDataCmd(ds: DataSourceCommands, template: string, remotePath: string, start: number, end: number): string {
	if (ds.type === 'docker') {
		const dir = remotePath.replace(/\/[^/]*$/, '') || '/';
		const file = remotePath.split('/').pop() ?? '';
		const inner = template
			.replace(/\{file\}/g, `/data/${file}`)
			.replace(/\{start\}/g, String(start))
			.replace(/\{end\}/g, String(end));
		// We don't drop docker's stderr here even though autopipe-app does.
		// Letting it through lets the plugin (and the user) see why an image
		// pull / Python execution actually failed — silent failure was the
		// reason h5ad showed "Server returned no structure" with no clue.
		return `docker run --rm -v "${dir}:/data:ro" ${ds.image ?? ''} sh -c "${inner}"`;
	}
	return template
		.replace(/\{file\}/g, remotePath)
		.replace(/\{start\}/g, String(start))
		.replace(/\{end\}/g, String(end));
}

/** Minimal MIME-type guesser — enough for blob-URL plugins (PDF/image
 *  rendering needs the right Content-Type to feed into embed/img tags).
 *  Everything else falls back to octet-stream and plugins handle parsing
 *  themselves. */
function guessMimeType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
	const map: Record<string, string> = {
		pdf: 'application/pdf',
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		gif: 'image/gif',
		svg: 'image/svg+xml',
		tiff: 'image/tiff',
		bmp: 'image/bmp',
		webp: 'image/webp',
		json: 'application/json',
		txt: 'text/plain',
		log: 'text/plain',
		csv: 'text/csv',
		yaml: 'text/yaml',
		yml: 'text/yaml',
		toml: 'text/plain',
		md: 'text/markdown',
	};
	return map[ext] ?? 'application/octet-stream';
}

function joinRemote(dir: string, name: string): string {
	if (dir === '/' || dir === '') {
		return `/${name}`;
	}
	return `${dir.replace(/\/+$/, '')}/${name}`;
}

function shellQuote(s: string): string {
	if (/^[A-Za-z0-9_./@:+,=-]+$/.test(s)) {
		return s;
	}
	return `'${s.replace(/'/g, "'\\''")}'`;
}

function readFileOrEmpty(p: string): string {
	try {
		return fs.readFileSync(p, 'utf8');
	} catch {
		return '';
	}
}

function renderShellHtml(webview: vscode.Webview): string {
	const cspSource = webview.cspSource;
	const pdfjsLibUri = webview.asWebviewUri(vscode.Uri.file(path.join(pdfjsDir(), 'pdf.mjs')));
	const pdfjsWorkerUri = webview.asWebviewUri(vscode.Uri.file(path.join(pdfjsDir(), 'pdf.worker.mjs')));
	const csp = [
		`default-src 'none'`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`img-src ${cspSource} data: blob:`,
		`media-src ${cspSource} data: blob:`,
		`font-src ${cspSource} data:`,
		`script-src ${cspSource} 'unsafe-inline' 'unsafe-eval'`,
		// PDF.js spawns a Web Worker; the worker URL must be allowed here.
		// We allow both the extension's cspSource (for the static .mjs we
		// bundled) and blob: (PDF.js sometimes wraps the worker source in
		// a blob URL internally).
		`worker-src ${cspSource} blob:`,
		// frame/object covers <iframe>/<embed>/<object>. The pdf-viewer
		// plugin still emits <embed src="blob:..."> — Aria intercepts
		// those before they actually try to load anything, but allowing
		// blob: here keeps the DOM from spewing CSP warnings while the
		// MutationObserver swaps them out.
		`frame-src ${cspSource} blob: data:`,
		`object-src ${cspSource} blob: data:`,
		`child-src ${cspSource} blob: data:`,
		`connect-src ${cspSource} data: blob:`,
	].join('; ');

	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>Autopipe Viewer</title>
	<style>
		html, body { margin: 0; padding: 0; height: 100%; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
		.shell { display: flex; height: 100vh; padding: 12px; gap: 0; box-sizing: border-box; }
		.left {
			width: 300px;
			flex-shrink: 0;
			min-width: 180px;
			display: flex;
			flex-direction: column;
			border: 1px solid var(--vscode-widget-border, transparent);
			border-radius: 4px;
			background: var(--vscode-editorWidget-background);
			overflow: hidden;
		}
		.gutter { flex: 0 0 8px; cursor: ew-resize; position: relative; }
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
		.left .header { padding: 10px 12px; border-bottom: 1px solid var(--vscode-widget-border, transparent); font-size: 12px; font-weight: 600; }
		.left .path { padding: 6px 12px; font-size: 10.5px; opacity: 0.7; word-break: break-all; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
		.left .breadcrumbs { padding: 6px 12px; font-size: 11px; display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
		.left .breadcrumbs .crumb { cursor: pointer; opacity: 0.8; }
		.left .breadcrumbs .crumb:hover { opacity: 1; text-decoration: underline; }
		.left .breadcrumbs .sep { opacity: 0.4; }
		.left .listing { flex: 1; overflow-y: auto; padding: 6px 0; }
		.entry {
			padding: 4px 12px;
			font-size: 12px;
			cursor: pointer;
			display: flex;
			align-items: center;
			gap: 6px;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			user-select: none;
		}
		.entry:hover { background: var(--vscode-list-hoverBackground); }
		.entry.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
		.entry .icon { width: 14px; text-align: center; flex-shrink: 0; }

		.right {
			flex: 1;
			min-width: 0;
			border: 1px solid var(--vscode-widget-border, transparent);
			border-radius: 4px;
			background: var(--vscode-editor-background);
			overflow: hidden;
			display: flex;
			flex-direction: column;
		}
		.right .header { padding: 10px 14px; border-bottom: 1px solid var(--vscode-widget-border, transparent); font-size: 12px; display: flex; gap: 8px; align-items: baseline; }
		.right .header .name { font-weight: 600; }
		.right .header .meta { opacity: 0.7; font-size: 11px; }
		.viewer-host { flex: 1; overflow: auto; position: relative; }
		.placeholder { padding: 32px; text-align: center; opacity: 0.6; font-size: 12px; }
		.err { padding: 12px; background: var(--vscode-inputValidation-errorBackground, #fee); color: var(--vscode-inputValidation-errorForeground, #c44); border: 1px solid var(--vscode-inputValidation-errorBorder, #c44); border-radius: 3px; margin: 12px; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
	</style>
</head>
<body>
	<div class="shell">
		<div class="left">
			<div class="header">Files</div>
			<div class="path" id="path">(loading)</div>
			<div class="breadcrumbs" id="breadcrumbs"></div>
			<div class="listing" id="listing"></div>
		</div>
		<div class="gutter" id="gutter"></div>
		<div class="right">
			<div class="header" id="right-header"><span class="meta">No file selected</span></div>
			<div class="viewer-host" id="viewer-host">
				<div class="placeholder">Pick a file in the list to render it with the matching viewer plugin.</div>
			</div>
		</div>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		const $ = (id) => document.getElementById(id);
		const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

		// Plugins call \`fetch("/data/{filename}?...")\` expecting an HTTP
		// endpoint. autopipe-app actually serves that endpoint; we don't.
		// Instead, we intercept the call, ask the extension to do the SSH
		// work, and hand the plugin back a Response-shaped object whose
		// .json()/.text() yields the data we got back.
		const _fetchPending = {};
		let _fetchSeq = 0;
		const _origFetch = window.fetch.bind(window);
		window.fetch = function(input, opts) {
			const url = typeof input === 'string' ? input : (input && input.url);
			if (typeof url === 'string' && url.startsWith('/data/')) {
				return new Promise(function(resolve) {
					const reqId = ++_fetchSeq;
					_fetchPending[reqId] = (payload) => {
						const body = JSON.stringify(payload);
						resolve({
							ok: !(payload && payload.error),
							status: payload && payload.error ? 500 : 200,
							statusText: payload && payload.error ? 'error' : 'ok',
							headers: { get: function() { return null; } },
							json: function() { return Promise.resolve(payload); },
							text: function() { return Promise.resolve(body); },
						});
					};
					vscode.postMessage({ type: 'aria.viewer.fetchData', reqId: reqId, url: url });
				});
			}
			return _origFetch(input, opts);
		};

		// Emoji palette — unified per the user's brief:
		//   log / txt  → 📜 (same)
		//   csv / json → 📋 (same)
		//   images (the "plots" bucket) → 📊 (chart)
		//   pdf / genomics / hdf5 keep distinctive marks
		const fileIcon = (name) => {
			const ext = (name.split('.').pop() || '').toLowerCase();
			const map = {
				py: '🐍', rs: '🦀', ts: '📘', tsx: '📘', js: '📒', jsx: '📒',
				json: '📋', toml: '📋', yaml: '📋', yml: '📋', csv: '📋',
				log: '📜', txt: '📜', md: '📜',
				sh: '⚙️', bash: '⚙️',
				html: '🌐', css: '🎨', svg: '🎨',
				png: '📊', jpg: '📊', jpeg: '📊', gif: '📊', tiff: '📊', bmp: '📊',
				pdf: '📕',
				bam: '🧬', vcf: '🧬', bcf: '🧬', cram: '🧬', bed: '🧬', gff: '🧬',
				fasta: '🧬', fa: '🧬', fastq: '🧬', fq: '🧬',
				h5: '🗄️', h5ad: '🗄️', hdf5: '🗄️',
			};
			return map[ext] || '📄';
		};

		let currentDir = '';
		let rootDir = '';
		let currentFile = null;
		let pendingInitialFile = null;
		let initialFileLoaded = false;
		let currentBlobUrl = null;
		// Tracks the plugin script tag that's currently mounted so we can
		// detach + nullify AutoPipePlugin before injecting the next one.
		let pluginInstance = null;

		function parentOf(p) {
			if (!p || p === '/') return '/';
			const cleaned = p.replace(/\\/+$/, '');
			const idx = cleaned.lastIndexOf('/');
			if (idx <= 0) return '/';
			return cleaned.slice(0, idx);
		}

		function withinRoot(p) {
			if (!rootDir) return true;
			const norm = p.replace(/\\/+$/, '');
			const r = rootDir.replace(/\\/+$/, '');
			return norm === r || norm.startsWith(r + '/');
		}

		function setBreadcrumbs(dir) {
			const r = (rootDir || '/').replace(/\\/+$/, '');
			const d = (dir || '/').replace(/\\/+$/, '');
			// Show breadcrumbs only from rootDir down — the user explicitly
			// asked that we don't expose the path above the output dir.
			let rest = '';
			if (d === r) {
				rest = '';
			} else if (d.startsWith(r + '/')) {
				rest = d.slice(r.length + 1);
			} else {
				rest = '';
			}
			const parts = rest ? rest.split('/').filter(Boolean) : [];
			const rootLabel = r.split('/').filter(Boolean).pop() || '/';
			let acc = r;
			const crumbs = ['<span class="crumb" data-path="' + escapeHtml(r) + '">' + escapeHtml(rootLabel) + '</span>'];
			for (const p of parts) {
				acc = acc + '/' + p;
				crumbs.push('<span class="sep">›</span>');
				crumbs.push('<span class="crumb" data-path="' + escapeHtml(acc) + '">' + escapeHtml(p) + '</span>');
			}
			$('breadcrumbs').innerHTML = crumbs.join('');
			document.querySelectorAll('.crumb').forEach(el => {
				el.onclick = () => navigateTo(el.getAttribute('data-path'));
			});
		}

		function navigateTo(dir) {
			if (!withinRoot(dir)) {
				return;
			}
			currentDir = dir;
			$('path').textContent = dir;
			setBreadcrumbs(dir);
			$('listing').innerHTML = '<div class="placeholder">Loading…</div>';
			vscode.postMessage({ type: 'aria.viewer.list', directory: dir });
		}

		function renderListing(entries) {
			let html = '';
			// ".." entry only when going up stays within rootDir. At root
			// we drop the affordance entirely — there's nowhere allowed
			// to navigate above us.
			if (currentDir && currentDir !== rootDir) {
				const parent = parentOf(currentDir);
				if (withinRoot(parent)) {
					html += '<div class="entry" data-type="up" data-path="' + escapeHtml(parent) + '"><span class="icon">📁</span>..</div>';
				}
			}
			if (!entries || entries.length === 0) {
				html += '<div class="placeholder">Empty.</div>';
				$('listing').innerHTML = html;
				return;
			}
			for (const e of entries) {
				const icon = e.is_dir ? '📁' : fileIcon(e.name);
				const cls = (e.path === currentFile) ? 'entry selected' : 'entry';
				html += '<div class="' + cls + '" data-type="' + (e.is_dir ? 'dir' : 'file') + '" data-path="' + escapeHtml(e.path) + '"><span class="icon">' + icon + '</span>' + escapeHtml(e.name) + '</div>';
			}
			$('listing').innerHTML = html;
			document.querySelectorAll('.entry').forEach(el => {
				el.onclick = () => {
					const type = el.getAttribute('data-type');
					const p = el.getAttribute('data-path');
					if (type === 'dir' || type === 'up') {
						navigateTo(p);
					} else {
						openFile(p);
					}
				};
			});

			if (!initialFileLoaded && pendingInitialFile) {
				const wanted = pendingInitialFile;
				pendingInitialFile = null;
				initialFileLoaded = true;
				const match = entries.find(e => !e.is_dir && e.path === wanted);
				if (match) {
					openFile(wanted);
				}
			}
		}

		function openFile(filePath) {
			currentFile = filePath;
			$('right-header').innerHTML = '<span class="name">' + escapeHtml(filePath.split('/').pop()) + '</span><span class="meta">Loading…</span>';
			$('viewer-host').innerHTML = '<div class="placeholder">Loading ' + escapeHtml(filePath) + '…</div>';
			vscode.postMessage({ type: 'aria.viewer.open', filePath });
			document.querySelectorAll('.entry').forEach(el => {
				if (el.getAttribute('data-path') === filePath) el.classList.add('selected');
				else el.classList.remove('selected');
			});
		}

		function bytesFromBase64(b64) {
			const binary = atob(b64);
			const len = binary.length;
			const bytes = new Uint8Array(len);
			for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
			return bytes;
		}

		function tearDownCurrentPlugin() {
			try {
				if (window.AutoPipePlugin && typeof window.AutoPipePlugin.destroy === 'function') {
					window.AutoPipePlugin.destroy();
				}
			} catch (e) { /* ignore */ }
			window.AutoPipePlugin = undefined;
			if (currentBlobUrl) {
				try { URL.revokeObjectURL(currentBlobUrl); } catch (e) { /* ignore */ }
				currentBlobUrl = null;
			}
			if (pluginInstance && pluginInstance.parentNode) {
				pluginInstance.parentNode.removeChild(pluginInstance);
			}
			pluginInstance = null;
		}

		let currentPayload = null;

		// PDF.js — loaded once on viewer panel boot. We import the module
		// lazily and stash the lib object so subsequent embed swaps reuse
		// the same instance. workerSrc must be set BEFORE the first call
		// to getDocument(), otherwise PDF.js spawns a fake worker on the
		// main thread (slower, but still works as a fallback).
		let pdfjsLibPromise = null;
		function getPdfjs() {
			if (!pdfjsLibPromise) {
				pdfjsLibPromise = import(${JSON.stringify(pdfjsLibUri.toString())}).then(mod => {
					mod.GlobalWorkerOptions.workerSrc = ${JSON.stringify(pdfjsWorkerUri.toString())};
					return mod;
				}).catch(err => {
					console.error('[aria-autopipe] PDF.js load failed', err);
					throw err;
				});
			}
			return pdfjsLibPromise;
		}

		// Track which <embed>s we've already swapped so the
		// MutationObserver doesn't keep re-processing the same node when
		// the plugin's zoom re-render fires.
		const ARIA_PDF_HANDLED = '__ariaPdfHandled';

		async function replacePdfEmbeds() {
			const embeds = document.querySelectorAll('embed[type="application/pdf"]');
			for (const embed of embeds) {
				if (embed[ARIA_PDF_HANDLED]) continue;
				embed[ARIA_PDF_HANDLED] = true;
				try {
					await intercept(embed);
				} catch (err) {
					embed.replaceWith(makePdfError(err));
				}
			}
		}

		function makePdfError(err) {
			const fb = document.createElement('div');
			fb.style.padding = '24px';
			fb.style.color = 'var(--vscode-inputValidation-errorForeground, #c44)';
			fb.textContent = 'PDF render failed: ' + (err && err.message ? err.message : String(err));
			return fb;
		}

		async function intercept(embed) {
			const src = (embed.getAttribute('src') || '').split('#')[0];
			if (!src) return;
			// The pdf-viewer plugin signals its current zoom via wrap height
			// (500 * _zoom/100). We invert that to a zoom factor so user
			// "+" clicks actually grow the canvas. Without this the wrap
			// just got taller while the canvas inside stayed the same size.
			const wrap = embed.parentElement;
			const wrapHeightPx = (wrap && wrap.style && parseFloat(wrap.style.height)) || 500;
			const zoomFactor = wrapHeightPx / 500;       // 1.0 at 100%, 2.0 at 200%

			const container = document.createElement('div');
			container.style.width = '100%';
			container.style.height = '100%';
			container.style.overflow = 'auto';
			container.style.background = 'var(--vscode-editor-background)';
			// Grab-to-pan affordance. We toggle to "grabbing" on
			// mousedown so the cursor stays consistent during a drag.
			container.style.cursor = 'grab';
			embed.replaceWith(container);

			const loading = document.createElement('div');
			loading.style.padding = '16px';
			loading.style.opacity = '0.7';
			loading.style.fontSize = '12px';
			loading.textContent = 'Rendering PDF…';
			container.appendChild(loading);

			const lib = await getPdfjs();
			const buffer = await fetch(src).then(r => r.arrayBuffer());
			const pdf = await lib.getDocument({ data: buffer }).promise;
			container.removeChild(loading);

			// First-page metrics drive the "fit width" baseline so the
			// whole page is visible on first paint. Without this, scale
			// 1.5 made the canvas wider than the container and the user
			// only saw a sliver in the top-left.
			const firstPage = await pdf.getPage(1);
			const baseViewport = firstPage.getViewport({ scale: 1.0 });
			const fitScale = (container.clientWidth - 24) / baseViewport.width;
			// Plugin zoom multiplies the fit-width baseline so "+" still
			// makes the picture bigger relative to the perfect fit.
			const renderScale = Math.max(0.25, fitScale * zoomFactor);

			for (let p = 1; p <= pdf.numPages; p++) {
				const page = p === 1 ? firstPage : await pdf.getPage(p);
				const viewport = page.getViewport({ scale: renderScale });
				const canvas = document.createElement('canvas');
				canvas.width = viewport.width;
				canvas.height = viewport.height;
				canvas.style.display = 'block';
				canvas.style.margin = '0 auto 12px';
				canvas.style.boxShadow = '0 1px 4px rgba(0,0,0,0.3)';
				container.appendChild(canvas);
				await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
			}

			// Drag-to-pan. We listen on the container itself so the user
			// can grab anywhere — over a canvas or over the whitespace
			// between pages. scrollLeft/Top only matters when a zoomed-in
			// canvas overflows; at 100% (fit) there's nothing to pan to,
			// but the drag is still harmless.
			let dragging = false;
			let startX = 0, startY = 0, startScrollLeft = 0, startScrollTop = 0;
			container.addEventListener('mousedown', (e) => {
				dragging = true;
				startX = e.clientX;
				startY = e.clientY;
				startScrollLeft = container.scrollLeft;
				startScrollTop = container.scrollTop;
				container.style.cursor = 'grabbing';
				e.preventDefault();
			});
			window.addEventListener('mousemove', (e) => {
				if (!dragging) return;
				container.scrollLeft = startScrollLeft - (e.clientX - startX);
				container.scrollTop = startScrollTop - (e.clientY - startY);
			});
			window.addEventListener('mouseup', () => {
				if (!dragging) return;
				dragging = false;
				container.style.cursor = 'grab';
			});
		}

		// Run a single MutationObserver across the whole shell so it
		// catches every <embed> insertion, including the new ones the
		// plugin emits when the user clicks zoom in/out.
		new MutationObserver(replacePdfEmbeds).observe(document.body, { childList: true, subtree: true });

		function mountPlugin(payload) {
			tearDownCurrentPlugin();

			currentPayload = payload;
			const bytes = bytesFromBase64(payload.base64);
			const blob = new Blob([bytes], { type: payload.mimeType || 'application/octet-stream' });
			currentBlobUrl = URL.createObjectURL(blob);

			$('right-header').innerHTML = '<span class="name">' + escapeHtml(payload.filename) + '</span><span class="meta">' + escapeHtml(payload.plugin.name + ' v' + payload.plugin.version) + '</span>';

			// Reset the viewer host with a single container element the
			// plugin can take ownership of. Inject the plugin's style
			// once, then load the plugin script and call its render().
			// The padding leaves a little breathing room on every side —
			// plugins (hdf5-viewer in particular) draw their tree right
			// up to the edge otherwise.
			const host = $('viewer-host');
			host.innerHTML = '';
			const container = document.createElement('div');
			container.style.height = '100%';
			container.style.width = '100%';
			container.style.padding = '8px';
			container.style.boxSizing = 'border-box';
			host.appendChild(container);

			if (payload.plugin.styleCss) {
				const style = document.createElement('style');
				style.textContent = payload.plugin.styleCss;
				host.appendChild(style);
			}

			const script = document.createElement('script');
			script.textContent = payload.plugin.entryJs;
			pluginInstance = script;
			host.appendChild(script);

			// AutoPipePlugin contract: window.AutoPipePlugin.render(container, fileUrl, filename)
			if (window.AutoPipePlugin && typeof window.AutoPipePlugin.render === 'function') {
				try {
					window.AutoPipePlugin.render(container, currentBlobUrl, payload.filename);
					// PDF plugins (and anything else that drops a sandboxed
					// <embed>) gets rewritten on a microtask boundary so the
					// plugin's first innerHTML pass has already settled.
					setTimeout(replacePdfEmbeds, 0);
				} catch (err) {
					host.innerHTML = '<div class="err">Plugin render failed: ' + escapeHtml(String(err)) + '</div>';
				}
			} else {
				host.innerHTML = '<div class="err">Plugin "' + escapeHtml(payload.plugin.name) + '" did not register AutoPipePlugin.render</div>';
			}
		}

		window.addEventListener('message', (e) => {
			const msg = e.data;
			if (msg.type === 'aria.viewer.fetchData.response') {
				const cb = _fetchPending[msg.reqId];
				if (cb) {
					delete _fetchPending[msg.reqId];
					cb(msg.data);
				}
				return;
			}
			if (msg.type === 'aria.viewer.setDirectory') {
				rootDir = msg.rootDir || msg.directory || '/';
				if (msg.initialFile) {
					pendingInitialFile = msg.initialFile;
					initialFileLoaded = false;
				}
				navigateTo(msg.directory);
			} else if (msg.type === 'aria.viewer.list.ok' && msg.directory === currentDir) {
				renderListing(msg.entries);
			} else if (msg.type === 'aria.viewer.fileLoaded') {
				mountPlugin(msg);
			} else if (msg.type === 'aria.viewer.fileError') {
				$('right-header').innerHTML = '<span class="name">' + escapeHtml(msg.filePath.split('/').pop()) + '</span>';
				$('viewer-host').innerHTML = '<div class="err">' + escapeHtml(msg.error) + '</div>';
			} else if (msg.type === 'aria.viewer.error') {
				$('listing').innerHTML = '<div class="err">' + escapeHtml(msg.error) + '</div>';
			}
		});

		// Resize handle between the file list and the viewer pane.
		(function() {
			const gutter = document.getElementById('gutter');
			const left = document.querySelector('.left');
			const shell = document.querySelector('.shell');
			if (!gutter || !left || !shell) return;
			let dragging = false;
			gutter.addEventListener('mousedown', (e) => {
				dragging = true;
				document.body.style.cursor = 'ew-resize';
				e.preventDefault();
			});
			document.addEventListener('mousemove', (e) => {
				if (!dragging) return;
				const rect = shell.getBoundingClientRect();
				const newWidth = Math.max(180, Math.min(rect.width - 240, e.clientX - rect.left));
				left.style.width = newWidth + 'px';
			});
			document.addEventListener('mouseup', () => {
				if (dragging) {
					dragging = false;
					document.body.style.cursor = '';
				}
			});
		})();

		vscode.postMessage({ type: 'aria.viewer.ready' });
	</script>
</body>
</html>`;
}
