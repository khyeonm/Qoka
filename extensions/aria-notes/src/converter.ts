/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { Worker } from 'worker_threads';

/**
 * Runs the Markdown <-> BlockNote conversion (out/convertWorker.js) in a worker
 * thread, so loading the large conversion library never blocks the extension host.
 *
 * - `startConverter()` is called shortly after activation to load it in the background.
 * - A conversion requested before it is ready simply waits for it (and starts it if it
 *   was not started yet); requests are answered in order once it is up.
 * - If the worker cannot start or dies, conversions fall back to loading the same file
 *   in-process (the old behaviour: one pause, but the note operation still succeeds).
 */

type Op = 'toMarkdown' | 'toBlocks';
interface InProcess { toMarkdown(blocks: unknown[]): Promise<string>; toBlocks(markdown: string): Promise<unknown[]> }

const WORKER_FILE = path.join(__dirname, 'convertWorker.js');

let worker: Worker | undefined;
let ready: Promise<boolean> | undefined;     // resolves true when the worker is up, false when it failed
let inProcess: InProcess | undefined;
let workerBroken = false;                    // the worker failed to START once: use in-process from then on
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function failAll(err: Error): void {
	for (const p of pending.values()) { p.reject(err); }
	pending.clear();
}

/** Start loading the converter in a worker thread (idempotent). */
export function startConverter(): Promise<boolean> {
	if (workerBroken) { return Promise.resolve(false); }
	if (ready) { return ready; }
	const t0 = Date.now();
	let started = false;
	ready = new Promise<boolean>(resolve => {
		const fail = (): void => { if (!started) { workerBroken = true; } resolve(false); };
		try {
			const w = new Worker(WORKER_FILE);
			worker = w;
			w.on('message', (msg: { ready?: boolean; id?: number; ok?: boolean; result?: unknown; error?: string }) => {
				if (msg.ready) {
					started = true;
					console.log(`[qoka-timing] aria-notes converter ready in ${Date.now() - t0}ms (worker thread)`);
					resolve(true);
					return;
				}
				const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
				if (!p) { return; }
				pending.delete(msg.id!);
				if (msg.ok) { p.resolve(msg.result); } else { p.reject(new Error(msg.error || 'Conversion failed.')); }
			});
			w.on('error', err => {
				console.error('[aria-notes] converter worker error:', err);
				fail();
				failAll(err instanceof Error ? err : new Error(String(err)));
			});
			w.on('exit', code => {
				if (worker === w) { worker = undefined; ready = undefined; }
				fail();
				failAll(new Error(`The note converter stopped (code ${code}).`));
			});
		} catch (e) {
			console.error('[aria-notes] could not start the converter worker:', e);
			fail();
		}
	});
	return ready;
}

/** Stop the worker (extension deactivation). */
export function stopConverter(): void {
	const w = worker;
	worker = undefined;
	ready = undefined;
	if (w) { void w.terminate(); }
}

function loadInProcess(): InProcess {
	if (!inProcess) {
		const t0 = Date.now();
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		inProcess = require(WORKER_FILE) as InProcess;
		console.log(`[qoka-timing] aria-notes converter loaded in-process (fallback) in ${Date.now() - t0}ms`);
	}
	return inProcess;
}

async function convert<T>(op: Op, arg: unknown): Promise<T> {
	const waitT0 = Date.now();
	const up = await startConverter();
	const waited = Date.now() - waitT0;
	if (waited > 50) { console.log(`[qoka-timing] aria-notes ${op} waited ${waited}ms for the converter`); }
	const w = worker;
	if (up && w) {
		try {
			return await new Promise<T>((resolve, reject) => {
				const id = nextId++;
				pending.set(id, { resolve: v => resolve(v as T), reject });
				w.postMessage({ id, op, arg });
			});
		} catch (e) {
			// The worker died mid-request: fall through to the in-process path.
			console.error('[aria-notes] worker conversion failed, retrying in-process:', e);
		}
	}
	const lib = loadInProcess();
	return (op === 'toMarkdown' ? lib.toMarkdown(arg as unknown[]) : lib.toBlocks(arg as string)) as Promise<T>;
}

export function blocksToMarkdownViaConverter(blocks: unknown[]): Promise<string> {
	return convert<string>('toMarkdown', blocks);
}

export function markdownToBlocksViaConverter(markdown: string): Promise<unknown[]> {
	return convert<unknown[]>('toBlocks', markdown);
}
