/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Bundles the extension into a single CommonJS file with esbuild.
//
// Why bundle instead of plain `tsc`: tsc emits one file per source module (~60), and
// the extension host require()s them one by one at activation - each a separate
// resolve + disk read + compile. Activation is on Qoka's startup path, and those reads
// are slow on a cold disk cache (after a reboot or an install). One bundle is one read.
// Behaviour is unchanged: the same code, concatenated.
//
// Type-checking is separate (`npm run typecheck`), since esbuild does not type-check.

import * as esbuild from 'esbuild';
import * as fs from 'fs';

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
	// `ssh2` stays a normal node_modules dependency: it loads an optional native crypto
	// binding (sshcrypto.node) and cpu-features by path at runtime, which bundling
	// would break (it would silently fall back to slower pure-JS crypto).
	external: ['vscode', 'ssh2'],
	logLevel: 'info',
};

if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
	console.log('aria-autopipe: esbuild watching…');
} else {
	// Drop the per-module files an older tsc build left in out/, so nothing stale ships.
	fs.rmSync('out', { recursive: true, force: true });
	await esbuild.build(options);
	console.log('aria-autopipe: bundled out/extension.js');
}
