/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as crypto from 'crypto';
import { URL } from 'url';
import { ToolDefinition } from './tools';
import { isJsonRpcRequest, jsonRpcSuccess, jsonRpcError, JsonRpcErrorCodes, JsonRpcRequest } from './jsonrpc';

const DEFAULT_PORT = 3790;
const HOST = '127.0.0.1';

interface SseSession {
	id: string;
	res: http.ServerResponse;
}

/**
 * Aria Paper MCP server. Same dual-transport (HTTP+SSE / Streamable HTTP)
 * implementation as Aria's other MCP servers so Claude Code and Codex both
 * work without per-client branches. Owns no state — every tool call is
 * dispatched into the tool table the caller provided.
 */
export class AriaPaperMcpServer {

	private httpServer: http.Server | undefined;
	private readonly sessions = new Map<string, SseSession>();
	private port = DEFAULT_PORT;

	constructor(private readonly tools: ToolDefinition[], private readonly instructions?: string) { }

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

		// Default port is offset from autopipe / paper-search / aria-notes so
		// Aria's MCP servers can coexist; fall back through a small range, then
		// let the OS assign one.
		const candidates = [DEFAULT_PORT, 3791, 3792, 3793, 0];

		for (const candidate of candidates) {
			try {
				const server = await this.tryListen(candidate);
				this.httpServer = server;
				const address = server.address();
				this.port = typeof address === 'object' && address !== null ? address.port : candidate;
				console.log(`[aria-paper] MCP server listening on http://${HOST}:${this.port}`);
				return this.port;
			} catch (e) {
				const code = (e as NodeJS.ErrnoException).code;
				if (code !== 'EADDRINUSE') {
					throw e;
				}
				console.warn(`[aria-paper] port ${candidate} in use, trying next…`);
			}
		}

		throw new Error('Could not find a free port for the Aria Paper MCP server');
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
			try { session.res.end(); } catch { /* already closed */ }
		}
		this.sessions.clear();

		const server = this.httpServer;
		if (!server) { return; }
		this.httpServer = undefined;
		await new Promise<void>(resolve => server.close(() => resolve()));
		console.log('[aria-paper] MCP server stopped');
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
			res.end(JSON.stringify({ server: 'aria-paper', toolCount: this.tools.length }));
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
					serverInfo: { name: 'aria-paper', version: '0.0.1' },
					capabilities: { tools: {} },
					...(this.instructions ? { instructions: this.instructions } : {}),
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
