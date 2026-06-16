/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Bundles the BlockNote note-editor app into the webview asset that
// AriaNoteEditorPane loads. Run: `npm run build` (from this folder).
// Output: ../src/vs/workbench/contrib/ariaNotes/browser/media/notesEditor.{js,css}

import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.resolve(dir, '../src/vs/workbench/contrib/ariaNotes/browser/media');

await esbuild.build({
	entryPoints: [path.join(dir, 'index.tsx')],
	bundle: true,
	format: 'iife',
	jsx: 'automatic',
	outfile: path.join(outdir, 'notesEditor.js'),
	// Inline BlockNote/Inter fonts as data URLs so the webview needs no extra
	// resource roots for them; CSS imports are emitted as notesEditor.css.
	loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
	// @blocknote/mantine's CSS @imports "@blocknote/react/style.css" as a bare
	// specifier which esbuild's CSS resolver doesn't follow via the package
	// exports map — point it straight at the built file.
	alias: {
		'@blocknote/react/style.css': path.join(dir, 'node_modules/@blocknote/react/dist/style.css'),
	},
	define: { 'process.env.NODE_ENV': '"production"' },
	minify: true,
	logLevel: 'info',
});

console.log('[aria-notes] bundled notesEditor.{js,css} →', outdir);
