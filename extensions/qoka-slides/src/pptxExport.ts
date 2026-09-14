/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Build an EDITABLE .pptx from a deck's on-screen geometry. The webview measures
// every positioned element (design px on the canvas) and hands us this model; we
// map it onto a PowerPoint slide (native text boxes + images the user can move and
// retype). CSS-only styling (theme backgrounds, gradients, accent bars, custom web
// fonts) does not survive: PowerPoint has no equivalent, which is why the caller
// warns the user before exporting.

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import pptxgen from 'pptxgenjs';
import { readMeta, readFigures, figuresDir } from './storage';

export interface ExportEl {
	kind: 'text' | 'image';
	x: number; y: number; w: number; h: number; // design px on the canvas
	text?: string;
	fontSize?: number; // design px
	color?: string;    // #rrggbb
	bold?: boolean;
	italic?: boolean;
	align?: 'left' | 'center' | 'right';
	fontFace?: string;
	fill?: string | null; // #rrggbb background, or null
	fig?: string | null;  // figure key (data-fig)
	src?: string | null;  // data: URI fallback
}

export interface ExportModel {
	canvas: { w: number; h: number };
	slides: { elements: ExportEl[] }[];
}

const MIME_BY_EXT: Record<string, string> = {
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
	'.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
};

function mimeOf(file: string): string {
	return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'image/png';
}

function safeName(title: string): string {
	return (title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'slides').slice(0, 80);
}

/**
 * Export `model` to a .pptx the user chooses a location for. Returns the saved
 * path, or undefined if the user cancelled the save dialog.
 */
export async function exportDeckToPptx(slug: string, model: ExportModel): Promise<string | undefined> {
	const meta = await readMeta(slug);
	const title = meta.title ?? slug;
	const cw = model.canvas.w || 1920;
	const ch = model.canvas.h || 1080;

	// PowerPoint slide is 7.5in tall; width follows the canvas aspect (13.333 for
	// 16:9, 10 for 4:3). px -> inch scales each axis by the same factor.
	const slideH = 7.5;
	const slideW = Number((cw / ch * slideH).toFixed(4));
	const inX = (px: number) => Number((px / cw * slideW).toFixed(3));
	const inY = (px: number) => Number((px / ch * slideH).toFixed(3));
	// 7.5in = 540pt, so a design px maps to px * 540/ch points.
	const pt = (px: number) => Math.max(6, Math.round(px * (540 / ch)));

	const pptx = new pptxgen();
	pptx.defineLayout({ name: 'QOKA', width: slideW, height: slideH });
	pptx.layout = 'QOKA';
	pptx.title = title;

	const figFiles = await readFigures(slug).catch(() => ({} as Record<string, string>));

	for (const s of model.slides) {
		const slide = pptx.addSlide();
		for (const el of s.elements) {
			if (el.kind === 'image') {
				let dataUri: string | undefined;
				if (el.fig && figFiles[el.fig]) {
					try {
						const file = path.join(figuresDir(slug), figFiles[el.fig]);
						const bytes = await fs.readFile(file);
						dataUri = `data:${mimeOf(file)};base64,${bytes.toString('base64')}`;
					} catch { /* missing figure file */ }
				}
				if (!dataUri && el.src && el.src.startsWith('data:')) { dataUri = el.src; }
				if (dataUri) {
					slide.addImage({ data: dataUri, x: inX(el.x), y: inY(el.y), w: inX(el.w), h: inY(el.h) });
				}
			} else if (el.text && el.text.trim()) {
				slide.addText(el.text, {
					x: inX(el.x), y: inY(el.y), w: inX(el.w), h: inY(el.h),
					fontSize: pt(el.fontSize ?? 24),
					color: (el.color ?? '#333333').replace('#', ''),
					bold: !!el.bold,
					italic: !!el.italic,
					align: el.align ?? 'left',
					valign: 'top',
					...(el.fontFace ? { fontFace: el.fontFace } : {}),
					...(el.fill ? { fill: { color: el.fill.replace('#', '') } } : {}),
					margin: 0,
				});
			}
		}
	}

	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	const defaultUri = folder ? vscode.Uri.joinPath(folder, `${safeName(title)}.pptx`) : vscode.Uri.file(`${safeName(title)}.pptx`);
	const dst = await vscode.window.showSaveDialog({
		defaultUri,
		saveLabel: 'Export',
		filters: { 'PowerPoint presentation': ['pptx'] },
	});
	if (!dst) { return undefined; }

	await pptx.writeFile({ fileName: dst.fsPath });
	return dst.fsPath;
}
