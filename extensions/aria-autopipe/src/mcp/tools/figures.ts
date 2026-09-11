/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';
import { ToolDefinition, textResult, errorResult } from './types';
import { workspaceFolderPath } from '../../common/workspaceSync';

/**
 * save_figure - write a figure into the project's Figure library (`.qoka/figures/`).
 *
 * Figures (drawn with the Penpot MCP, or any exported image) are saved here DIRECTLY
 * by the extension host from the base64 bytes the AI already holds - NOT through
 * run_code. run_code always scaffolds a `results/<run>/` folder and (when kept) an
 * `analysis/<run>/` script, which clutters those dirs; a figure is not analysis code,
 * so it must not land there. This tool decodes the bytes and writes the file straight
 * to the local project's `.qoka/figures/`, which the Manuscript tab's "Figure library"
 * watches and shows. No run environment is involved (the bytes are in the tool call),
 * so it works the same for local, WSL/vfkit, and remote-SSH run targets.
 */

const EXT_BY_MIME: Record<string, string> = {
	'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg',
	'application/pdf': 'pdf', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
};

const ALLOWED_EXTS = new Set(['png', 'jpg', 'jpeg', 'svg', 'pdf', 'gif', 'webp', 'bmp']);

function slugify(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** Pick the file extension: explicit `format` wins, else the data: URL's MIME, else png. */
function pickExt(format: string, mime: string | undefined): string {
	const f = format.trim().toLowerCase();
	if (f && ALLOWED_EXTS.has(f)) { return f === 'jpeg' ? 'jpg' : f; }
	if (mime && EXT_BY_MIME[mime.toLowerCase()]) { return EXT_BY_MIME[mime.toLowerCase()]; }
	return 'png';
}

export const FIGURE_TOOLS: ToolDefinition[] = [
	{
		name: 'save_figure',
		description:
			'Save a FIGURE into the project so it appears in the Manuscript tab\'s Figure library. Use this whenever the user asks to save/export a figure they drew with the Penpot MCP (or any exported image). Pass the exported image as base64 in `data` (the "data" field of Penpot export_shape\'s {type:"image",data,mimeType} result - a raw base64 string or a data: URL), a short `name`, and the `format`. '
			+ 'DO NOT use run_code / Bash to save figures: run_code creates results/<run>/ and analysis/<run>/ folders and a figure is not analysis code, so it must not clutter those. This tool writes the bytes directly to the project\'s internal figures folder and the Figure library refreshes automatically. '
			+ 'When it succeeds, tell the user the figure is saved to the Manuscript tab\'s Figure library - do NOT mention any internal folder path.',
		inputSchema: {
			type: 'object',
			properties: {
				data: { type: 'string', description: 'The figure image as base64 (a raw base64 string, or a full data: URL like "data:image/png;base64,..."). Typically the "data" field returned by the Penpot export_shape tool.' },
				name: { type: 'string', description: 'A short, human-readable figure name, e.g. "signaling-pathway". It is slugified for the filename; a duplicate gets -2, -3 automatically.' },
				format: { type: 'string', description: 'The image format / file extension. If omitted, it is inferred from a data: URL MIME type, else defaults to png.', enum: ['png', 'svg', 'pdf', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
			},
			required: ['data', 'name'],
		},
		handler: async (args) => {
			const root = workspaceFolderPath();
			if (!root) { return errorResult('No project is open, so there is nowhere to save the figure.'); }

			const raw = String(args.data ?? '');
			// Accept either a raw base64 string or a full data: URL.
			const m = raw.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
			const mime = m ? m[1] : undefined;
			const b64 = (m ? m[2] : raw).replace(/\s+/g, '');
			if (!b64) { return errorResult('No image data was provided in `data`.'); }

			let buf: Buffer;
			try { buf = Buffer.from(b64, 'base64'); } catch { return errorResult('Could not decode `data` as base64.'); }
			if (buf.length === 0) { return errorResult('The decoded image is empty - the base64 in `data` may be truncated.'); }

			const ext = pickExt(String(args.format ?? ''), mime);
			const slug = slugify(String(args.name ?? 'figure')) || 'figure';
			const dir = path.join(root, '.qoka', 'figures');
			let file = path.join(dir, `${slug}.${ext}`);
			for (let n = 2; fs.existsSync(file); n++) { file = path.join(dir, `${slug}-${n}.${ext}`); }

			try {
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(file, buf);
			} catch (e) {
				return errorResult(`Failed to write the figure: ${(e as Error).message}`);
			}
			return textResult(`Saved "${path.basename(file)}" (${buf.length} bytes) to the Manuscript tab's Figure library.`);
		},
	},
];
