/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Bundles the extension into a single CommonJS file with esbuild.

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
	console.log('aria-overview: esbuild watching…');
} else {
	await esbuild.build(options);
	console.log('aria-overview: bundled out/extension.js');
}
