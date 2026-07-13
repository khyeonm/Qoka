/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// BlockNote-based note editor that runs INSIDE a VS Code webview.
// Built by build.mjs (esbuild) into
//   ../src/vs/workbench/contrib/ariaNotes/browser/media/notesEditor.{js,css}
// and loaded by AriaNoteEditorPane.

import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

type Decorations = Record<string, 'add' | 'del'>;

declare function acquireVsCodeApi(): {
	postMessage(msg: unknown): void;
	getState(): unknown;
	setState(s: unknown): void;
};
const vscode = acquireVsCodeApi();

function detectTheme(): 'light' | 'dark' {
	const c = document.body.classList;
	return (c.contains('vscode-light') || c.contains('vscode-high-contrast-light')) ? 'light' : 'dark';
}

/** Follow the VS Code theme — webviews get a `vscode-light` / `vscode-dark` body
 *  class. Easy mode forces the Light Modern theme, so the editor renders light
 *  there instead of the previously hard-coded dark. Re-reads if the theme (or the
 *  easy/advanced mode) changes at runtime. */
function useVsCodeTheme(): 'light' | 'dark' {
	const [theme, setTheme] = useState<'light' | 'dark'>(detectTheme);
	useEffect(() => {
		const observer = new MutationObserver(() => setTheme(detectTheme()));
		observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
		return () => observer.disconnect();
	}, []);
	return theme;
}

function Editor({ blocks, editable, decorations }: { blocks: unknown[]; editable: boolean; decorations?: Decorations }) {
	const editor = useCreateBlockNote({
		initialContent: blocks && blocks.length ? (blocks as never) : undefined,
	});
	const ref = useRef<HTMLDivElement>(null);
	const theme = useVsCodeTheme();

	// Tint changed blocks by data-id (set by the pane). Done in the DOM rather
	// than via BlockNote props so it works for ALL block types — tables, images,
	// etc. don't support a backgroundColor prop. Retries across frames until the
	// blocks have rendered.
	useEffect(() => {
		const root = ref.current;
		if (!root || !decorations) {
			return;
		}
		const entries = Object.entries(decorations);
		if (!entries.length) {
			return;
		}
		let raf = 0;
		let tries = 0;
		const apply = () => {
			let applied = 0;
			for (const [id, kind] of entries) {
				const el = root.querySelector(`[data-id="${id}"]`);
				if (el) {
					el.classList.add(kind === 'del' ? 'aria-review-del' : 'aria-review-add');
					applied++;
				}
			}
			if (applied < entries.length && tries++ < 30) {
				raf = requestAnimationFrame(apply);
			}
		};
		raf = requestAnimationFrame(apply);
		return () => cancelAnimationFrame(raf);
	}, [decorations]);

	return (
		<div ref={ref} style={{ height: '100%' }}>
			<BlockNoteView
				editor={editor}
				theme={theme}
				editable={editable}
				onChange={() => {
					// Read-only preview (a proposal) must never write back.
					if (editable) {
						vscode.postMessage({ type: 'save', blocks: editor.document });
					}
				}}
			/>
		</div>
	);
}

function App() {
	// `rev` bumps on every load so the editor remounts with fresh content
	// (used when switching between the saved note and a proposal preview).
	const [state, setState] = useState<{ blocks: unknown[]; editable: boolean; decorations?: Decorations; rev: number } | null>(null);
	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			const m = e.data;
			if (m && m.type === 'load') {
				setState(prev => ({
					blocks: Array.isArray(m.blocks) ? m.blocks : [],
					editable: m.editable !== false,
					decorations: m.decorations && typeof m.decorations === 'object' ? m.decorations : undefined,
					rev: (prev?.rev ?? 0) + 1,
				}));
			}
		};
		window.addEventListener('message', onMessage);
		vscode.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', onMessage);
	}, []);

	if (!state) {
		return <div style={{ padding: 16, opacity: 0.6, fontFamily: 'sans-serif' }}>Loading…</div>;
	}
	return <Editor key={state.rev} blocks={state.blocks} editable={state.editable} decorations={state.decorations} />;
}

createRoot(document.getElementById('root')!).render(<App />);
