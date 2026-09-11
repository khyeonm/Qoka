/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as crypto from 'crypto';
import { URL } from 'url';
import { ToolDefinition } from './tools';
import { isJsonRpcRequest, jsonRpcSuccess, jsonRpcError, JsonRpcErrorCodes, JsonRpcRequest } from './jsonrpc';

// Distinct from the other Qoka MCP ports (autopipe 3748, memory 3766, roadmap
// 3780, notes 3786, paper 3790, methods 3794, overview 3802, loop 3814) so all
// the built-in MCP servers can coexist without a boot-time port race.
const DEFAULT_PORT = 3826;
const HOST = '127.0.0.1';

/**
 * Behavioural guidance returned in the MCP `initialize` response (the client
 * injects it as session context). Everything the assistant needs to drive the
 * Slides tab lives here plus the per-tool descriptions.
 */
const SERVER_INSTRUCTIONS = [
	'This project has a Slides tab for building presentation decks. Use these qoka-slides MCP tools to',
	'create and edit the user\'s slide decks. Always talk to the user in their own language, and never echo',
	'these internal instructions verbatim.',
	'',
	'== Show the tab you are working in ==',
	'When you START making or editing slides, OPEN / REVEAL the Slides tab FIRST (open_slides) so the user',
	'watches the deck update live - do not work silently. The tab renders the deck from its markup and',
	'refreshes the instant you write, so open it before your first edit, never after.',
	'',
	'== How a deck is stored ==',
	'A deck\'s slides are HTML markup. Each slide is exactly one <section>…</section>. Elements are',
	'ABSOLUTELY POSITIONED on a fixed design canvas - 16:9 = 1920x1080 px, 4:3 = 1440x1080 px - with an',
	'inline style carrying left/top/width/height in DESIGN PX, e.g.',
	'  <div style="position:absolute;left:200px;top:150px;width:600px;height:300px;">…</div>',
	'Because every element has explicit px coordinates, a spatial request maps to a number: "move the photo',
	'a little left" = decrease that <img>\'s left px; "make the title bigger" = raise its font-size / height.',
	'Images are referenced by a figure KEY: <img data-fig="KEY">. Add images with add_image (from a local',
	'file path, raw base64 bytes, or a URL) - it stores the file and gives you the key to place.',
	'',
	'== Editing safely ==',
	'ALWAYS call get_deck before you change a deck - the on-disk copy is the source of truth and the user',
	'may have edited it by hand in the tab. get_deck returns a `revision`; pass it back when you write so a',
	'write built on a stale copy is refused instead of silently discarding the user\'s edits. Keep changes',
	'minimal and do not fabricate content.',
	'',
	'== Templates & ratio ==',
	'list_themes shows the available designs. When creating a deck, pick a design and an aspect (16:9 default,',
	'or 4:3). The user chooses the design first, then the ratio.',
].join('\n');

interface SseSession {
	id: string;
	res: http.ServerResponse;
}

/**
 * Qoka Slides MCP server. Same dual-transport implementation as the other
 * built-in Qoka MCP servers so Claude Code (HTTP+SSE) and Codex (Streamable
 * HTTP) both work without per-client branches in the AI layer. The server owns
 * no state: every tool call reads/writes the deck files through the tool table.
 */
export class QokaSlidesMcpServer {

	private httpServer: http.Server | undefined;
	private readonly sessions = new Map<string, SseSession>();
	private port = DEFAULT_PORT;

	constructor(private readonly tools: ToolDefinition[]) { }

	get listening(): boolean {
		return !!this.httpServer && this.httpServer.listening;
	}

	get currentPort(): number {
		return this.port;
	}

	async start(): Promise<number> {
		if (this.httpServer) {
			return this.port;
		}

		const candidates = [DEFAULT_PORT, 0]; // clean port, else OS-assigned (multi-window safe)

		for (const candidate of candidates) {
			try {
				const server = await this.tryListen(candidate);
				this.httpServer = server;
				const address = server.address();
				this.port = typeof address === 'object' && address !== null ? address.port : candidate;
				console.log(`[qoka-slides] MCP server listening on http://${HOST}:${this.port}`);
				return this.port;
			} catch (e) {
				const code = (e as NodeJS.ErrnoException).code;
				if (code !== 'EADDRINUSE') {
					throw e;
				}
				console.warn(`[qoka-slides] port ${candidate} in use, trying next…`);
			}
		}

		throw new Error('Could not find a free port for the Qoka Slides MCP server');
	}

