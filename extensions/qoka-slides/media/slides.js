/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Slides tab webview app. Renders a deck (sections from text.xml) live: applies
// the theme CSS variables, resolves data-fig images, scales each slide to fit
// the frame, and navigates one slide at a time (with a slideshow mode). Deck
// creation / selection / deletion round-trip to the extension.
(function () {
	const vscode = acquireVsCodeApi();
	const $ = (id) => document.getElementById(id);
	const deckEl = $('deck');
	const frameEl = $('frame');

	const state = { decks: [], themes: [], slug: null, canvas: { w: 1920, h: 1080 }, idx: 0 };

	window.addEventListener('message', (e) => {
		const m = e.data || {};
		if (m.type === 'decks') { state.themes = m.themes || state.themes; renderList(m.decks || [], m.selected); }
		else if (m.type === 'themes') { state.themes = m.themes || []; }
		else if (m.type === 'deck') { renderDeck(m); }
		else if (m.type === 'error') { console.error('[qoka-slides]', m.message); }
	});

	function renderList(decks, selected) {
		state.decks = decks;
		const ul = $('deck-list');
		ul.textContent = '';
		for (const d of decks) {
			const li = document.createElement('li');
			li.dataset.slug = d.slug;
			if (d.slug === (selected || state.slug)) { li.classList.add('active'); }
			const name = document.createElement('span');
			name.className = 'name';
			name.textContent = d.title;
			li.appendChild(name);
			const del = document.createElement('button');
			del.type = 'button';
			del.className = 'del';
			del.title = 'Delete deck';
			del.textContent = '×';
			del.addEventListener('click', (ev) => { ev.stopPropagation(); vscode.postMessage({ type: 'deleteDeck', slug: d.slug }); });
			li.appendChild(del);
			li.addEventListener('click', () => selectDeck(d.slug));
			ul.appendChild(li);
		}
		$('empty').hidden = !!state.slug && decks.some((d) => d.slug === state.slug);
	}

	function selectDeck(slug) {
		state.slug = slug;
		for (const li of document.querySelectorAll('#deck-list li')) {
			li.classList.toggle('active', li.dataset.slug === slug);
		}
		vscode.postMessage({ type: 'selectDeck', slug });
	}

	function renderDeck(m) {
		state.slug = m.slug;
		state.canvas = m.canvas || state.canvas;
		$('deck-title').textContent = m.title || '';
		$('empty').hidden = true;

		for (const [k, v] of Object.entries(m.themeVars || {})) { deckEl.style.setProperty(k, v); }
		let styleEl = document.getElementById('theme-css');
		if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'theme-css'; document.head.appendChild(styleEl); }
		styleEl.textContent = m.themeCss || '';

		deckEl.innerHTML = m.html || '';
		deckEl.querySelectorAll('img[data-fig]').forEach((im) => {
			const u = (m.figures || {})[im.dataset.fig];
			if (u) { im.setAttribute('src', u); }
		});

		const count = deckEl.querySelectorAll('.slide').length;
		layout();
		show(Math.min(state.idx, Math.max(0, count - 1)));
	}

	function layout() {
		const cw = state.canvas.w, ch = state.canvas.h;
		const fw = Math.max(50, frameEl.clientWidth - 24);
		const fh = Math.max(50, frameEl.clientHeight - 24);
		const scale = Math.max(0.02, Math.min(fw / cw, fh / ch));
		deckEl.querySelectorAll('.slide').forEach((s) => {
			s.style.width = (cw * scale) + 'px';
			s.style.height = (ch * scale) + 'px';
			const inner = s.querySelector('.slide-inner');
			if (inner) { inner.style.setProperty('--scale', String(scale)); }
		});
	}

	function show(i) {
		const slides = deckEl.querySelectorAll('.slide');
		if (!slides.length) { $('counter').textContent = ''; return; }
		state.idx = Math.max(0, Math.min(i, slides.length - 1));
		slides.forEach((s, k) => { s.style.display = k === state.idx ? 'block' : 'none'; });
		$('counter').textContent = (state.idx + 1) + ' / ' + slides.length;
	}

	$('prev').addEventListener('click', () => show(state.idx - 1));
	$('next').addEventListener('click', () => show(state.idx + 1));
	$('present').addEventListener('click', () => { document.body.classList.toggle('present'); layout(); });
	window.addEventListener('resize', layout);
	window.addEventListener('keydown', (e) => {
		if (e.key === 'ArrowRight' || e.key === 'PageDown') { show(state.idx + 1); }
		else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { show(state.idx - 1); }
		else if (e.key === 'Escape') { document.body.classList.remove('present'); layout(); }
	});

	// --- New deck dialog -----------------------------------------------------
	$('new-btn').addEventListener('click', openNew);
	$('nd-cancel').addEventListener('click', () => { $('newdlg').hidden = true; });
	$('nd-create').addEventListener('click', () => {
		const title = $('nd-title').value.trim() || 'Untitled';
		const theme = (document.querySelector('#nd-themes .sel') || {}).dataset ? document.querySelector('#nd-themes .sel').dataset.theme : 'plain';
		const ratio = (document.querySelector('#nd-ratio .sel') || {}).dataset ? document.querySelector('#nd-ratio .sel').dataset.ratio : '16:9';
		$('newdlg').hidden = true;
		vscode.postMessage({ type: 'newDeck', title, theme: theme || 'plain', aspect: ratio || '16:9' });
	});

	function openNew() {
		const box = $('nd-themes');
		box.textContent = '';
		(state.themes || []).forEach((t, i) => {
			const b = document.createElement('button');
			b.type = 'button';
			b.textContent = t.name;
			b.dataset.theme = t.id;
			if (i === 0) { b.classList.add('sel'); }
			b.addEventListener('click', () => {
				box.querySelectorAll('button').forEach((x) => x.classList.remove('sel'));
				b.classList.add('sel');
			});
			box.appendChild(b);
		});
		document.querySelectorAll('#nd-ratio button').forEach((b) => {
			b.addEventListener('click', () => {
				document.querySelectorAll('#nd-ratio button').forEach((x) => x.classList.remove('sel'));
				b.classList.add('sel');
			});
		});
		$('nd-title').value = '';
		$('newdlg').hidden = false;
		$('nd-title').focus();
	}

	vscode.postMessage({ type: 'ready' });
}());
