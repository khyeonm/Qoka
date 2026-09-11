/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Slides editor webview: render a deck live, and (in Edit mode) let the user
// select / move / resize / retype elements directly, with autosave + undo. The
// deck stays the single source of truth: every edit serialises the cleaned
// markup back to the extension, which writes text.xml (own-write suppressed so
// the file watcher does not clobber the in-progress edit).
(function () {
	const vscode = acquireVsCodeApi();
	const $ = (id) => document.getElementById(id);
	const deckEl = $('deck');
	const frameEl = $('frame');
	const state = { canvas: { w: 1920, h: 1080 }, idx: 0, scale: 1, editing: false };
	const undoStack = [];
	let selected = null;
	let saveTimer = null;

	window.addEventListener('message', (e) => {
		const m = e.data || {};
		if (m.type === 'deck') { renderDeck(m); }
	});

	function renderDeck(m) {
		state.canvas = m.canvas || state.canvas;
		$('deck-title').textContent = m.title || '';
		$('empty').hidden = true;
		// Set theme vars on :root so both the stage and the filmstrip thumbnails inherit them.
		for (const [k, v] of Object.entries(m.themeVars || {})) { document.documentElement.style.setProperty(k, v); }
		let styleEl = document.getElementById('theme-css');
		if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'theme-css'; document.head.appendChild(styleEl); }
		styleEl.textContent = m.themeCss || '';
		deckEl.innerHTML = m.html || '';
		deckEl.querySelectorAll('img[data-fig]').forEach((im) => {
			const u = (m.figures || {})[im.dataset.fig];
			if (u) { im.setAttribute('src', u); }
		});
		addPageNumbers();
		selected = null;
		undoStack.length = 0;
		const count = deckEl.querySelectorAll('.slide').length;
		if (!count) { $('empty').textContent = 'This deck has no slides yet.'; $('empty').hidden = false; }
		layout();
		show(Math.min(state.idx, Math.max(0, count - 1)));
		buildFilmstrip();
	}

	function buildFilmstrip() {
		const strip = $('filmstrip');
		if (!strip) { return; }
		strip.textContent = '';
		const cw = state.canvas.w, ch = state.canvas.h;
		const thumbW = 104, thumbScale = thumbW / cw;
		slides().forEach((s, i) => {
			const t = document.createElement('div');
			t.className = 'thumb';
			t.style.width = thumbW + 'px';
			t.style.height = (ch * thumbScale) + 'px';
			const inner = s.querySelector('.slide-inner');
			if (inner) {
				const clone = inner.cloneNode(true);
				clone.style.setProperty('--scale', String(thumbScale));
				t.appendChild(clone);
			}
			const n = document.createElement('span');
			n.className = 'thumb-n';
			n.textContent = String(i + 1);
			t.appendChild(n);
			t.addEventListener('click', () => show(i));
			strip.appendChild(t);
		});
		updateFilmstripActive();
	}

	function updateFilmstripActive() {
		const strip = $('filmstrip');
		if (!strip) { return; }
		Array.from(strip.children).forEach((t, i) => t.classList.toggle('active', i === state.idx));
	}

	// Page numbers: a render-time overlay (class qk-chrome, stripped on save) on
	// every content slide, so they show in the editor / thumbnails / slideshow
	// without being baked into the markup.
	function addPageNumbers() {
		const all = deckEl.querySelectorAll('.slide');
		const total = all.length;
		all.forEach((s, i) => {
			if (s.classList.contains('title')) { return; }
			const inner = s.querySelector('.slide-inner');
			if (!inner) { return; }
			const pn = document.createElement('div');
			pn.className = 'qk-chrome';
			pn.textContent = (i + 1) + ' / ' + total;
			Object.assign(pn.style, { position: 'absolute', right: '38px', bottom: '20px', fontSize: '21px', fontFamily: 'var(--font-ui)', color: 'var(--pnu-blue, #555)', opacity: '0.75', pointerEvents: 'none' });
			inner.appendChild(pn);
		});
	}

	function slides() { return deckEl.querySelectorAll('.slide'); }
	function currentInner() { const s = slides()[state.idx]; return s ? s.querySelector('.slide-inner') : null; }

	function layout() {
		const cw = state.canvas.w, ch = state.canvas.h;
		const fw = Math.max(50, frameEl.clientWidth - 24);
		const fh = Math.max(50, frameEl.clientHeight - 24);
		state.scale = Math.max(0.02, Math.min(fw / cw, fh / ch));
		slides().forEach((s) => {
			s.style.width = (cw * state.scale) + 'px';
			s.style.height = (ch * state.scale) + 'px';
			const inner = s.querySelector('.slide-inner');
			if (inner) { inner.style.setProperty('--scale', String(state.scale)); }
		});
		if (selected) { positionOverlay(); }
	}

	function show(i) {
		const list = slides();
		if (!list.length) { $('counter').textContent = ''; return; }
		state.idx = Math.max(0, Math.min(i, list.length - 1));
		list.forEach((s, k) => { s.style.display = k === state.idx ? 'block' : 'none'; });
		$('counter').textContent = (state.idx + 1) + ' / ' + list.length;
		deselect();
		if (state.editing) { armEditing(); }
		updateFilmstripActive();
	}

	// --- edit mode -----------------------------------------------------------
	const overlay = $('overlay');
	const handle = $('handle');

	function setEditing(on) {
		state.editing = on;
		document.body.classList.toggle('editing', on);
		$('editBtn').textContent = on ? 'Done' : 'Edit';
		deselect();
		if (on) { armEditing(); }
	}

	function armEditing() {
		const inner = currentInner();
		if (!inner) { return; }
		inner.querySelectorAll(':scope > *').forEach((el) => {
			if (el.classList.contains('qk-chrome')) { return; }
			if (el.__armed) { return; }
			el.__armed = true;
			el.addEventListener('pointerdown', (e) => onElementPointerDown(e, el));
			el.addEventListener('dblclick', () => beginTextEdit(el));
		});
	}

	function onElementPointerDown(e, el) {
		if (!state.editing) { return; }
		if (el.getAttribute('contenteditable') === 'true') { return; }
		e.preventDefault();
		select(el);
		const startX = e.clientX, startY = e.clientY;
		const left = parseFloat(el.style.left) || 0, top = parseFloat(el.style.top) || 0;
		snapshot();
		const onMove = (ev) => {
			const dx = (ev.clientX - startX) / state.scale;
			const dy = (ev.clientY - startY) / state.scale;
			el.style.left = Math.round(left + dx) + 'px';
			el.style.top = Math.round(top + dy) + 'px';
			positionOverlay();
		};
		const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); scheduleSave(); };
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	function onHandlePointerDown(e) {
		if (!selected) { return; }
		e.preventDefault(); e.stopPropagation();
		const el = selected;
		const startX = e.clientX, startY = e.clientY;
		const w = parseFloat(el.style.width) || el.offsetWidth, h = parseFloat(el.style.height) || el.offsetHeight;
		snapshot();
		const onMove = (ev) => {
			const dx = (ev.clientX - startX) / state.scale;
			const dy = (ev.clientY - startY) / state.scale;
			el.style.width = Math.max(8, Math.round(w + dx)) + 'px';
			el.style.height = Math.max(8, Math.round(h + dy)) + 'px';
			positionOverlay();
		};
		const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); scheduleSave(); };
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}
	handle.addEventListener('pointerdown', onHandlePointerDown);

	function select(el) {
		selected = el;
		overlay.hidden = false;
		positionOverlay();
	}
	function deselect() { selected = null; overlay.hidden = true; }
	function positionOverlay() {
		if (!selected) { return; }
		const r = selected.getBoundingClientRect();
		const fr = frameEl.getBoundingClientRect();
		overlay.style.left = (r.left - fr.left) + 'px';
		overlay.style.top = (r.top - fr.top) + 'px';
		overlay.style.width = r.width + 'px';
		overlay.style.height = r.height + 'px';
	}

	function beginTextEdit(el) {
		if (!state.editing) { return; }
		if (!el.classList.contains('tbox') && el.tagName !== 'DIV') { return; }
		if (el.querySelector('img')) { return; }
		snapshot();
		el.setAttribute('contenteditable', 'true');
		el.focus();
		const finish = () => { el.removeAttribute('contenteditable'); el.removeEventListener('blur', finish); scheduleSave(); };
		el.addEventListener('blur', finish);
	}

	// --- serialize / autosave / undo -----------------------------------------
	function cleanMarkup() {
		const clone = deckEl.cloneNode(true);
		clone.querySelectorAll('.slide').forEach((s) => { s.style.removeProperty('width'); s.style.removeProperty('height'); s.style.removeProperty('display'); if (!s.getAttribute('style')) { s.removeAttribute('style'); } });
		clone.querySelectorAll('.slide-inner').forEach((si) => { si.style.removeProperty('--scale'); if (!si.getAttribute('style')) { si.removeAttribute('style'); } });
		clone.querySelectorAll('img[data-fig]').forEach((im) => im.removeAttribute('src'));
		clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
		clone.querySelectorAll('.qk-chrome').forEach((el) => el.remove());
		return clone.innerHTML;
	}

	function snapshot() { undoStack.push(cleanMarkup()); if (undoStack.length > 50) { undoStack.shift(); } }

	function scheduleSave() {
		if (saveTimer) { clearTimeout(saveTimer); }
		saveTimer = setTimeout(() => { saveTimer = null; vscode.postMessage({ type: 'save', html: cleanMarkup() }); }, 250);
	}

	function undo() {
		if (!undoStack.length) { return; }
		const html = undoStack.pop();
		const idx = state.idx;
		deckEl.innerHTML = html;
		deckEl.querySelectorAll('.slide-inner > *').forEach((el) => { el.__armed = false; });
		layout();
		state.idx = idx;
		show(idx);
		vscode.postMessage({ type: 'save', html: cleanMarkup() });
	}

	// --- toolbar / nav / present ---------------------------------------------
	$('prev').addEventListener('click', () => show(state.idx - 1));
	$('next').addEventListener('click', () => show(state.idx + 1));
	$('editBtn').addEventListener('click', () => setEditing(!state.editing));
	$('present').addEventListener('click', () => { setEditing(false); document.body.classList.toggle('present'); layout(); });
	frameEl.addEventListener('pointerdown', (e) => { if (state.editing && e.target === frameEl) { deselect(); } });
	window.addEventListener('resize', layout);
	window.addEventListener('keydown', (e) => {
		if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
		if (document.querySelector('[contenteditable="true"]')) { return; }
		if (e.key === 'ArrowRight' || e.key === 'PageDown') { show(state.idx + 1); }
		else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { show(state.idx - 1); }
		else if (e.key === 'Escape') { if (document.body.classList.contains('present')) { document.body.classList.remove('present'); layout(); } else { deselect(); } }
	});

	vscode.postMessage({ type: 'ready' });
}());
