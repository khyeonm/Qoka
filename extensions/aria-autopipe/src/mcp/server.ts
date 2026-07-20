/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as crypto from 'crypto';
import { URL } from 'url';
import { ToolDefinition } from './tools';
import { isJsonRpcRequest, jsonRpcSuccess, jsonRpcError, JsonRpcErrorCodes, JsonRpcRequest } from './jsonrpc';

const HOST = '127.0.0.1';

interface SseSession {
	id: string;
	res: http.ServerResponse;
}

/**
 * Minimal MCP HTTP server. Implements BOTH MCP transports so we can serve
 * the two AI clients that have different protocol expectations:
 *
 *   1) HTTP+SSE (protocol 2024-11-05) - Claude Code
 *      GET  /sse                  - SSE stream. First event is `endpoint` with
 *                                   the message URL (`/messages?sessionId=...`).
 *                                   Subsequent events are `message` with JSON-RPC.
 *      POST /messages?sessionId=X - JSON-RPC requests; response is delivered
 *                                   asynchronously via the SSE stream.
 *
 *   2) Streamable HTTP (protocol 2025-03-26) - Codex
 *      POST /mcp                  - JSON-RPC request body. Response is returned
 *                                   inline as JSON (Content-Type application/json),
 *                                   not via SSE. `Mcp-Session-Id` header on
 *                                   initialize / required on subsequent requests.
 *
 * MCP methods handled (same set for both transports):
 *   initialize    - server info + capabilities
 *   tools/list    - array of every tool's name/description/inputSchema
 *   tools/call    - invoke a tool by name with arguments
 *
 * Notifications (`notifications/initialized`, etc.) are accepted silently -
 * MCP uses them to signal lifecycle but no client work is required here.
 */
export interface McpServerOptions {
	/** serverInfo.name + the name the AI client registers/shows. */
	name: string;
	/** Tools this server exposes. */
	tools: ToolDefinition[];
	/** Preferred listen port; falls back through the next few on EADDRINUSE. */
	defaultPort: number;
	/** Optional server-level guidance surfaced to the model at `initialize`. */
	instructions?: string;
}

export class QokaMcpServer {

	private httpServer: http.Server | undefined;
	private readonly sessions = new Map<string, SseSession>();
	private port: number;

	constructor(private readonly opts: McpServerOptions) {
		this.port = opts.defaultPort;
	}

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

		// Try the default port first, then fall back through a small range.
		// 3748 is autopipe-app's port - when the user has the Tauri app open
		// at the same time we'd otherwise crash with EADDRINUSE.
		const base = this.opts.defaultPort;
		const candidates = [base, base + 1, base + 2, base + 3, base + 4, base + 5, 0 /* OS-assigned */];

