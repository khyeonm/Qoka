/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Research Loop Engine MCP tools (M0 - no execution yet).
//  - design_loop : returns the loop-design instruction + project context so the CHAT
//                  writes a LoopSpec. (The server OWNS the instruction; the chat reads it.)
//  - save_loop   : persist a chat-authored LoopSpec as a pending-approval run.
//  - loop_list / loop_status : read persisted loops.
// start_loop (execution) lands in M1.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LoopSpec } from '../schema';
import { saveLoop, readLoop, listLoops, writeLoop, loopsDir } from '../state';
import { runLoop, ScriptRunner } from '../engine';
import { warmGitBinary } from '../gitBin';
import { loopLog } from '../log';
import { makeAgentStep } from '../agentStep';

/**
 * mcpInfo commands for every Qoka WORK MCP server (the same toolset the main chat has),
 * DELIBERATELY excluding the loop-control server (qoka.loop.mcpInfo) so a sub-agent can never
 * start another loop. Each returns { name, port } | null. The sub-agent gets whichever are up.
 */
const WORK_MCP_INFO_COMMANDS = [
	'aria.qokarun.mcpInfo',       // qoka-run (run_code)
	'aria.autopipe.mcpInfo',      // qoka-autopipe (pipelines)
	'aria.qokaenv.mcpInfo',       // qoka-environment
	'aria.paperSearch.mcpInfo',   // qoka-paper-library
	'aria.paper.mcpInfo',
	'aria.notes.mcpInfo',
	'aria.memory.mcpInfo',
	'aria.overview.mcpInfo',
	'aria.roadmap.mcpInfo',
	'aria.hypothesis.mcpInfo',
	'aria.methodsSearch.mcpInfo',
];

/** Query every work mcpInfo command and build the name -> { SSE url + port } map for the sub-agent
 *  (Claude uses the /sse url; Codex uses the port to reach the same server's /mcp transport). */
async function collectWorkMcpServers(): Promise<Record<string, { url: string; port: number }>> {
	const servers: Record<string, { url: string; port: number }> = {};
	await Promise.all(WORK_MCP_INFO_COMMANDS.map(async (cmd) => {
		try {
			const info = await vscode.commands.executeCommand(cmd) as { name?: string; port?: number } | null;
			if (info && typeof info.name === 'string' && typeof info.port === 'number') {
				servers[info.name] = { url: `http://127.0.0.1:${info.port}/sse`, port: info.port };
			}
		} catch { /* server not up / command absent - skip it */ }
	}));
	return servers;
}

/**
 * Corner notification when a background loop finishes. Per the design (decision on notifications):
 * we do NOT auto-send anything to the chat; we surface a toast and hand the user an EXAMPLE PROMPT
 * they can paste to ask the chat about the result, plus a shortcut to open the Loops tab.
 */
async function notifyLoopFinished(id: string, outcome: string): Promise<void> {
	const run = readLoop(id);
	const title = run?.spec.title ?? id;
	const label = outcome === 'success' ? `Loop "${title}" finished: success`
		: outcome === 'paused' ? `Loop "${title}" paused (environment problem)`
		: outcome === 'failed-structural' ? `Loop "${title}" stopped: no progress`
		: outcome === 'failed-budget' ? `Loop "${title}" stopped: budget exhausted`
		: outcome === 'stopped' ? `Loop "${title}" stopped`
		: `Loop "${title}" finished (${outcome})`;
	const OPEN = 'Open tab';
	const pick = await vscode.window.showInformationMessage(label, OPEN);
	if (pick === OPEN) {
		void vscode.commands.executeCommand('qoka.loop.open', id);
	}
}

/**
 * A ScriptRunner that executes the locked evaluator WHERE the sub-agent's work happened: the
 * active run environment (SSH server / WSL / vfkit), via the qoka-run runInEnv command. This
 * matters on a truly remote target - the evaluator must read the files run_code wrote there, not
 * a local copy. Falls back to a non-pass verdict if no run environment is reachable.
 */
