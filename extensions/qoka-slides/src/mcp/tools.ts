/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: unknown;
	handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface CallToolResult {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
}

function ok(text: string): CallToolResult { return { content: [{ type: 'text', text }] }; }
function err(text: string): CallToolResult { return { content: [{ type: 'text', text }], isError: true }; }
function json(value: unknown): CallToolResult { return ok(JSON.stringify(value, null, 2)); }

function asString(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined; }
function asNumber(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }

/** The deck/slide the user currently has open in the whirick web view. */
interface WhirickWebContext { url: string; slug: string | null; slide: number | null }

/**
 * qoka-slides MCP: the bridge between the AI and the Slides tab (whirick web app,
 * embedded in Qoka's integrated browser). Decks themselves live in whirick and are
 * created / edited through whirick's OWN MCP tools; these tools only (a) show a deck
 * in the tab and (b) tell the AI what the user is looking at, so edits land on the
 * right deck and the user watches them live.
 */
export function buildTools(_extensionPath: string): ToolDefinition[] {
	return [
		{
			name: 'open_slides',
			description: [
				'Open / reveal the Slides tab (the whirick web app) in Qoka, optionally navigating it to a',
				'specific deck and slide so the user watches your edits live. Call this BEFORE you start',
				'creating or editing a deck. `slug` is the whirick deck slug (from whirick\'s own MCP, e.g.',
				'list_decks); `slide` is the 1-based slide number to jump to. Omit both to just open the app home.',
			].join(' '),
			inputSchema: {
				type: 'object',
				properties: {
					slug: { type: 'string', description: 'whirick deck slug to open (from whirick MCP).' },
					slide: { type: 'number', description: '1-based slide number to jump to.' },
				},
				additionalProperties: false,
			},
			handler: async (args) => {
				const slug = asString(args.slug);
				const slide = asNumber(args.slide);
				let path = '';
				if (slug) {
					path = `/${encodeURIComponent(slug)}/edit`;
					if (slide && slide >= 1) { path += `#s${Math.floor(slide)}`; }
				}
				try {
					await vscode.commands.executeCommand('qoka.slides.openWeb', path);
					return ok(slug ? `Opened the Slides tab at deck ${slug}${slide ? ` slide ${slide}` : ''}.` : 'Opened the Slides tab.');
				} catch (e) {
					return err((e as Error).message);
				}
			},
		},
		{
			name: 'get_current_slides',
			description: [
				'Report what the user currently has open in the Slides tab (the whirick web app): the deck',
				'`slug` and the 1-based `slide` number, plus the raw `url`. Use this when the user says "this',
				'deck" / "the slide I\'m looking at" without naming one, so you act on what they actually see.',
				'Returns { open: false } when no Slides tab is open (then ask which deck, or use whirick\'s',
				'list_decks). `slug` is null on a non-deck page (the home / create screens).',
			].join(' '),
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				try {
					const ctx = await vscode.commands.executeCommand<WhirickWebContext | null>('qoka.slides.getWebContext');
					if (!ctx) { return json({ open: false }); }
					return json({ open: true, slug: ctx.slug, slide: ctx.slide, url: ctx.url });
				} catch (e) {
					return err((e as Error).message);
				}
			},
		},
	];
}