		for (const candidate of candidates) {
			try {
				const server = await this.tryListen(candidate);
				this.httpServer = server;
				const address = server.address();
				this.port = typeof address === 'object' && address !== null ? address.port : candidate;
				console.log(`[aria-autopipe] MCP server listening on http://${HOST}:${this.port}`);
				return this.port;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== 'EADDRINUSE') {
					throw err;
				}
				// Port taken; try the next one. Most likely cause is the
				// autopipe-app Tauri build holding 3748.
				console.warn(`[aria-autopipe] port ${candidate} in use, trying next…`);
			}
		}

		throw new Error('Could not find a free port for the Qoka Autopipe MCP server');
	}

	private tryListen(port: number): Promise<http.Server> {
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => this.handle(req, res));
			server.once('error', reject);
			server.listen(port, HOST, () => {
				server.off('error', reject);
				resolve(server);
			});
		});
	}

	async stop(): Promise<void> {
		for (const session of this.sessions.values()) {
			try {
				session.res.end();
			} catch {
				// already closed
			}
		}
		this.sessions.clear();

		const server = this.httpServer;
		if (!server) {
			return;
		}
		this.httpServer = undefined;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		console.log('[aria-autopipe] MCP server stopped');
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
		if (req.method === 'GET' && url.pathname === '/sse') {
			this.handleSse(req, res);
		} else if (req.method === 'POST' && url.pathname === '/messages') {
			this.handleMessages(req, res, url);
		} else if (req.method === 'POST' && url.pathname === '/mcp') {
			// Streamable HTTP transport (Codex). Single endpoint, synchronous
			// JSON response - no separate /sse stream needed.
			this.handleStreamable(req, res);
		} else if (req.method === 'GET' && url.pathname === '/mcp') {
			// Streamable HTTP supports a GET on the same endpoint for
			// server-initiated messages. We don't push anything proactively,
			// so a long-lived 200 with no body is enough to keep the client
			// happy.
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
			});
			// Keep-alive ping so proxies don't drop it.
			const heartbeat = setInterval(() => {
				try { res.write(': heartbeat\n\n'); } catch { /* gone */ }
			}, 15000);
			req.on('close', () => clearInterval(heartbeat));
		} else if (req.method === 'GET' && url.pathname === '/') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ server: this.opts.name, toolCount: this.opts.tools.length }));
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

		// The MCP HTTP+SSE transport expects the server's first event to be
		// the message endpoint, so the client knows where to POST requests.
		res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

		const session: SseSession = { id: sessionId, res };
		this.sessions.set(sessionId, session);

		// Heartbeat so proxies don't drop the connection. SSE comments are
		// any line that starts with a colon - clients ignore them.
		const heartbeat = setInterval(() => {
			try {
				res.write(': heartbeat\n\n');
			} catch {
				// connection closed; cleanup below fires
			}
		}, 15000);

		const cleanup = () => {
			clearInterval(heartbeat);
			this.sessions.delete(sessionId);
		};
		res.on('close', cleanup);
		res.on('error', cleanup);
	}

	/**
	 * Streamable HTTP transport (MCP 2025-03-26).
	 *
	 * One POST = one JSON-RPC request; response is returned inline as JSON
	 * (or 202 No Content for notifications). Mcp-Session-Id is generated on
	 * the initialize response and echoed back on subsequent requests, but
	 * we don't validate session contents - Qoka runs single-user.
	 */
	private handleStreamable(req: http.IncomingMessage, res: http.ServerResponse): void {
		let body = '';
		req.on('data', (chunk) => { body += chunk; });
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
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
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
		req.on('data', (chunk) => { body += chunk; });
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

			// Ack the POST immediately - the actual JSON-RPC response is
			// delivered over the SSE stream for the same session.
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

		// Notifications have no `id`; per the JSON-RPC spec we do not respond
		// to them. MCP sends `notifications/initialized` after handshake.
		const isNotification = parsed.id === undefined;

		try {
			const result = await this.invoke(parsed);
			if (!isNotification) {
				this.sendToSession(session, jsonRpcSuccess(parsed.id, result));
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!isNotification) {
				this.sendToSession(session, jsonRpcError(parsed.id, JsonRpcErrorCodes.InternalError, message));
			}
		}
	}

	private async invoke(req: JsonRpcRequest): Promise<unknown> {
		switch (req.method) {
			case 'initialize': {
				// Echo the client's requested protocol version if it is one
				// we support. Claude Code sends 2024-11-05 over HTTP+SSE;
				// Codex sends 2025-03-26 over Streamable HTTP. We speak
				// both, so we mirror whatever the client asked for.
				const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
				const params = (req.params as { protocolVersion?: string }) ?? {};
				const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
				const negotiated = SUPPORTED.includes(requested) ? requested : '2024-11-05';
				return {
					protocolVersion: negotiated,
					// `name` is what AI clients show alongside the tool list.
					// Matches the `claude mcp add` registration name so the
					// two strings the user sees ("autopipe MCP" / "autopipe
					// tools") are consistent.
					serverInfo: { name: this.opts.name, version: '0.0.1' },
					capabilities: { tools: {} },
					...(this.opts.instructions ? { instructions: this.opts.instructions } : {}),
				};
			}
			case 'notifications/initialized':
				return null;
			case 'tools/list':
				return {
					tools: this.opts.tools.map(t => ({
						name: t.name,
						description: t.description,
						inputSchema: t.inputSchema,
					})),
				};
			case 'tools/call': {
				const params = (req.params as { name?: string; arguments?: Record<string, unknown> }) ?? {};
				const tool = params.name ? this.opts.tools.find(t => t.name === params.name) : undefined;
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
			// session likely closed; will be cleaned up by SSE close handler
		}
	}
}