function runEnvEvaluatorRunner(): ScriptRunner {
	return async (script, language) => {
		try {
			const r = await vscode.commands.executeCommand('aria.qokarun.runInEnv', { code: script, language }) as
				{ stdout?: string; stderr?: string; exitCode?: number | null } | undefined;
			if (!r) { return { stdout: '', stderr: 'runInEnv returned nothing', exitCode: 1 }; }
			return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? null };
		} catch (e) {
			return { stdout: '', stderr: `runInEnv failed: ${(e as Error).message}`, exitCode: 1 };
		}
	};
}

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

/**
 * The loop-design instruction the chat follows to write a LoopSpec. This is the adversarially-
 * tested v3 rule set from loop_instruction.md (15/15 on the always-PASS / confirmation-bias /
 * fake-tool / contradiction battery), adapted so the output is a Qoka LoopSpec whose evaluator is
 * EXECUTABLE code (not prose). The rule that matters: a loop needs a machine-checkable evaluator,
 * or it is not a loop.
 */
const DESIGN_INSTRUCTION = `You are a research-loop designer inside Qoka. Given a research GOAL, either design an
executable "loop" (goal + steps + a machine-checkable evaluator) that an autonomous system can run
until the goal is verifiably met, OR - when the goal is underspecified - ask/offer options instead.
Do NOT execute anything; output ONLY the design (or your question/options).

FIRST, A ROUTING CHECK: a loop runs autonomous sub-agents in the background and costs tokens, so
only build one when the user actually wants a loop. If the user explicitly asked for a loop, proceed.
If they only asked to "repeat until X" WITHOUT saying loop, stop and ask them (in their own
language) whether to make it a repeating loop first; design the loop only after they agree. An
ordinary one-off task is not a loop.

Ground yourself first (never skip):
- List the MCP tools and skills you actually have in THIS session; never invent tools.
- Check the open project's data/ for available inputs.
- Use only tools/skills/data that actually exist.

Hard rules (adversarially tested - do not relax):
1. The evaluator MUST be objective and machine-decidable (a code assertion, a metric threshold,
   "compiles", an exit code, a byte-identical re-run, a negative-control count) - NOT prose. If you
   cannot define one for the goal, do NOT invent it - ask: "What would count as success (a checkable
   condition)?"
2. Use ONLY tools/skills/data that exist in this session. Never invent a tool name.
3. Underspecified goal = ask, don't guess. If the goal, or what counts as success, is not concretely
   specified (e.g. "what can I do with this data?", "find something interesting", "explore X"), do
   NOT invent an objective and do NOT commit to a loop. Instead either (a) ask what outcome the user
   wants, or (b) present 2-4 one-line candidate loops and ask which to pursue. Design a full loop
   ONLY after the objective is chosen. If which data / target / comparison is missing, ask first.
4. Match structure to the goal: a single small analysis = ONE short loop (do NOT split it into many);
   a genuinely multi-stage / large goal = a CHAIN of short loops (subLoops), each with its own
   evaluator and a human checkpoint between. Recommend the split; do not hard-block.
5. Scope discipline: do not escalate a vague or one-line request into a large multi-loop program
   without confirmation. Match effort to what was actually asked.
6. The evaluator is LOCKED once set (sha256). During execution the loop may fix the CODE/approach,
   but must NEVER weaken or rewrite the evaluator to force a pass. If the evaluator itself is
   wrong/buggy, STOP and surface it for re-approval - do not silently relax the success criterion.
7. Heavy prerequisites get their own setup loop; light installs do NOT. Only a HEAVY/slow toolchain
   (a compiler such as Lean or LaTeX, a multi-GB or license-gated package, a reference genome)
   becomes its own FIRST setup loop with a large time budget. Installing a few ordinary packages
   (pip/uv/conda, e.g. pandas, scipy, scanpy) is a STEP INSIDE the analysis loop, NOT a separate one.
8. Keep each loop short and its evaluator achievable. Where relevant, strengthen the evaluator with
   negative controls (a control input must NOT pass), a permutation/null check, a static
   anti-cheating check, and a byte-identical re-run.

If a rule (1 or 3) says ask/offer instead of committing, output ONLY that question or those 2-4
options - no loop.

Otherwise present the loop FOR APPROVAL AS PLAIN, NATURAL LANGUAGE - not code. The user is often not a
programmer, so:
- Describe it in a few short sentences / bullets in the user's own language: the goal, what happens
  each iteration, how success is decided (state the check as ONE plain-language sentence, e.g. "passes
  when the mean is within 0.02 of 0 and the standard deviation is between 0.98 and 1.02"), and the
  budget (iterations / minutes).
- Do NOT paste the evaluator source code, the LoopSpec JSON, or long code blocks into the approval
  message. At most, if the user is technical and asks, offer to show the evaluator code - otherwise
  keep it hidden. The evaluator is still built and locked internally; the user just does not need to
  read code to approve.
- Then ask (in the user's own language) whether to run this loop, confirming the budget and noting it
  runs sub-agents in the background and consumes tokens.
Only after the user agrees do you call save_loop(spec), then start_loop(loopId) to run it in the
background. The user (not the agent) approves the evaluator; it is then sha256-locked so the work
agent cannot alter it.

Produce a LoopSpec with this shape and pass it verbatim to save_loop (evaluator.code is EXECUTABLE
code returning a deterministic verdict: exit 0 = pass / non-zero = fail, or print {"pass": bool,
"detail": "..."} on stdout). IMPORTANT - the "detail" on FAILURE must be a SHORT ONE-LINE summary of
the CAUSE (the metric vs the threshold, or the single failing condition - e.g. "ARI=0.72 < 0.9" or
"row count 180 != 200"), NOT a full traceback, stack dump, or multi-line log: this line is shown
verbatim in the loop's iteration history, and the next iteration reads it as the fix-this feedback,
so make it a concise, actionable reason. On PASS the detail can be a short confirmation or empty.
{
  "title": "short title in PLAIN WORDS (2-5 words, e.g. \"normal sampling convergence\"). It becomes the loop's folder name, so avoid bare math/symbol notation like \"N(0,1)\" which slugs to noise",
  "goal": "one sentence goal",
  "flow": {
    "input": "what it starts from",
    "steps": ["step 1", "step 2", "on fail: fix & retry"],
    "checks": [{ "c": "condition", "why": "why this makes the loop trustworthy (e.g. a negative control)" }],
    "output": "what it produces",
    "stops": "15 iterations or 20 min"
  },
  "evaluator": { "code": "...executable check...", "language": "python" },
  "budget": { "maxIter": 15, "maxMin": 20 },
  "subLoops": []
}
Then add 2 short notes: (a) why the evaluator is objectively checkable, (b) any assumption you made.`;

