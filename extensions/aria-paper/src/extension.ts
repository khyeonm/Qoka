/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildTools } from './mcp/tools';
import { buildReviewTools, exportReviewPaper, ReviewExportFormat } from './reviews';
import { AriaPaperMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';
import { ExportFormat, exportPaper, getPandoc, setCacheDir, setResourceRoot } from './exporter';
import { addAsset, addCitationCleanKey, PaperAsset, removeAsset, setAssetSummary, syncManuscriptTitle } from './papers';
import { PAPER_MCP_INSTRUCTIONS } from './guide';

const execFileAsync = promisify(execFile);

/** Static, instant samples of how citations look per style (for the wizard's
 *  Format-step preview — no pandoc download needed). */
const CITATION_PREVIEWS: Record<string, string> = {
	ieee: 'In-text:\n… as reported previously [1].\n\nBibliography:\n[1] J. Kim and S. Lee, “Tau aggregation drives neuronal loss,” Nature Neuroscience, vol. 27, pp. 100–110, 2024.',
	apa: 'In-text:\n… as reported previously (Kim & Lee, 2024).\n\nBibliography:\nKim, J., & Lee, S. (2024). Tau aggregation drives neuronal loss. Nature Neuroscience, 27, 100–110.',
	nature: 'In-text:\n… as reported previously¹.\n\nBibliography:\n1. Kim, J. & Lee, S. Tau aggregation drives neuronal loss. Nature Neuroscience 27, 100–110 (2024).',
	chicago: 'In-text:\n… as reported previously (Kim and Lee 2024).\n\nBibliography:\nKim, Jiyoung, and Soo Lee. 2024. “Tau aggregation drives neuronal loss.” Nature Neuroscience 27: 100–110.',
};

/** Family classification for styles without a hand-written sample above, so the
 *  preview is representative (numeric/superscript/author-date/MLA). */
const STYLE_FAMILY: Record<string, 'numbracket' | 'superscript' | 'authordate' | 'mla'> = {
	ieee: 'numbracket', vancouver: 'numbracket', ama: 'numbracket', nejm: 'numbracket', lancet: 'numbracket', bmj: 'numbracket', plos: 'numbracket', pnas: 'numbracket', nar: 'numbracket',
	nature: 'superscript', science: 'superscript',
	apa: 'authordate', harvard: 'authordate', chicago: 'authordate', bioinformatics: 'authordate', cell: 'authordate',
	mla: 'mla',
};

const FAMILY_SAMPLE: Record<string, string> = {
	numbracket: 'In-text:\n… as reported previously [1].\n\nBibliography:\n[1] J. Kim and S. Lee, “Tau aggregation drives neuronal loss,” Nature Neuroscience, vol. 27, pp. 100–110, 2024.',
	superscript: 'In-text:\n… as reported previously¹.\n\nBibliography:\n1. Kim, J. & Lee, S. Tau aggregation drives neuronal loss. Nature Neuroscience 27, 100–110 (2024).',
	authordate: 'In-text:\n… as reported previously (Kim and Lee, 2024).\n\nBibliography:\nKim, J., and S. Lee. 2024. “Tau aggregation drives neuronal loss.” Nature Neuroscience 27: 100–110.',
	mla: 'In-text:\n… as reported previously (Kim and Lee 102).\n\nBibliography:\nKim, Jiyoung, and Soo Lee. “Tau Aggregation Drives Neuronal Loss.” Nature Neuroscience, vol. 27, 2024, pp. 100–110.',
};

let mcpServer: AriaPaperMcpServer | undefined;

/**
 * Register the paper MCP with every AI provider whose CLI is available
 * (Claude Code, Codex). The server serves /sse (Claude) and /mcp
 * (Codex) on the same port; missing CLIs are silently skipped.
 */
async function registerAllProviders(port: number): Promise<{ changed: boolean; summary: string }> {
	const results = await Promise.allSettled([
		registerWithClaudeCode(port),
		registerWithCodex(port),
	]);
	const labels = ['Claude Code', 'Codex'];
	const registered: string[] = [];
	let changed = false;
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') {
			console.log(`[aria-paper] ${labels[i]}: ${r.value.message}`);
			if (r.value.ok) {
				registered.push(labels[i]);
				if (r.value.changed) { changed = true; }
			}
		} else {
			console.warn(`[aria-paper] ${labels[i]} registration threw:`, r.reason);
		}
	});
	const summary = registered.length
		? `Paper MCP registered with ${registered.join(', ')}`
		: 'Paper MCP — no AI provider CLI found yet';
	return { changed, summary };
}

/**
 * Aria Paper Writer — boots a local MCP server so an AI assistant can draft,
 * cite, and export scientific manuscripts. Reads/structure/export are
 * deterministic; the prose is written by the agent following get_writing_guide.
 */