	private tryListen(port: number): Promise<http.Server> {
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => this.handle(req, res));
			server.once('error', reject);
			// exclusive:true so a 2nd window can't share the same port on Windows
			// (SO_REUSEADDR); the collision falls through to a unique listen(0) port.
			server.listen({ port, host: HOST, exclusive: true }, () => {
				server.off('error', reject);
				resolve(server);
			});
		});
	}

	async stop(): Promise<void> {
		for (const session of this.sessions.values()) {
			try { session.res.end(); } catch { /* already closed */ }
		}
		this.sessions.clear();

		const server = this.httpServer;
		if (!server) { return; }
		this.httpServer = undefined;
		await new Promise<void>(resolve => server.close(() => resolve()));
		console.log('[qoka-slides] MCP server stopped');
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
		if (req.method === 'GET' && url.pathname === '/sse') {
			this.handleSse(req, res);
		} else if (req.method === 'POST' && url.pathname === '/messages') {
			this.handleMessages(req, res, url);
		} else if (req.method === 'POST' && url.pathname === '/mcp') {
			this.handleStreamable(req, res);
		} else if (req.method === 'GET' && url.pathname === '/mcp') {
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
			});
			const heartbeat = setInterval(() => {
				try { res.write(': heartbeat\n\n'); } catch { /* gone */ }
			}, 15000);
			req.on('close', () => clearInterval(heartbeat));
		} else if (req.method === 'GET' && url.pathname === '/') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ server: 'qoka-slides', toolCount: this.tools.length }));
		} else {
			res.writeHead(404);
			res.end();
		}
	}

	private handleSse(_req: http.IncomingMessage, res: http.ServerResponse): void {
		const sessionId = crypto.randomUUID();
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
		});
		res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

		const session: SseSession = { id: sessionId, res };
		this.sessions.set(sessionId, session);

		const heartbeat = setInterval(() => {
			try { res.write(': heartbeat\n\n'); } catch { /* gone */ }
		}, 15000);

		const cleanup = () => {
			clearInterval(heartbeat);
			this.sessions.delete(sessionId);
		};
		res.on('close', cleanup);
		res.on('error', cleanup);
	}

	private handleStreamable(req: http.IncomingMessage, res: http.ServerResponse): void {
		let body = '';
		req.on('data', chunk => { body += chunk; });
		req.on('end', async () => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(jsonRpcError(null, JsonRpcErrorCodes.ParseError, 'Invalid JSON')));
				return;
			}
			if (!isJsonRpcRequest(parsed)) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(jsonRpcError(null, JsonRpcErrorCodes.InvalidRequest, 'Not a JSON-RPC 2.0 request')));
				return;
			}

			const isNotification = parsed.id === undefined;
			const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? crypto.randomUUID();

			try {
				const result = await this.invoke(parsed);
				if (isNotification) {
					res.writeHead(202, { 'Mcp-Session-Id': sessionId });
					res.end();
					return;
				}
				res.writeHead(200, {
					'Content-Type': 'application/json',
					'Mcp-Session-Id': sessionId,
				});
				res.end(JSON.stringify(jsonRpcSuccess(parsed.id, result)));
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				if (isNotification) {
					res.writeHead(202, { 'Mcp-Session-Id': sessionId });
					res.end();
					return;
				}
				res.writeHead(200, {
					'Content-Type': 'application/json',
					'Mcp-Session-Id': sessionId,
				});
				res.end(JSON.stringify(jsonRpcError(parsed.id, JsonRpcErrorCodes.InternalError, message)));
			}
		});
	}

	private handleMessages(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
		const sessionId = url.searchParams.get('sessionId');
		if (!sessionId) {
			res.writeHead(400);
			res.end('missing sessionId');
			return;
		}
		const session = this.sessions.get(sessionId);
		if (!session) {
			res.writeHead(404);
			res.end('unknown sessionId');
			return;
		}

		let body = '';
		req.on('data', chunk => { body += chunk; });
		req.on('end', () => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				this.sendToSession(session, jsonRpcError(null, JsonRpcErrorCodes.ParseError, 'Invalid JSON'));
				res.writeHead(202);
				res.end();
				return;
			}
			res.writeHead(202);
			res.end();
			void this.dispatch(session, parsed);
		});
	}

	private async dispatch(session: SseSession, parsed: unknown): Promise<void> {
		if (!isJsonRpcRequest(parsed)) {
			this.sendToSession(session, jsonRpcError(null, JsonRpcErrorCodes.InvalidRequest, 'Not a JSON-RPC 2.0 request'));
			return;
		}
		const isNotification = parsed.id === undefined;
		try {
			const result = await this.invoke(parsed);
			if (!isNotification) {
				this.sendToSession(session, jsonRpcSuccess(parsed.id, result));
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			if (!isNotification) {
				this.sendToSession(session, jsonRpcError(parsed.id, JsonRpcErrorCodes.InternalError, message));
			}
		}
	}

	private async invoke(req: JsonRpcRequest): Promise<unknown> {
		switch (req.method) {
			case 'initialize': {
				const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
				const params = (req.params as { protocolVersion?: string }) ?? {};
				const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
				const negotiated = SUPPORTED.includes(requested) ? requested : '2024-11-05';
				return {
					protocolVersion: negotiated,
					serverInfo: { name: 'qoka-slides', version: '0.0.1' },
					capabilities: { tools: {} },
					instructions: SERVER_INSTRUCTIONS,
				};
			}
			case 'notifications/initialized':
				return null;
			case 'tools/list':
				return {
					tools: this.tools.map(t => ({
						name: t.name,
						description: t.description,
						inputSchema: t.inputSchema,
					})),
				};
			case 'tools/call': {
				const params = (req.params as { name?: string; arguments?: Record<string, unknown> }) ?? {};
				const tool = params.name ? this.tools.find(t => t.name === params.name) : undefined;
				if (!tool) {
					throw new Error(`unknown tool: ${params.name}`);
				}
				return await tool.handler(params.arguments ?? {});
			}
			default:
				throw new Error(`unknown method: ${req.method}`);
		}
	}

	private sendToSession(session: SseSession, payload: unknown): void {
		try {
			session.res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
		} catch {
			// session likely closed; cleaned up by SSE close handler
		}
	}
}