/** List the top of the project's data/ folder so design_loop is grounded in real inputs (v3's
 *  "check the open project's data/ for available inputs") rather than guessing. Best-effort. */
function listDataFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, rel: string, depth: number): void => {
		if (depth > 2 || out.length > 40) { return; }
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (e.name.startsWith('.')) { continue; }
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) { walk(path.join(dir, e.name), childRel, depth + 1); }
			else { out.push(childRel); }
			if (out.length > 40) { break; }
		}
	};
	walk(path.join(root, 'data'), '', 0);
	return out;
}

/** Project context so the design is grounded, not guessed: real data/ inputs + the work tools the
 *  sub-agent will actually have (so the chat never invents a tool). Full logic-graph / corpus
 *  grounding (M5) needs the remote Neo4j + hypothesis-corpus endpoints and is not wired yet. */
async function projectContext(): Promise<Record<string, unknown>> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	let availableTools: string[] = [];
	try { availableTools = Object.keys(await collectWorkMcpServers()); } catch { /* servers may be down */ }
	return {
		projectRoot: root ?? null,
		hasProject: !!root,
		dataFiles: root ? listDataFiles(root) : [],
		availableTools,
		note: 'Ground the loop in these real data/ inputs and availableTools (never invent a tool). Full logic-graph/corpus grounding (M5) is not wired yet.',
	};
}

