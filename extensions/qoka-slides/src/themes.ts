/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Theme model, ported from whirick's lib/themes.ts. Theme DEFINITIONS are
// bundled with the extension under themes/<id>/ (theme.json, templates.json,
// theme.css, background assets). This module holds the shared types + the pure
// functions (Theme -> CSS variables / canvas dims) plus a small disk loader.

import * as fs from 'fs';
import * as path from 'path';
import { Aspect } from './storage';

export interface ThemeFonts { head: string; body: string; ui: string; mono: string; }

export interface TemplateBox {
	kind: 'text' | 'image' | 'logo' | 'shape';
	x: number; y: number; w: number; h: number;
	shape?: 'rect' | 'ellipse';
	fill?: string; stroke?: string; strokeWidth?: number; radius?: number;
	text?: string; font?: 'head' | 'body' | 'ui' | 'mono'; size?: number; color?: string;
	align?: 'left' | 'center' | 'right'; valign?: 'top' | 'center' | 'bottom';
	weight?: number; upper?: boolean; tracking?: number; shadow?: string | boolean;
}

export interface Template { id: string; name: string; bg?: string; boxes: TemplateBox[]; }

export interface Theme {
	id: string;
	name: string;
	description: string;
	aspect: Aspect;
	accent: string;
	accentSoft: string;
	foot: string;
	pageNumber: string;
	logo: boolean;
	logoUrl: string | null;
	logoSize: string;
	chromeLogo: boolean;
	fonts: ThemeFonts;
	strip: boolean;
	headSize: string;
	titleSize: string;
	templates: Template[];
	css: string;
}

/** Design-canvas pixel dimensions for an aspect ratio (height fixed). */
export function aspectDims(aspect: string): { w: number; h: number } {
	return aspect === '4:3' ? { w: 1440, h: 1080 } : { w: 1920, h: 1080 };
}

/**
 * Every CSS custom property a theme contributes. Set these on the deck root so
 * the slide CSS renders the theme: canvas size, strip, fonts, sizes and accent.
 * Variable names match whirick's slide.css (the `--pnu-*` names are historical).
 */
export function themeVars(theme: Theme): Record<string, string> {
	const d = aspectDims(theme.aspect);
	return {
		'--pnu-blue': theme.accent,
		'--pnu-blue-soft': theme.accentSoft,
		'--font-head': theme.fonts.head,
		'--font-body': theme.fonts.body,
		'--font-ui': theme.fonts.ui,
		'--font-mono': theme.fonts.mono,
		'--strip-display': theme.strip ? 'block' : 'none',
		'--h1-size': theme.headSize,
		'--title-size': theme.titleSize,
		'--logo-h': theme.logoSize,
		'--canvas-w': d.w + 'px',
		'--canvas-h': d.h + 'px',
		'--cw': d.w / 100 + 'px',
		'--ar-w': String(d.w),
		'--ar-h': String(d.h),
	};
}

interface ThemeJson {
	name?: string; description?: string; aspect?: string;
	accent?: string; accentSoft?: string; foot?: string; pageNumber?: string;
	logo?: string | null; logoSize?: string; chromeLogo?: boolean; strip?: boolean;
	headSize?: string; titleSize?: string; fonts?: Partial<ThemeFonts>;
}

const DEFAULT_FONTS: ThemeFonts = {
	head: '"Source Serif 4", "Noto Serif KR", serif',
	body: '"Source Serif 4", "Noto Serif KR", serif',
	ui: '"Open Sans", "Noto Sans KR", sans-serif',
	mono: '"JetBrains Mono", "Noto Sans KR", monospace',
};

function readJson<T>(p: string): T | undefined {
	try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return undefined; }
}

/** Load one bundled theme by id. `aspect` (from the deck) overrides the theme's own default. */
export function loadTheme(themesRoot: string, id: string, aspect?: Aspect): Theme | undefined {
	const dir = path.join(themesRoot, id);
	const j = readJson<ThemeJson>(path.join(dir, 'theme.json'));
	if (!j) { return undefined; }
	const templates = readJson<Template[]>(path.join(dir, 'templates.json')) ?? [];
	let css = '';
	try { css = fs.readFileSync(path.join(dir, 'theme.css'), 'utf-8'); } catch { /* optional */ }
	const themeAspect = (aspect ?? (j.aspect === '4:3' ? '4:3' : '16:9')) as Aspect;
	return {
		id,
		name: j.name ?? id,
		description: j.description ?? '',
		aspect: themeAspect,
		accent: j.accent ?? '#334155',
		accentSoft: j.accentSoft ?? '#e2e8f0',
		foot: j.foot ?? '',
		pageNumber: j.pageNumber ?? '',
		logo: !!j.logo,
		logoUrl: j.logo ? path.join(dir, j.logo) : null,
		logoSize: j.logoSize ?? '45px',
		chromeLogo: !!j.chromeLogo,
		fonts: { ...DEFAULT_FONTS, ...(j.fonts ?? {}) },
		strip: !!j.strip,
		headSize: j.headSize ?? '44.5741px',
		titleSize: j.titleSize ?? '64.8px',
		templates,
		css,
	};
}

/** List the bundled themes (id, name, default aspect) for the New-deck picker. */
export function listThemes(themesRoot: string): { id: string; name: string; aspect: Aspect }[] {
	let ids: string[] = [];
	try {
		ids = fs.readdirSync(themesRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
	} catch { return []; }
	const out: { id: string; name: string; aspect: Aspect }[] = [];
	for (const id of ids) {
		const t = loadTheme(themesRoot, id);
		if (t) { out.push({ id, name: t.name, aspect: t.aspect }); }
	}
	// Put the plain/blank design first if present.
	return out.sort((a, b) => (a.id === 'plain' ? -1 : b.id === 'plain' ? 1 : a.name.localeCompare(b.name)));
}
