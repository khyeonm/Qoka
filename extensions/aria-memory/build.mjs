/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Bundles the extension into a single CommonJS file with esbuild.
//
// The wiki engine only uses node builtins, so a plain tsc would also work; we
// bundle with esbuild anyway to stay consistent with the other aria-* MCP
// extensions and to keep the door open for future ESM-only deps (e.g. the
// mem0 client, which ships ESM) without reworking the build.

import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	outfile: 'out/extension.js',
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	sourcemap: false,
	// `vscode` is provided by the extension host at runtime; never bundle it.
	external: ['vscode'],
	logLevel: 'info',
};

if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
	console.log('aria-memory: esbuild watching…');
} else {
	await esbuild.build(options);
	console.log('aria-memory: bundled out/extension.js');
}