function asSpec(v: unknown): LoopSpec | undefined {
	if (!v || typeof v !== 'object') { return undefined; }
	const s = v as Partial<LoopSpec>;
	if (typeof s.title !== 'string' || typeof s.goal !== 'string') { return undefined; }
	if (!s.flow || typeof s.flow !== 'object' || !Array.isArray(s.flow.steps)) { return undefined; }
	if (!s.evaluator || typeof s.evaluator !== 'object' || typeof s.evaluator.code !== 'string') { return undefined; }
	return s as LoopSpec;
}

/** Loop ids the user asked to stop; the engine checks this via shouldStop each iteration. */
const stopRequested = new Set<string>();
/** Per-loop abort controllers so stop_loop can kill the running sub-agent turn at once. */
const abortControllers = new Map<string, AbortController>();

/** Readable per-loop folder segment (title slug + short id) that run_code groups this loop's runs
 *  under: results/loops/<loopFolder>/ + analysis/loops/<loopFolder>/. ASCII-safe; a non-ASCII title
 *  (e.g. Korean) slugs to empty and falls back to the short id. */
function loopFolderName(run: { id: string; spec: { title: string } }): string {
	const short = run.id.slice(0, 6);
	let slug = (run.spec.title || '').toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')       // non-alphanumerics -> hyphen
		.replace(/^[-0-9]+/, '')           // drop a leading run of hyphens/digits (e.g. "N(0,1)" -> "n-0-1" -> "n")
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 30).replace(/-+$/g, '');
	// A title that is mostly symbols/numbers (e.g. "N(0,1)") slugs to almost nothing and reads as noise;
	// fall back to a clean generic name rather than a cryptic "n-0-1".
	const letters = (slug.match(/[a-z]/g) || []).length;
	if (letters < 3) { slug = ''; }
	return slug ? `${slug}-${short}` : `loop-${short}`;
}

/**
 * Start (or RESUME) a loop's background run. Shared by start_loop and resume_loop - a resume just
 * re-enters here on a non-running loop; runLoop continues from the persisted run.iteration and
 * history, so the loop picks up where it left off. Fire-and-forget: returns immediately.
 */
async function launchLoop(id: string): Promise<CallToolResult> {
	const run = readLoop(id);
	if (!run) { return err(`No loop with id ${id}.`); }
	if (run.status === 'running') { return err(`Loop ${id} is already running.`); }
	const dir = loopsDir();
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!dir || !cwd) { return err('No open project to run the loop in.'); }
	stopRequested.delete(id);
	const workMcpServers = await collectWorkMcpServers();
	const provider = run.provider === 'codex' ? 'codex' : 'claude';
	const folder = loopFolderName(run);
	// Top-level loops/<folder>/ (next to data/analysis/results): code/ holds the git-versioned
	// executed code (one commit per iteration); results/ holds only the FINAL run's outputs (the
	// engine clears it before each iteration). The tab shows the full title; the folder is short.
	run.rootDir = `loops/${folder}`;
	writeLoop(run);
	const codeDir = path.join(cwd, 'loops', folder, 'code');
	const resultsDir = path.join(cwd, 'loops', folder, 'results');
	// Where run_code drops each run's real script (hidden), so the engine can commit the actual executed
	// code as that iteration's version instead of a transcript guess. Mirrors run.ts's loop codeRel.
	const captureDir = path.join(cwd, '.qoka', 'loops', folder, 'code');
	// Resolve git via aria-vcs (extracts the bundled MinGit on Windows on first use) so the engine's
	// per-iteration commits use a real git even when none is on PATH. Best-effort: falls back internally.
	const gitPath = await warmGitBinary(vscode.commands);
	loopLog(`launch loop ${id}: folder=${folder} gitPath=${gitPath} codeDir=${codeDir}`);
	// Quick probe so the Output channel shows immediately whether this git binary actually runs.
	try {
		const cp = await import('child_process');
		const ver = cp.execFileSync(gitPath, ['--version'], { encoding: 'utf8' }).trim();
		loopLog(`  git probe ok: ${ver}`);
	} catch (e) {
		loopLog(`  git probe FAILED (${gitPath}): ${(e as Error).message} -> code versions will be empty. Install git or check the bundled MinGit.`);
	}
	// A per-loop AbortController so stop_loop can KILL the running sub-agent turn immediately, instead of
	// only being noticed at the next iteration boundary (which, with a long docking turn, felt frozen).
	const abort = new AbortController();
	abortControllers.set(id, abort);
	const agentStep = makeAgentStep({ provider, cwd, loopDir: dir, workMcpServers, loopFolder: folder, signal: abort.signal });
	const evaluatorRunner = runEnvEvaluatorRunner();
	const resuming = run.iteration > 0;
	void vscode.commands.executeCommand('qoka.loop.open', id);
	void runLoop(run, agentStep, { loopDir: dir, cwd, evaluatorRunner, persist: writeLoop, shouldStop: () => stopRequested.has(id), codeDir, resultsDir, captureDir, gitPath, log: loopLog })
		.then(outcome => { stopRequested.delete(id); abortControllers.delete(id); console.log(`[qoka-loop] loop ${id} finished: ${outcome}`); void notifyLoopFinished(id, outcome); })
		.catch(e => { stopRequested.delete(id); abortControllers.delete(id); console.error(`[qoka-loop] loop ${id} crashed:`, e); });
	return ok(JSON.stringify({ started: true, resumed: resuming, loopId: id, fromIteration: run.iteration, tools: Object.keys(workMcpServers) }));
}

