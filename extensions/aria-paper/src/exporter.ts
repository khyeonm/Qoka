/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import {
	citationsPath, exportDir, getMeta, manuscriptPath, withTitleHeading,
} from './papers';
import { ensurePandoc } from './download';

const execFileAsync = promisify(execFile);

/** Output formats the writer supports today. PDF (tectonic) is added later. */
export type ExportFormat = 'markdown' | 'docx' | 'latex';

const EXT: Record<ExportFormat, string> = { markdown: 'md', docx: 'docx', latex: 'tex' };

/** Resource root (the extension dir) for bundled CSL styles, set on activate. */
let resourceRoot = '';
export function setResourceRoot(dir: string): void { resourceRoot = dir; }

/** Writable cache dir (extension globalStorage) for an auto-downloaded pandoc. */
let cacheDir = '';
export function setCacheDir(dir: string): void { cacheDir = dir; }

/** Resolve the pandoc binary (downloading once if needed) for other callers. */
export function getPandoc(): Promise<string> {
	return ensurePandoc({ resourceRoot, cacheDir, onStatus: m => console.log('[aria-paper]', m) });
}

/** Map a CSL style key (ieee, apa, …) to a bundled .csl path, or undefined. */
function cslFor(style: string): string | undefined {
	if (!resourceRoot) { return undefined; }
	const dir = path.join(resourceRoot, 'resources', 'csl');
	const file = path.join(dir, `${style}.csl`);
	if (fs.existsSync(file)) { return file; }
	const ieee = path.join(dir, 'ieee.csl');
	return fs.existsSync(ieee) ? ieee : undefined;
}

export interface ExportResult {
	outputPath: string;
	format: ExportFormat;
	style: string;
	pandoc: string;
}

/**
 * Export a paper to one format via pandoc + citeproc. The manuscript Markdown
 * (with [@citekey] markers) is rendered against the paper's CSL-JSON
 * bibliography in the chosen style - in-text citations and the reference list
 * are produced together (numeric styles numbered in order of appearance).
 */
export async function exportPaper(id: string, format: ExportFormat, markdown?: string): Promise<ExportResult> {
	const meta = getMeta(id);
	if (!meta) { throw new Error(`No paper "${id}".`); }
	const manuscript = manuscriptPath(id);
	const bib = citationsPath(id);
	const outDir = exportDir(id);
	if (!manuscript || !bib || !outDir) { throw new Error('No workspace folder is open.'); }

	// Resolve the Markdown to convert. Prefer an explicit `markdown` argument so a
	// docx/latex/md can be produced even when the manuscript has NOT been saved to
	// disk yet; otherwise fall back to the saved manuscript.md. When an override is
	// given and nothing is saved, persist it so the paper isn't left empty and
	// later reads/exports work - but we do NOT overwrite an existing saved draft,
	// to avoid clobbering user edits or the frozen baseline.
	let source: string;
	if (typeof markdown === 'string' && markdown.trim()) {
		source = withTitleHeading(markdown, meta.title);
		if (!fs.existsSync(manuscript)) {
			fs.mkdirSync(path.dirname(manuscript), { recursive: true });
			fs.writeFileSync(manuscript, source, 'utf8');
		}
	} else if (fs.existsSync(manuscript)) {
		source = fs.readFileSync(manuscript, 'utf8');
	} else {
		throw new Error('Manuscript not found - pass `markdown` to export_paper, or save it first with set_manuscript.');
	}

	fs.mkdirSync(outDir, { recursive: true });
	const outputPath = path.join(outDir, `paper.${EXT[format]}`);
	const style = meta.format.citationStyle || 'ieee';
	const csl = cslFor(style);
	const pandoc = await ensurePandoc({ resourceRoot, cacheDir, onStatus: m => console.log('[aria-paper]', m) });

	const hasBib = fs.existsSync(bib) && getCitationCount(bib) > 0;

	// citeproc appends the bibliography at the end of the document. To give it a
	// heading at the same level as the body sections (##), append a "References"
	// header so the rendered bibliography sits under it. We always render from a
	// temp copy so this works whether or not the manuscript is saved to disk, and
	// keeps manuscript.md clean; only add the heading when there are citations and
	// the source doesn't already carry such a heading.
	let body = source;
	if (hasBib && !/^##\s+(references|참고문헌)\b/im.test(body)) {
		const refTitle = meta.format.language === 'ko' ? '참고문헌' : 'References';
		body = body.replace(/\s*$/, '') + `\n\n## ${refTitle}\n`;
	}
	const tempInput = path.join(outDir, '.manuscript.export.md');
	fs.writeFileSync(tempInput, body, 'utf8');

	const args = [tempInput, '--citeproc'];
	if (csl) { args.push('--csl', csl); }
	if (hasBib) { args.push('--bibliography', bib); }
	// Resolve relative image paths (figures/fig1.png) - relative to the paper dir
	// even though the input is a temp file inside export/.
	args.push('--resource-path', path.dirname(manuscript));
	// The title is carried as the manuscript's leading `# {title}` H1 (kept in
	// sync from meta.title), so we do NOT also pass --metadata title - that would
	// render a second, duplicate title in standalone formats like DOCX.
	// Document language drives citeproc's locale (e.g. ko -> Korean terms).
	if (meta.format.language) { args.push('--metadata', `lang=${meta.format.language}`); }
	args.push('-o', outputPath);

	try {
		await execFileAsync(pandoc, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
	} catch (e) {
		const err = e as { code?: string; stderr?: string; message?: string };
		if (err.code === 'ENOENT') {
			throw new Error('pandoc not found. Set ARIA_PANDOC to the pandoc binary, put it on PATH, or bundle it under <extension>/bin/.');
		}
		throw new Error(`pandoc export failed: ${(err.stderr || err.message || String(e)).toString().slice(0, 500)}`);
	} finally {
		try { fs.unlinkSync(tempInput); } catch { /* ignore */ }
	}

	return { outputPath, format, style, pandoc };
}

function getCitationCount(bibPath: string): number {
	try {
		const parsed = JSON.parse(fs.readFileSync(bibPath, 'utf8'));
		return Array.isArray(parsed) ? parsed.length : 0;
	} catch {
		return 0;
	}
}
