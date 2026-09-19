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
interface WhirickWebContext { url: string; slug: string | null; slide: number | null; loginRequired: boolean }

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
				'creating or editing a deck - but ONLY once you already have whirick\'s own deck tools; if the user',
				'wants slides and those tools are absent, call connect_whirick FIRST instead of this. `slug` is the',
				'whirick deck slug (from whirick\'s own MCP, e.g. list_decks); `slide` is the 1-based slide number to',
				'jump to. Omit both to just open the app home.',
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
				'`slug`, the 1-based `slide` number, the raw `url`, and `loginRequired`. Use this when the user',
				'says "this deck" / "the slide I\'m looking at" without naming one, so you act on what they actually',
				'see, AND at the START of any slide task to check `loginRequired`. Returns { open: false } when no',
				'Slides tab is open. `slug` is null on a non-deck page (home / create / login screens).',
				'`loginRequired: true` means the tab is on whirick\'s login page - the user is NOT signed in to the',
				'Slides tab yet, so decks cannot be shown or built; guide them to log in and wait (see below).',
			].join(' '),
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				try {
					const ctx = await vscode.commands.executeCommand<WhirickWebContext | null>('qoka.slides.getWebContext');
					if (!ctx) { return json({ open: false }); }
					return json({ open: true, slug: ctx.slug, slide: ctx.slide, url: ctx.url, loginRequired: ctx.loginRequired });
				} catch (e) {
					return err((e as Error).message);
				}
			},
		},
		{
			name: 'connect_whirick',
			description: [
				'Connects Codex to whirick, the slide app that actually builds slides. CALL THIS FIRST, before',
				'anything else, the moment the user asks to make or edit slides UNLESS you already have whirick\'s',
				'own deck tools (create_deck / add_slide / update_slide) in this session. Slides can ONLY be made',
				'through whirick - you cannot make a slide by writing its text in chat - so if those whirick tools',
				'are absent you MUST call connect_whirick immediately: do NOT ask about topic/audience/length, do',
				'NOT write any slide content, do NOT call open_slides. It registers whirick with Codex; a whirick',
				'sign-in popup then appears to approve, plus a one-time "Reload Window" prompt to reload. Relay the',
				'returned status message to the user verbatim, then STOP (no loop, no slide content) until they',
				'approve, reload, and ask again. (Codex only - Claude authorises via /mcp.)',
			].join(' '),
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				try {
					const res = await vscode.commands.executeCommand<{ status?: string; reloadOffered?: boolean }>('aria.slides.connectWhirickCodex');
					return json(res ?? { status: 'No response from the connection setup.' });
				} catch (e) {
					return err((e as Error).message);
				}
			},
		},
	];
}