export function buildTools(): ToolDefinition[] {
	return [
		{
			name: 'design_loop',
			description: 'Get the instruction and project context for designing a research loop. WHEN TO CALL: ONLY when the user EXPLICITLY asks to make/run a LOOP (in any language, e.g. "make this a loop", "run it as a loop"). Do NOT call it for an ordinary one-off task - just do that with the normal tools (run_code etc.). If the user asks to REPEAT something until a goal/threshold is met but does NOT say "loop", do NOT call this yet: first ASK them in chat (in their own language) whether to make it a repeating loop, and call design_loop ONLY after they say yes. Returns the design rules (you then write a LoopSpec that follows them) plus the open project context. After writing the LoopSpec, show it to the user, ask for confirmation (and budget), and only on approval call save_loop.',
			inputSchema: {
				type: 'object',
				properties: {
					goal: { type: 'string', description: 'The user\'s goal in their own words (optional; helps ground the context).' },
				},
				additionalProperties: false,
			},
			handler: async () => ok(JSON.stringify({
				instruction: DESIGN_INSTRUCTION,
				context: await projectContext(),
			})),
		},
		{
			name: 'save_loop',
			description: 'Persist a LoopSpec the user has APPROVED as a pending run (no execution yet). Only call after the user confirms the loop in chat. Returns the loopId.',
			inputSchema: {
				type: 'object',
				properties: {
					spec: { type: 'object', description: 'The approved LoopSpec (title, goal, flow, evaluator, budget).' },
				},
				required: ['spec'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const spec = asSpec(args.spec);
				if (!spec) { return err('Invalid LoopSpec: need title, goal, flow.steps, and evaluator.code.'); }
				const run = saveLoop(spec);
				if (!run) { return err('No open project to save the loop into. Open a project folder first.'); }
				// Auto-open the (display-only) Loops tab on the fresh draft so the user can review it
				// while the chat asks for confirmation. All loop control stays in the chat (decision B).
				void vscode.commands.executeCommand('qoka.loop.open', run.id);
				return ok(JSON.stringify({ loopId: run.id, status: run.status, savedAt: run.createdAt }));
			},
		},
		{
			name: 'start_loop',
			description: 'Start running an APPROVED loop in the background. The engine sha256-locks the evaluator, then repeats: a sub-agent does the work with the full Qoka work toolset (run_code, pipelines, paper, notes, ...), the locked evaluator runs IN the run environment and judges, until it passes, stalls (same failure 3x), or the budget (iterations/minutes) runs out. Returns immediately; poll loop_status for progress. Only call after the user has confirmed the loop.',
			inputSchema: {
				type: 'object',
				properties: { loopId: { type: 'string', description: 'The loop id from save_loop / loop_list.' } },
				required: ['loopId'],
				additionalProperties: false,
			},
			handler: async (args) => launchLoop(typeof args.loopId === 'string' ? args.loopId : ''),
		},
		{
			name: 'stop_loop',
			description: 'Stop a RUNNING loop immediately (kills the current iteration and marks it "stopped"; resumable later with resume_loop). Use when the user asks to stop/cancel/halt a running loop.',
			inputSchema: {
				type: 'object',
				properties: { loopId: { type: 'string', description: 'The loop id from loop_list.' } },
				required: ['loopId'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = typeof args.loopId === 'string' ? args.loopId : '';
				const run = readLoop(id);
				if (!run) { return err(`No loop with id ${id}.`); }
				if (run.status !== 'running') { return err(`Loop ${id} is not running (status ${run.status}).`); }
				stopRequested.add(id);
				// Kill the running sub-agent turn now so the stop takes effect within seconds (not after a
				// long docking/analysis turn), and flip the persisted status right away so the Loops UI
				// reflects "stopped" immediately instead of after the current iteration.
				abortControllers.get(id)?.abort();
				run.status = 'stopped';
				run.reason = 'stopped by user';
				writeLoop(run);
				return ok(JSON.stringify({ stopped: true, loopId: id }));
			},
		},
		{
			name: 'resume_loop',
			description: 'Resume a PAUSED or STOPPED loop from where it left off (continues its iteration count and history). Use when the user asks to resume/continue a loop that was paused (environment error) or stopped.',
			inputSchema: {
				type: 'object',
				properties: { loopId: { type: 'string', description: 'The loop id from loop_list.' } },
				required: ['loopId'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = typeof args.loopId === 'string' ? args.loopId : '';
				const run = readLoop(id);
				if (!run) { return err(`No loop with id ${id}.`); }
				if (run.status === 'running') { return err(`Loop ${id} is already running.`); }
				if (run.status === 'success') { return err(`Loop ${id} already succeeded - nothing to resume.`); }
				return launchLoop(id);
			},
		},
		{
			name: 'propose_alternatives',
			description: 'When a loop FAILED (no progress / budget exhausted), get its failure context so you can propose 2 concrete ALTERNATIVE loop designs (a different approach and/or a different evaluator) and ask the user which to pursue. Returns the loop\'s reason + recent failures; you then present the 2 options in chat (do not auto-run).',
			inputSchema: {
				type: 'object',
				properties: { loopId: { type: 'string', description: 'The failed loop id from loop_list.' } },
				required: ['loopId'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = typeof args.loopId === 'string' ? args.loopId : '';
				const run = readLoop(id);
				if (!run) { return err(`No loop with id ${id}.`); }
				const recent = run.history.slice(-4).map(h => ({ iteration: h.iteration, verdict: h.verdict, detail: h.detail }));
				return ok(JSON.stringify({
					loopId: id,
					title: run.spec.title,
					goal: run.spec.goal,
					status: run.status,
					reason: run.reason ?? null,
					recentFailures: recent,
					instruction: 'Propose exactly 2 alternative loop designs that avoid this failure mode: e.g. (1) a different APPROACH toward the same goal, (2) a different/relaxed-but-still-objective EVALUATOR or a concretized goal. Present both as one-line options in chat and ask the user which to pursue; design the full LoopSpec only after they choose. Do not auto-run.',
				}));
			},
		},
		{
			name: 'loop_list',
			description: 'List all loops in this project (id, title, status, iteration). Use to see running/finished loops.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => ok(JSON.stringify(listLoops().map(r => ({
				id: r.id, title: r.spec.title, status: r.status, iteration: r.iteration, createdAt: r.createdAt,
			})))),
		},
		{
			name: 'loop_status',
			description: 'Read one loop in full (spec, status, iteration, budget, history). Use when the user asks about a specific loop.',
			inputSchema: {
				type: 'object',
				properties: { loopId: { type: 'string', description: 'The loop id from loop_list.' } },
				required: ['loopId'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = typeof args.loopId === 'string' ? args.loopId : '';
				const run = readLoop(id);
				if (!run) { return err(`No loop with id ${id}.`); }
				return ok(JSON.stringify(run));
			},
		},
	];
}