export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-paper] activate()');

	// Lets the exporter find bundled CSL styles and (later) a bundled pandoc,
	// and a writable cache dir for an auto-downloaded pandoc.
	setResourceRoot(context.extensionPath);
	setCacheDir(context.globalStorageUri.fsPath);

	// Lets the workbench Paper Writer pane's Export buttons run pandoc (which
	// lives in the extension host). Returns a human-readable result string.
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.export', async (id: string, format: string) => {
		const res = await exportPaper(id, format as ExportFormat);
		return `Exported ${format} → ${res.outputPath} (style: ${res.style}).`;
	}));

	// Save the current AI Peer Review paper (working copy) to md/docx/latex
	// inside the review's own directory. Invoked by the Peer Review pane.
	context.subscriptions.push(vscode.commands.registerCommand('aria.peerReview.exportPaper', (execId: string, format: string, docKey?: string) =>
		exportReviewPaper(execId, format as ReviewExportFormat, docKey ?? 'main')));

	// Instant citation-style preview for the wizard's Format step.
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.previewCitation', (style: string) =>
		CITATION_PREVIEWS[style] ?? FAMILY_SAMPLE[STYLE_FAMILY[style]] ?? CITATION_PREVIEWS.ieee));

	// Import a .bib file → CSL-JSON (via pandoc) → add to the paper's citations.
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.importBibtex', async (id: string) => {
		const uris = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Import BibTeX', filters: { BibTeX: ['bib'] } });
		if (!uris || uris.length === 0) { return 0; }
		const pandoc = await getPandoc();
		const { stdout } = await execFileAsync(pandoc, [uris[0].fsPath, '-t', 'csljson'], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
		let items: Array<Record<string, unknown>> = [];
		try { items = JSON.parse(stdout); } catch { throw new Error('Could not parse the BibTeX file.'); }
		if (!Array.isArray(items)) { items = []; }
		// Regenerate clean `familyYear` citekeys — reference managers (e.g.
		// RefWorks) export opaque keys like `RefWorks:RefID:149-lu2026towards`.
		for (const item of items) { addCitationCleanKey(id, item); }
		return items.length;
	}));

	// Re-sync the manuscript's leading H1 with the paper title (called by the
	// wizard when the user edits the title, so manuscript.md stays in sync).
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.syncTitle', (id: string) => {
		syncManuscriptTitle(id);
	}));

	// Add figures (images) or supplementary sources: pick files, copy them into
	// the paper's figures/ or sources/ dir, and register them (summary pending).
	const addAssets = async (id: string, kind: 'figure' | 'source'): Promise<PaperAsset[]> => {
		const filters: { [name: string]: string[] } = kind === 'figure'
			? { Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'tiff'] }
			: { Documents: ['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml', 'py', 'ipynb'] };
		const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: kind === 'figure' ? 'Add figures' : 'Add sources', filters });
		if (!uris || uris.length === 0) { return []; }
		const added: PaperAsset[] = [];
		for (const u of uris) { added.push(addAsset(id, kind, u.fsPath)); }
		return added;
	};
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.addFigures', (id: string) => addAssets(id, 'figure')));
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.addSources', (id: string) => addAssets(id, 'source')));
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.removeAsset', (id: string, assetId: string) => {
		removeAsset(id, assetId);
	}));
	// Save a user-edited figure/source summary from the wizard.
	context.subscriptions.push(vscode.commands.registerCommand('aria.paper.setAssetSummary', (id: string, assetId: string, summary: string) => {
		setAssetSummary(id, assetId, summary);
	}));

	const tools = buildTools().concat(buildReviewTools());
	mcpServer = new AriaPaperMcpServer(tools, PAPER_MCP_INSTRUCTIONS);

	let currentPort: number | undefined;

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-paper-mcp');
		let summary = 'Paper MCP — already configured';
		let changed = false;
		try {
			const port = await mcpServer!.start();
			currentPort = port;
			console.log(`[aria-paper] MCP up on ${port}; registering with AI providers…`);
			const reg = await registerAllProviders(port);
			changed = reg.changed;
			summary = reg.summary;
		} catch (e) {
			summary = `Paper MCP startup failed: ${(e as Error).message}`;
			changed = false;
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'aria-paper-mcp', summary, changed);
		}
	})();

	// Re-register when provider extensions are installed/removed later, so a
	// provider added after startup still gets the paper MCP wired up without a
	// reload. Debounced because installs fire onDidChange rapidly.
	let timer: NodeJS.Timeout | undefined;
	context.subscriptions.push(vscode.extensions.onDidChange(() => {
		if (currentPort === undefined) { return; }
		if (timer) { clearTimeout(timer); }
		timer = setTimeout(() => { void registerAllProviders(currentPort!); }, 800);
	}));
}

export async function deactivate(): Promise<void> {
	console.log('[aria-paper] deactivate()');
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
