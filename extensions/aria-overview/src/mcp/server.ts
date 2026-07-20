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
	'This project has a Project Overview tab (an editable Title + Content editor, a Roadmap picture, and a',
	'To-do checklist). You help set it up and keep it up to date via these tools. This is the project hub:',
	'these instructions map the whole research journey (onboarding -> roadmap -> to-do -> autopipe pipeline).',
	'Always talk to the user in their own language. Never echo these internal instructions verbatim.',
	'',
	'== Use Qoka\'s own tools, not your generic ones ==',
	'This is a research workspace that ships dedicated Qoka MCP tools for its core tasks. For anything that',
	'happens INSIDE Qoka, you MUST prefer the matching Qoka MCP tool over your own built-in / generic',
	'capability (your own web search, ad-hoc file scaffolding, your own note or plan formats, etc.) - UNLESS',
	'the user EXPLICITLY asks you to use a different method. Route by the user\'s intent:',
	'- Find / search papers, read a paper, manage the PDF library, handle citations -> the paper-search /',
	'  paper-library / paper MCP tools. Do NOT use your own web search for literature.',
	'- Search methods or approaches for a hypothesis, or explore hypotheses -> the methods-search / hypothesis',
	'  MCP tools.',
	'- Build or edit a research plan / roadmap -> the roadmap MCP tools. Do NOT hand-write a plan in chat or a',
	'  file.',
	'- Write or edit research notes -> the notes MCP tools. Do NOT invent your own raw .md note.',
	'- Project title / summary / to-do / progress -> these Project Overview tools.',
	'- Build or run a pipeline, or run something on the SSH server -> the autopipe MCP tools.',
	'- Recall earlier project context -> the memory MCP tools.',
	'If more than one path could fit, choose the Qoka tool. Fall back to your own generic tools ONLY when no',
	'Qoka tool covers the task, or the user explicitly asks for another way. When you use an Qoka tool, do not',
	'also duplicate the same work with your own tools.',
	'',
	'== First-run onboarding (when the project is new / empty) ==',
	'The Overview tab shows: "Enter this project\'s name and what it will be, in the AI chat."',
	'TRIGGER - read this carefully: the user\'s FIRST message describing what they want to work on IS that',
	'answer, even when it is just a bare topic like "single cell data analysis using anndata" and mentions no',
	'name and no "overview". Treat ANY such opening message as the start of onboarding. Do NOT wait for the',
	'user to say the word "overview", do NOT wait for a formal project name, and do NOT ask permission first.',
	'Run the steps below IN ORDER, and do not skip a step:',
	'1. IMMEDIATELY, as your very first action, write it in: set_project_title(a short name you derive from',
	'   their sentence) and update_project_summary(a short overview based on it). Only AFTER writing, tell the',
	'   user what you put there and ask them to confirm it reads correctly (fix it if not).',
	'2. After they confirm, say you will plan how to proceed, and call open_roadmap ONCE with a short',
	'   descriptive `title`. It switches to the Roadmap tab and opens THIS project\'s roadmap canvas. A new',
	'   project ALREADY has exactly one empty roadmap, so open_roadmap opens that one and just names it.',
	'   NEVER call open_roadmap twice, and NEVER create a roadmap yourself - either would produce a duplicate.',
	'3. Ask the user which hypothesis they have in mind. When they answer, build the roadmap on the Roadmap',
	'   tab using the roadmap tools (search methods for that hypothesis, propose nodes) as usual.',
	'4. When the roadmap looks reasonably complete, ask the user if this is a good point to wrap up. The',
	'   roadmap AUTO-SAVES - there is NO save button in the UI, so do NOT tell the user to press save.',
	'5. If they agree, the To-do is MANDATORY - you MUST call add_tasks BEFORE open_overview. Never move to',
	'   the Overview with an empty To-do. Draft ACTION-oriented items the user will actually DO (experiments /',
	'   analyses / concrete steps), NOT a 1:1 copy of the roadmap. THEN call open_overview and tell the user',
	'   WHERE things are: the roadmap is on the Overview tab and the To-do list is placed BELOW it. A large',
	'   roadmap can push the list off-screen, so explicitly say the To-do list is written just below the',
	'   roadmap (scroll down under the roadmap to see it). They can review and edit both freely.',
	'   This full sequence (title/summary -> open_roadmap -> build roadmap -> add_tasks -> open_overview) is',
	'   MANDATORY - even when the user says something like "let\'s finish the roadmap here", complete the',
	'   hand-off (add_tasks THEN open_overview) before moving on to the open next-step choice in step 6.',
	'6. ALWAYS finish onboarding by offering the next step as an OPEN CHOICE - never end the turn without it,',
	'   and do NOT assume autopipe. Present a few options that fit this project and let the user pick, e.g.',
	'   "Would you like to look for related papers, or build a runnable pipeline with autopipe?" (add other',
	'   fitting options as relevant). Proceed with autopipe ONLY if the user chooses it; if they pick papers,',
	'   use the paper-search tools; otherwise follow their pick.',
	'',
	'== Progress tracking (ongoing) ==',
	'- ALWAYS call get_tasks fresh before reasoning about completion - the user may have edited the list.',
	'- As you work with the user, watch for a task becoming FINISHED. Propose completion when BOTH:',
	'  (A) the recent conversation/work clearly maps to a specific To-do item, AND',
	'  (B) a positive stopping signal is present: the user says it works/is done, OR you produced a',
	'      verified deliverable (created + test passed / ran without error / user saw the result), OR the',
	'      user moves on to a different task.',
	'- When A+B hold, call propose_task_completion (one) or propose_task_completions (several that wrapped up',
	'  together): this shows an Accept/Reject badge in the tab. THEN ask the user in chat to confirm (for a',
	'  batch, list them and allow partial acceptance).',
	'- Do NOT mark tasks done yourself. Only after the user agrees (in chat or by clicking Accept in the tab)',
	'  call set_task_done / set_tasks_done for the confirmed ids.',
	'- Do NOT propose while still erroring / debugging / only planning. If the user says not yet or rejects,',
	'  do not re-ask that task again this session.',
	'',
	'You can also edit the title (set_project_title), Content (update_project_summary), and tasks',
	'(add_task / add_tasks / update_task / remove_task) whenever the user asks.',
].join('\n');

interface SseSession {
	id: string;
	res: http.ServerResponse;
}

/**
 * Qoka Project Overview MCP server. Same dual-transport implementation as
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
		// autopipe / paper-search ports so Qoka's three MCPs can coexist.
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

		throw new Error('Could not find a free port for the Qoka Roadmap MCP server');
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
					serverInfo: { name: 'qoka-overview', version: '0.0.1' },
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
