/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as crypto from 'crypto';
import { URL } from 'url';
import { ToolDefinition } from './tools';
import { isJsonRpcRequest, jsonRpcSuccess, jsonRpcError, JsonRpcErrorCodes, JsonRpcRequest } from './jsonrpc';

const DEFAULT_PORT = 3802;
const HOST = '127.0.0.1';

/**
 * Behavioural guidance returned in the MCP `initialize` response (the client
 * injects it as session context, like a system prompt). This replaces a separate
 * skill: everything the assistant needs to manage the Project Overview To-do list
 * lives in these instructions plus the per-tool descriptions.
 */
const SERVER_INSTRUCTIONS = [
	'This project has a Project Overview tab (Title + Content editor, a Roadmap picture, and a To-do',
	'checklist). You help set it up and keep it up to date via these tools.',
	'',
	'== First-run onboarding (when the project is new / empty) ==',
	'The Overview tab shows the user: "이 프로젝트의 이름이랑 어떤 프로젝트가 될 것인지를 AI 채팅에 입력해주세요".',
	'When the user tells you the project name + what it is:',
	'1. Write it in: set_project_title(name) and update_project_summary(overview text). Then ask the user to',
	'   confirm ("이렇게 정리했는데 맞나요?").',
	'2. After they confirm, say you will plan how to proceed, and call open_roadmap (switches to the Roadmap',
	'   tab and opens a new roadmap canvas).',
	'3. Ask the user which hypothesis they have in mind. When they answer, build the roadmap on the Roadmap',
	'   tab using the roadmap tools (search methods for that hypothesis, propose nodes) as usual.',
	'4. When the roadmap looks reasonably complete, ask "이 정도면 마무리할까요?". If yes: draft a To-do with',
	'   add_tasks - ACTION-oriented items the user will actually DO (experiments / analyses / concrete steps),',
	'   NOT a 1:1 copy of the roadmap. Then call open_overview and tell the user: "Overview 탭에 로드맵이',
	'   반영됐고 To-do를 업데이트했어요. 확인하고 필요하면 수정하세요."',
	'',
	'== Progress tracking (ongoing) ==',
	'- ALWAYS call get_tasks fresh before reasoning about completion - the user may have edited the list.',
	'- As you work with the user, watch for a task becoming FINISHED. Propose completion when BOTH:',
	'  (A) the recent conversation/work clearly maps to a specific To-do item, AND',
	'  (B) a positive stopping signal is present: the user says it works/is done, OR you produced a',
	'      verified deliverable (created + test passed / ran without error / user saw the result), OR the',
	'      user moves on to a different task.',
	'- When A+B hold, call propose_task_completion (one) or propose_task_completions (several that wrapped up',
	'  together): this shows an Accept/Reject badge in the tab. THEN ask the user in chat, e.g.',
	'  "○○이 완료된 것 같은데 완료 처리할까요?" (for a batch, list them and allow partial acceptance).',
	'- Do NOT mark tasks done yourself. Only after the user agrees (in chat or by clicking Accept in the tab)',
	'  call set_task_done / set_tasks_done for the confirmed ids.',
	'- Do NOT propose while still erroring / debugging / only planning. If the user says "아직" or rejects, do',
	'  not re-ask that task again this session.',
	'',
	'You can also edit the title (set_project_title), Content (update_project_summary), and tasks',
	'(add_task / add_tasks / update_task / remove_task) whenever the user asks.',
].join('\n');

interface SseSession {
	id: string;
	res: http.ServerResponse;
}

/**
 * Aria Project Overview MCP server. Same dual-transport implementation as
 * aria-autopipe so Claude Code (HTTP+SSE) and Codex (Streamable HTTP) both
 * work without per-client branches in the AI layer.
 *
 * The server owns no state of its own - every tool call reads/writes the
 * project's overview.json through the tool table the caller provided.
 */
export class AriaOverviewMcpServer {

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

		// Try the default port first, then fall back through a small range,
		// finally let the OS assign one. The default is offset from the
		// autopipe / paper-search ports so Aria's three MCPs can coexist.
		const candidates = [DEFAULT_PORT, 3803, 3804, 3805, 0];

		for (const candidate of candidates) {
			try {
				const server = await this.tryListen(candidate);
				this.httpServer = server;
				const address = server.address();
				this.port = typeof address === 'object' && address !== null ? address.port : candidate;
				console.log(`[aria-overview] MCP server listening on http://${HOST}:${this.port}`);
				return this.port;
			} catch (e) {
				const code = (e as NodeJS.ErrnoException).code;
				if (code !== 'EADDRINUSE') {
					throw e;
				}
				console.warn(`[aria-overview] port ${candidate} in use, trying next…`);
			}
		}

		throw new Error('Could not find a free port for the Aria Roadmap MCP server');
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
		console.log('[aria-overview] MCP server stopped');
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
			res.end(JSON.stringify({ server: 'aria-overview', toolCount: this.tools.length }));
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
					serverInfo: { name: 'aria-overview', version: '0.0.1' },
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
