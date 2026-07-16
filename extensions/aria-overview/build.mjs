/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Bundles the extension into a single CommonJS file with esbuild.
//
// Why bundle instead of plain `tsc`: @blocknote/server-util (and its deps) ship
// as ESM-only packages. A tsc-compiled CommonJS extension that `require()`s them
// hits ESM/CJS interop failures at activation time (e.g. "h.default.extend is not
// a function"). esbuild inlines and transpiles those ESM deps to CJS inside the
// bundle, so the extension loads cleanly in the (CommonJS) extension host.

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
	// `jsdom` (server-util's DOM backend) is CommonJS and require-able as-is;
	// bundling it breaks its runtime `require.resolve('./xhr-sync-worker.js')`,
	// so keep it external and let node load it from node_modules.
	external: ['vscode', 'jsdom'],
	// server-util pulls in @blocknote/core, which references CSS/font assets that
	// are irrelevant server-side. Treat them as empty so the node bundle builds.
	loader: {
		'.css': 'empty',
		'.ttf': 'empty',
		'.woff': 'empty',
		'.woff2': 'empty',
	},
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
