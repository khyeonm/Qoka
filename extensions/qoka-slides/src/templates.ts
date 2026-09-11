/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Slide-template renderer, ported from whirick's lib/templates.ts. A template
// (JSON layout spec from a theme's templates.json) is turned into slide HTML:
// absolutely-positioned text / image / shape boxes on the theme's canvas.
// Percentage coordinates resolve to design px using the theme's aspect, so one
// spec works at 16:9 or 4:3. Used by the New-deck seeder + MCP create_deck.

import { aspectDims, Theme, Template, TemplateBox } from './themes';

const COLORS: Record<string, string> = {
	ink: 'var(--text)',
	muted: 'var(--muted)',
	accent: 'var(--pnu-blue)',
	white: '#ffffff',
	surface: 'var(--bg)',
};

function color(c: string | undefined): string {
	if (!c) { return 'var(--text)'; }
	return COLORS[c] ?? c; // fall through to a literal (e.g. #rrggbb)
}

/** slide-inner background style. Supports a colour role/literal or an
 *  `asset:<file>` reference to a theme image (full-bleed cover). The
 *  `/themes/<id>/<file>` URL is rewritten to a webview URI by the panel. */
function bgStyle(bg: string | undefined, themeId: string): string {
	if (!bg || bg === 'surface') { return ''; }
	if (bg.startsWith('asset:')) {
		const file = bg.slice(6);
		return ` style="background:url(/themes/${themeId}/${encodeURIComponent(file)}) center/cover no-repeat"`;
	}
	return ` style="background:${COLORS[bg] ?? bg}"`;
}

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 1% of a slide's text area, in design px - the scale slide.css publishes as
// --ch. A cover has no vertical padding, so its 1% is the full 1080/100.
const CH_UNIT = { content: 10.1304688, title: 10.8 };

function renderBox(b: TemplateBox, CW: number, CH: number, theme: Theme, chUnit: number): string {
	const L = Math.round((b.x / 100) * CW);
	const T = Math.round((b.y / 100) * CH);
	const W = Math.round((b.w / 100) * CW);
	const H = Math.round((b.h / 100) * CH);
	const pos = `position:absolute;left:${L}px;top:${T}px;width:${W}px;height:${H}px;`;

	if (b.kind === 'image') { return `<div class="img-ph free" style="${pos}"></div>`; }

	if (b.kind === 'shape') {
		const ellipse = b.shape === 'ellipse';
		const fill = !b.fill || b.fill === 'none' ? 'transparent' : color(b.fill);
		const sw = b.strokeWidth ?? 0;
		const radius = ellipse ? '50%' : `${b.radius ?? 0}px`;
		let s = pos + `background:${fill};border-radius:${radius};`;
		if (sw > 0) { s += `border:${sw}px solid ${color(b.stroke ?? 'ink')};`; }
		return `<div class="shape free" data-shape="${ellipse ? 'ellipse' : 'rect'}" style="${s}"></div>`;
	}

	if (b.kind === 'logo') {
		if (!theme.logoUrl) { return ''; }
		return `<img class="free" src="${theme.logoUrl}" alt="" style="${pos}object-fit:contain;" />`;
	}

	let s = pos;
	s += `font-family:var(--font-${b.font ?? 'body'});`;
	if (b.size) { s += `font-size:${Math.round(b.size * chUnit * 10000) / 10000}px;`; }
	s += `color:${color(b.color ?? 'ink')};`;
	s += `text-align:${b.align ?? 'left'};`;
	if (b.weight) { s += `font-weight:${b.weight};`; }
	if (b.tracking) { s += `letter-spacing:${b.tracking}em;`; }
	if (b.upper) { s += `text-transform:uppercase;`; }
	if (b.shadow) {
		s += `text-shadow:${typeof b.shadow === 'string' ? b.shadow : '1.52px 2.53px 4.05px rgba(0,0,0,0.6)'};`;
	}
	if (b.valign === 'center') { s += `display:flex;flex-direction:column;justify-content:center;`; }
	else if (b.valign === 'bottom') { s += `display:flex;flex-direction:column;justify-content:flex-end;`; }
	s += `line-height:1.3;`;
	const text = esc(b.text ?? '').replace(/\n/g, '<br>');
	return `<div class="tbox free" style="${s}">${text}</div>`;
}

/** Title-like templates carry no page chrome (logo/number/footer) or top strip. */
function isBare(tpl: Template): boolean {
	return tpl.id === 'title' || tpl.id === 'chapter';
}

/** Render one template into a <section class="slide"> for the given theme. */
export function renderTemplate(tpl: Template, theme: Theme): string {
	const { w: CW, h: CH } = aspectDims(theme.aspect);
	const cls = isBare(tpl) ? 'slide title' : 'slide';
	const layoutAttr = ` data-layout="${tpl.id}"`;
	const bg = bgStyle(tpl.bg, theme.id);
	const chUnit = isBare(tpl) ? CH_UNIT.title : CH_UNIT.content;
	const boxes = tpl.boxes.map(b => renderBox(b, CW, CH, theme, chUnit)).join('');
	return `<section class="${cls}"${layoutAttr}><div class="slide-inner"${bg}>${boxes}</div></section>`;
}

export function getTemplate(theme: Theme, id: string): Template | undefined {
	return theme.templates.find(t => t.id === id);
}

/** Seed markup for a brand-new deck: the theme's title slide + a text slide. */
export function seedDeckXml(theme: Theme): string {
	const title = getTemplate(theme, 'title') ?? theme.templates[0];
	const text = getTemplate(theme, 'text');
	const parts = title ? [renderTemplate(title, theme)] : [];
	if (text) { parts.push(renderTemplate(text, theme)); }
	return parts.join('\n') || '<section class="slide"><div class="slide-inner"></div></section>';
}
