/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMainThread, parentPort } from 'worker_threads';
import { ServerBlockNoteEditor } from '@blocknote/server-util';

/**
 * Markdown <-> BlockNote conversion, bundled SEPARATELY from the extension
 * (out/convertWorker.js). @blocknote/server-util and its jsdom backend are large;
 * loading them in the extension host at activation held up Qoka's startup by 5-12s.
 * The extension now runs this file in a worker thread (see converter.ts), so the load
 * happens off the extension host's thread. If a worker cannot be started, the
 * extension require()s this same file in-process and calls the exports directly.
 *
 * Only AI-facing note tools convert: the Notes editor reads and writes blocks itself.
 */

let editor: ServerBlockNoteEditor | undefined;
function getEditor(): ServerBlockNoteEditor {
	if (!editor) {
		editor = ServerBlockNoteEditor.create();
	}
	return editor;
}

export async function toMarkdown(blocks: unknown[]): Promise<string> {
	return getEditor().blocksToMarkdownLossy(blocks as never);
}

export async function toBlocks(markdown: string): Promise<unknown[]> {
	return (await getEditor().tryParseMarkdownToBlocks(markdown)) as unknown[];
}

interface Request { id: number; op: 'toMarkdown' | 'toBlocks'; arg: unknown }

if (!isMainThread && parentPort) {
	const port = parentPort;
	port.on('message', async (req: Request) => {
		try {
			const result = req.op === 'toMarkdown'
				? await toMarkdown(req.arg as unknown[])
				: await toBlocks(req.arg as string);
			port.postMessage({ id: req.id, ok: true, result });
		} catch (e) {
			port.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
		}
	});
	getEditor();
	port.postMessage({ ready: true });
}
