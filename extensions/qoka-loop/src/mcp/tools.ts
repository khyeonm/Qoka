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
import { runLoop, preflightEvaluator, findLocalRootLiteral, findDoubleEscapedRawString, ScriptRunner } from '../engine';
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
	const OPEN = 'Open tab';
	// A pause carries a specific reason (a timeout tells the user to raise the budget in chat) - surface it
	// as a prominent WARNING popup with the reason, not a bland info toast.
	if (outcome === 'paused') {
		const reason = run?.reason ?? 'environment problem';
		const pick = await vscode.window.showWarningMessage(`Loop "${title}" paused: ${reason}`, { modal: false }, OPEN);
		if (pick === OPEN) { void vscode.commands.executeCommand('qoka.loop.open', id); }
		return;
	}
	const label = outcome === 'success' ? `Loop "${title}" finished: success`
		: outcome === 'failed-structural' ? `Loop "${title}" stopped: no progress`
		: outcome === 'failed-budget' ? `Loop "${title}" stopped: budget exhausted`
		: outcome === 'stopped' ? `Loop "${title}" stopped`
		: `Loop "${title}" finished (${outcome})`;
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
function runEnvEvaluatorRunner(cwdRel?: string): ScriptRunner {
	return async (script, language, dependencies, limits) => {
		try {
			const r = await vscode.commands.executeCommand('aria.qokarun.runInEnv', { code: script, language, cwdRel, dependencies, timeoutMs: limits?.timeoutMs }) as
				{ stdout?: string; stderr?: string; exitCode?: number | null } | undefined;
			if (!r) { return { stdout: '', stderr: 'runInEnv returned nothing', exitCode: 1 }; }
			return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? null };
		} catch (e) {
			return { stdout: '', stderr: `runInEnv failed: ${(e as Error).message}`, exitCode: 1 };
		}
	};
}

/**
 * Read the current iteration's live stdout.log FROM the run environment (so a remote SSH run's
 * progress markers are visible mid-run - the local results/ dir is empty until the run finishes).
 * relPath is workspace-relative; the command reads it locally when mounted, or via ssh otherwise.
 */
/** Stop every process of this loop (tagged with its scope) in the active run environment. */
function runEnvWorkKiller(scope: string): () => Promise<void> {
	return async () => {
		const n = await vscode.commands.executeCommand('aria.qokarun.killScope', { scope }) as number | undefined;
		if (n) { loopLog(`killed ${n} leftover process(es) of ${scope} in the run environment`); }
	};
}

function runEnvLogReader(relPath: string): () => Promise<string | undefined> {
	return async () => {
		try {
			const txt = await vscode.commands.executeCommand('aria.qokarun.readRunEnvFile', { relPath }) as string | undefined;
			return typeof txt === 'string' ? txt : undefined;
		} catch {
			return undefined;
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
only build one when the request is actually loop-shaped. Treat it as a loop when the work is
REPEATED toward a goal/threshold/condition, or when the user said "loop". Treat it as a one-shot
(no loop) when it finishes in a single pass. If it is AMBIGUOUS (could be either), STOP and ask the
user, in their own language, whether to run it once with run_code or as a repeating loop, and wait.
An ordinary one-off task is not a loop.

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
9. MANDATORY re-ask - do NOT skip. Before you build the loop, the user MUST have given you two things
   concretely; if EITHER is missing or vague, STOP and ask for it (in their own language) instead of
   guessing:
   (a) the STOP / termination condition - exactly what makes the loop "done" (the checkable success
       condition, and/or the iteration/time limit). If unclear, ask "what would count as done?".
   (b) the REQUIRED OUTPUT FILES - what file(s) must exist when the loop finishes (name + what they
       contain, e.g. "candidates.csv with a score column"). If unclear, ask what output they need.
   The evaluator and the loop cannot be trusted without both, so treat this as a hard gate.
10. BUDGET is set FOR THIS TASK and confirmed, never a default and never silently assumed. If the user
   stated a budget, use it. If not, ESTIMATE one from this task and the real data:
   - TIME PER ITERATION = the sub-agent's work for one realistic attempt (installing packages, loading
     the data, running the analysis; when it is cheap, time a quick probe with run_code) + the
     EVALUATOR's own run time (the loop's clock keeps running while it judges, so the budget must cover
     it) + a margin of about half again.
   - ITERATIONS = how many attempts the goal plausibly needs: a deterministic transform or count that is
     right or wrong: 2-3; a threshold reached by trying models or settings: 5-10; open-ended tuning:
     more, but say why.
   - maxMin (TOTAL minutes for the whole loop) = ITERATIONS x TIME PER ITERATION, rounded up.
   Show the breakdown in plain words, in the form "about <T> min per try: <W> min of work + <C> min of
   checking, so <N> tries = <N x T> min in total", with YOUR numbers for THIS task (do not reuse numbers
   from these rules), say that it spends sub-agent tokens in the background, and ASK "shall I proceed
   with this budget?" in their own language. Wait for a yes. save_loop refuses a spec without a
   budget.
11. FILE PLACEMENT - everything the loop produces stays inside the loop's own folder. The engine runs
   every run_code script AND the evaluator with the working directory set to the loop's results
   folder (loops/<loop-folder>/results, created when the loop starts), and it versions each run_code
   script into loops/<loop-folder>/code automatically. So:
   - In flow.steps, flow.output and the evaluator, name output files by RELATIVE paths only (e.g.
     "state_overlap.tsv", "plots/umap.png"); they resolve inside the loop's results folder.
   - NEVER point outputs, scripts or the evaluator at the project-root results/ or analysis/ folders,
     and never walk up directories to find the project root. Do not add a step that saves a separate
     script file - the code is already kept in the loop's code history.
   - INPUTS: list every input file the evaluator reads in "inputs", as the RUN ENVIRONMENT sees it: a
     project-relative path ("data/reads.fasta") or an absolute path on the run host the user gave you.
     The run environment (WSL, the Mac VM, an SSH server) sees the project at a DIFFERENT path than
     projectRoot, and an SSH server may not have the project's data/ at all - so if it is unclear where
     the data lives on the run host, ASK the user. In the evaluator, resolve project-relative inputs with
         ROOT = os.environ.get("QOKA_PROJECT_ROOT") or os.path.abspath("../../..")
     and os.path.join(ROOT, "data", ...). NEVER write projectRoot (the local path) into the evaluator:
     save_loop refuses it, and before the loop starts Qoka checks that every "inputs" path exists where
     the evaluator runs.
12. FEASIBILITY: when success is a numeric target on given data, look at the data before committing and,
   when it is cheap, measure a quick baseline (run_code). If the target looks far beyond what the data
   allows (no signal, noisy reference labels, a target near a perfect score), say so plainly in the
   summary so the user can change it before any budget is spent.

If a rule (1, 3, or 9) says ask/offer instead of committing, output ONLY that question or those 2-4
options - no loop.

Otherwise present the loop FOR APPROVAL AS A SHORT SUMMARIZED PLAN in PLAIN, NATURAL LANGUAGE - not
code - and explicitly ask whether this is the loop flow they want. The user is often not a programmer,
so:
- Give a compact summary in the user's own language covering, as a few bullets: the GOAL; WHAT HAPPENS
  each iteration (the steps in order); the INPUT DATA it uses (which files, and where they are on the
  machine that runs the loop); HOW SUCCESS IS DECIDED as ONE plain-language sentence (e.g.
  "passes when the mean is within 0.02 of 0 and the standard deviation is between 0.98 and 1.02"); the
  REQUIRED OUTPUT FILES that will exist when it finishes (saying which ones you ADDED beyond what the
  user asked for, and why); and the BUDGET (max iterations + max TOTAL
  minutes for the whole loop).
- Do NOT paste the evaluator source code, the LoopSpec JSON, or long code blocks into the approval
  message. At most, if the user is technical and asks, offer to show the evaluator code - otherwise
  keep it hidden. The evaluator is still built and locked internally; the user just does not need to
  read code to approve.
- Then ask, in the user's own language, a clear confirmation such as "is this the loop flow you want?"
  - confirming the budget (iterations + total minutes) and noting it runs sub-agents in the
  background and consumes their tokens. Wait for an explicit yes.
Only after the user agrees do you call save_loop(spec), then start_loop(loopId) to run it in the
background. The user (not the agent) approves the evaluator; it is then sha256-locked so the work
agent cannot alter it.

EVALUATOR PROTOCOL (enforced by the engine - an evaluator that breaks it will not start):
- evaluator.code is EXECUTABLE code (language "python", "bash" or "node") that ALWAYS ends by printing
  exactly ONE JSON line on stdout: {"pass": true|false, "detail": "..."}. The exit code alone is NOT a
  verdict: no JSON = fail. A pass also needs a clean exit (exit 0).
- It must print a FAIL verdict - never crash - when the expected output files do not exist yet or
  cannot be read: wrap the checks (e.g. try/except in Python) and print {"pass": false, "detail":
  "<file> missing"}. Before the loop starts, Qoka runs the evaluator ONCE on the empty results folder:
  if it prints no JSON there, or already PASSES there, the loop is refused and you must fix it.
- ONLY WHAT THE USER WILL SEE: every result file the evaluator opens must be listed in flow.output with
  its format (columns / JSON keys the evaluator requires), because flow.output is what the plan summary
  shows the user. Do not require extra files the user did not ask for (a re-run copy, a separate
  control output, a report) just to make the check stronger: compute controls INSIDE the evaluator from
  the requested outputs and the inputs. If an extra file is truly needed, list it in flow.output and
  name it in the summary so the user approves it.
- WHERE IT RUNS: write the evaluator in Python. A python evaluator runs via uv in its OWN environment that
  holds ONLY the standard library plus the pip packages listed in evaluator.dependencies - NOT the
  packages the work installs, and not the server's system Python. Prefer the standard library (csv, json,
  math, statistics, gzip, re: AUC, RMSE, ARI and counts are a few lines by hand). When a check truly
  needs a package (e.g. reading .h5ad needs ["anndata"], a PNG's pixels need ["pillow"]), list it in
  evaluator.dependencies (pip names: "scikit-learn" for sklearn, "pillow" for PIL); the list is locked
  with the code. Before the loop starts Qoka refuses an evaluator that imports anything not available
  there, including imports placed after an early "file missing" exit.
- "detail" is a SHORT ONE-LINE cause that includes the MEASURED VALUE next to the target (e.g.
  "ARI=0.72 < 0.9", "row count 180 != 200", "3/5 checks passed: legend missing"), NOT a traceback or
  multi-line log. It is shown in the iteration history, fed to the next iteration as the fix-this
  feedback, and used to detect a stall: when the SAME detail repeats 3 times in a row the loop pauses and
  asks the user, so a detail without the measured value would hide real progress. On PASS the detail
  can be a short confirmation.
- A goal that is not naturally numeric (e.g. "a clean UMAP figure") is turned into a CHECKLIST of
  objective conditions (file exists, axis labels present, no unlabeled cells, dpi >= 300); pass = all
  checks pass, detail = how many passed and which failed. A goal that cannot be reduced to objective
  checks at all (purely aesthetic or persuasive quality) is NOT a loop: say so and offer a one-shot
  run_code or a step the user reviews instead.
{
  "title": "short title in PLAIN WORDS (2-5 words, e.g. \"normal sampling convergence\"). It becomes the loop's folder name, so avoid bare math/symbol notation like \"N(0,1)\" which slugs to noise",
  "goal": "one sentence goal",
  "flow": {
    "input": "what it starts from",
    "steps": ["step 1", "step 2", "..."],  // the REAL ordered execution steps of ONE iteration (e.g. "install tools", "prepare inputs", "run analysis", "write output"). These become the user's PROGRESS BAR: the count is the total, and the sub-agent marks each with [QOKA_STEP k/N] as it runs. Make them concrete and in execution order; do NOT include a trailing "on fail: retry" step (retry is automatic, not a step).
    "checks": [{ "c": "condition", "why": "why this makes the loop trustworthy (e.g. a negative control)" }],
    "output": "what it produces, as RELATIVE file names inside the loop's results folder (rule 11)",
    "stops": "<maxIter> iterations or <maxMin> min in total (rule 10)"
  },
  "inputs": ["data/..."],  // every input file the evaluator reads, as the run environment sees it (rule 11)
  "evaluator": { "code": "...executable check...", "language": "python", "dependencies": [] },  // dependencies: pip packages the evaluator imports beyond the standard library (usually none)
  "budget": { "maxIter": <N>, "maxMin": <N x T> },  // numbers estimated FOR THIS TASK per rule 10
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
	if (s.inputs !== undefined && (!Array.isArray(s.inputs) || s.inputs.some(x => typeof x !== 'string'))) { return undefined; }
	const deps = s.evaluator.dependencies;
	if (deps !== undefined && (!Array.isArray(deps) || deps.some(d => typeof d !== 'string' || !/^[A-Za-z0-9._\-\[\],<>=!~ ]+$/.test(d)))) { return undefined; }
	return s as LoopSpec;
}

/** Places in a spec that point outside the loop's own folder (rule 11). Loop outputs and code must
 *  stay in loops/<folder>/, where the evaluator looks and the per-iteration clear and code history
 *  reach. `relative`: bare results/ or analysis/ paths - always wrong, since run_code and the evaluator
 *  run inside loops/<folder>/results. `absolute`: the project-root results/ or analysis/ by absolute
 *  path - wrong for outputs, but may be a legitimate INPUT (e.g. an earlier run_code result). */
function outsideLoopPaths(spec: LoopSpec, projectRoot: string | undefined): { relative: string[]; absolute: string[] } {
	const texts: Array<[string, string]> = [
		['flow.output', String(spec.flow?.output ?? '')],
		...(spec.flow?.steps ?? []).map((s, i): [string, string] => [`flow.steps[${i}]`, String(s)]),
		['evaluator.code', spec.evaluator.code],
	];
	const bare = /(^|[\s'"`(=,[])(\.\/)?(results|analysis)\/[^\s'"`)]*/gm;
	const relative: string[] = [];
	const absolute: string[] = [];
	for (const [where, text] of texts) {
		for (const m of text.matchAll(bare)) { relative.push(`${where}: ${m[0].trim()}`); }
		if (projectRoot) {
			for (const dir of ['results', 'analysis']) {
				if (text.includes(path.join(projectRoot, dir))) { absolute.push(`${where}: ${path.join(projectRoot, dir)}`); }
			}
		}
	}
	return { relative: [...new Set(relative)].slice(0, 10), absolute: [...new Set(absolute)].slice(0, 10) };
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
	// Evaluator runs in the SAME dir run_code writes to (loops/<folder>/results), so relative paths align
	// and outputs stay contained under loops/ - never the project-root results//analysis//data/.
	const evaluatorRunner = runEnvEvaluatorRunner(`loops/${folder}/results`);
	// run_code writes each run's stdout.log to the flat loops/<folder>/results dir; read it through the
	// run env so live [QOKA_STEP] markers reach the progress bar even on a remote SSH server.
	const readIterLog = runEnvLogReader(`loops/${folder}/results/stdout.log`);
	const resuming = run.iteration > 0;
	// A fresh loop: run the locked evaluator once on the empty results folder first. A broken evaluator
	// (no JSON verdict, or passing with no work done) is locked for the whole run and the sub-agent cannot
	// fix it, so refuse to start and send it back to the chat for a fix + re-approval.
	if (!resuming && run.history.length === 0) {
		try { fs.mkdirSync(resultsDir, { recursive: true }); } catch { /* remote run env creates its own */ }
		const pf = await preflightEvaluator(run, evaluatorRunner);
		loopLog(`preflight ${id}: ${pf.ok ? 'ok' : 'REFUSED'} - ${pf.verdict.detail}`);
		if (!pf.ok) {
			abortControllers.delete(id);
			return err(JSON.stringify({
				started: false, loopId: id, problem: pf.problem,
				evaluatorOutput: (pf.verdict.raw ?? '').slice(-1500),
				next: 'Do NOT start this loop. Tell the user (in their language) briefly what is wrong with the success check, fix evaluator.code so it follows the EVALUATOR PROTOCOL from design_loop, show the user the corrected one-sentence success rule and get their approval (the success criterion changed), then call save_loop with the corrected spec and start_loop with the NEW loopId.',
			}));
		}
	}
	void vscode.commands.executeCommand('qoka.loop.open', id);
	void runLoop(run, agentStep, { loopDir: dir, cwd, evaluatorRunner, readIterLog, killWork: runEnvWorkKiller(`loops/${folder}`), persist: writeLoop, shouldStop: () => stopRequested.has(id), codeDir, resultsDir, captureDir, gitPath, log: loopLog })
		.then(outcome => { stopRequested.delete(id); abortControllers.delete(id); console.log(`[qoka-loop] loop ${id} finished: ${outcome}`); void notifyLoopFinished(id, outcome); })
		.catch(e => { stopRequested.delete(id); abortControllers.delete(id); console.error(`[qoka-loop] loop ${id} crashed:`, e); });
	return ok(JSON.stringify({ started: true, resumed: resuming, loopId: id, fromIteration: run.iteration, tools: Object.keys(workMcpServers),
		tell_user: 'The loop is running. Tell the user (in their language) to watch it live in the loop detail tab: a "Progress" section appears UNDER the Flow with the current iteration and step. It only shows while the loop runs.' }));
}

export function buildTools(): ToolDefinition[] {
	return [
		{
			name: 'design_loop',
			description: 'Get the instruction and project context for designing a research loop. WHEN TO CALL: when the request is loop-shaped - REPEATED work toward a goal/threshold/condition (in any language, e.g. "keep improving X until Y"), or when the user said "loop". Do NOT call it for an ordinary one-off task that finishes in a single pass - use the normal tools (run_code etc.) for that. If it is AMBIGUOUS (could be either), do NOT call this yet: first ASK the user in chat (in their own language) whether to run it once with run_code or as a repeating loop, and call design_loop ONLY after they choose the loop. Returns the design rules (you then write a LoopSpec that follows them) plus the open project context. The rules require you to re-ask for any missing stop condition / required output files / budget, then show a summarized plan and ask "is this the loop flow you want?" - only on approval call save_loop.',
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
				if (!spec) { return err('Invalid LoopSpec: need title, goal, flow.steps, and evaluator.code (inputs and evaluator.dependencies, if given, must be lists of strings: file paths / pip package names).'); }
				const b = spec.budget;
				if (!b || !(Number(b.maxIter) >= 1) || !(Number(b.maxMin) > 0)) {
					return err('Not saved: the LoopSpec has no budget. Estimate one FOR THIS TASK (design rule 10: time per iteration = the work + the evaluator\'s run time + a margin; iterations = how many attempts the goal needs; maxMin = their product, the TOTAL minutes), show the user the breakdown, get their yes, and put it in "budget": {"maxIter": N, "maxMin": M}.');
				}
				const outside = outsideLoopPaths(spec, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
				if (outside.relative.length) {
					return err('Not saved: the LoopSpec writes or checks files outside the loop\'s own folder (design rule 11). '
						+ 'Rewrite these as RELATIVE file names (they resolve inside loops/<loop-folder>/results, where run_code and the evaluator run) '
						+ 'and drop any step that saves a separate script, then call save_loop again. The user does not need to re-approve a path-only change.\n'
						+ outside.relative.map(h => `  - ${h}`).join('\n'));
				}
				const localRoot = findLocalRootLiteral(spec.evaluator.code, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
				if (localRoot) {
					return err(`Not saved: the evaluator contains the LOCAL project path ${localRoot}. The evaluator runs in the run environment (WSL, the Mac VM or an SSH server), which sees the project at a different path, so it could never read its inputs there. `
						+ 'Resolve project files with ROOT = os.environ.get("QOKA_PROJECT_ROOT") or os.path.abspath("../../..") and os.path.join(ROOT, "data", ...), list them in "inputs" (design rule 11), then call save_loop again. The user does not need to re-approve a path-only change.');
				}
				const lang = (spec.evaluator.language ?? 'python').toLowerCase();
				const doubled = lang.startsWith('py') ? findDoubleEscapedRawString(spec.evaluator.code) : undefined;
				if (doubled) {
					return err(`Not saved: the evaluator has a raw string with a doubled backslash: ${doubled}. Inside a raw string, r"\\\\d" matches a literal backslash followed by "d", so this check can never match real data (the escapes were doubled once too often when the code was written into JSON). `
						+ 'Use a single backslash inside raw strings (r"\\d+", r"\\s"), then call save_loop again. The user does not need to re-approve this fix.');
				}
				const run = saveLoop(spec);
				if (!run) { return err('No open project to save the loop into. Open a project folder first.'); }
				// Auto-open the (display-only) Loops tab on the fresh draft so the user can review it
				// while the chat asks for confirmation. All loop control stays in the chat (decision B).
				void vscode.commands.executeCommand('qoka.loop.open', run.id);
				const warning = outside.absolute.length
					? 'The spec references the project-root results/ or analysis/ folder by absolute path. That is fine ONLY for reading inputs; '
						+ 'if any of these are outputs or scripts, fix them to relative names inside the loop\'s results folder, call save_loop again and start the NEW loopId instead:\n'
						+ outside.absolute.map(h => `  - ${h}`).join('\n')
					: undefined;
				return ok(JSON.stringify({ loopId: run.id, status: run.status, savedAt: run.createdAt, ...(warning ? { warning } : {}) }));
			},
		},
		{
			name: 'start_loop',
			description: 'Start running an APPROVED loop in the background. The engine sha256-locks the evaluator, then repeats: a sub-agent does the work with the full Qoka work toolset (run_code, pipelines, paper, notes, ...), the locked evaluator runs IN the run environment and judges, until it passes or the budget (iterations / total minutes) runs out. If the same failure repeats 3 times it PAUSES (not fails) with a history report for the user to decide. Before a NEW loop starts (and before the evaluator is locked), the evaluator is run once on the empty results folder and every "inputs" path is checked to exist in the run environment; if it prints no JSON verdict, already passes, cannot import a package or an input is missing, start_loop refuses with the reason - fix the evaluator, get the user\'s re-approval, save_loop and start the new loopId. Returns immediately. Do NOT poll; right after it returns, tell the user (in their language) that the loop started and to watch the live "Progress" section that appears UNDER the Flow in the loop detail tab (it only shows while running). Only call after the user has confirmed the loop.',
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
			description: 'Resume a PAUSED, STOPPED or budget-exhausted loop from where it left off (continues its iteration count, history and the last fix-this feedback). Use when the user asks to continue a loop that paused (environment error, a TIMED-OUT iteration, or NO CHANGE - the same failure repeated 3 times, after the user saw its report and chose to continue) or stopped. maxMin is the TOTAL time budget across all sessions; pass a larger maxMin and/or maxIter to give the loop more room (required when the budget is already used up).',
			inputSchema: {
				type: 'object',
				properties: {
					loopId: { type: 'string', description: 'The loop id from loop_list.' },
					maxMin: { type: 'number', description: 'Optional NEW total time budget in minutes, across all sessions; an iteration may use only what is left of it. Pass a larger value to fix a pause where the time ran out mid-iteration.' },
					maxIter: { type: 'number', description: 'Optional NEW maximum iteration count. Pass a larger value if the loop needs more attempts.' },
				},
				required: ['loopId'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = typeof args.loopId === 'string' ? args.loopId : '';
				const run = readLoop(id);
				if (!run) { return err(`No loop with id ${id}.`); }
				if (run.status === 'running') { return err(`Loop ${id} is already running.`); }
				if (run.status === 'success') { return err(`Loop ${id} already succeeded - nothing to resume.`); }
				if (run.evaluatorMissingModule) {
					return err(`Loop ${id} cannot continue: its locked evaluator cannot import "${run.evaluatorMissingModule}" in its own environment, so no attempt can pass. Tell the user (in their language), then redesign: keep the same goal and success rule, add the package to evaluator.dependencies (or use the standard library), get their approval, save_loop and start_loop the new loopId.`);
				}
				const newMin = typeof args.maxMin === 'number' && args.maxMin > 0 ? Math.floor(args.maxMin) : undefined;
				const newIter = typeof args.maxIter === 'number' && args.maxIter > 0 ? Math.floor(args.maxIter) : undefined;
				if (newMin || newIter) {
					if (newMin) { run.budget.maxMin = newMin; }
					if (newIter) { run.budget.maxIter = newIter; }
					writeLoop(run);
				}
				const usedMin = (run.budget.usedMs ?? 0) / 60_000;
				if (run.iteration >= run.budget.maxIter || usedMin >= run.budget.maxMin) {
					return err(`Loop ${id} has no budget left (${run.iteration}/${run.budget.maxIter} iterations, ${usedMin.toFixed(1)}/${run.budget.maxMin} min used). Ask the user how much more to allow, then call resume_loop with a larger maxIter and/or maxMin (maxMin is the total across all sessions).`);
				}
				return launchLoop(id);
			},
		},
		{
			name: 'propose_alternatives',
			description: 'When a loop PAUSED on no change (the same failure repeated) or FAILED (budget exhausted) and the user wants another way, get its failure context so you can propose 2 concrete ALTERNATIVE loop designs (a different approach and/or a different evaluator) and ask the user which to pursue. Returns the loop\'s reason, the no-change report if any, and recent failures; you then present the 2 options in chat (do not auto-run).',
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
					stallReport: run.stall?.report ?? null,
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
				if (run.status === 'paused' && run.goalUnreachable) {
					return ok(JSON.stringify({
						...run,
						next: 'This loop PAUSED because the sub-agent reported that the GOAL cannot be reached with this data (goalUnreachable; its full note is in the last history entry agentNote). Tell the user (in their language) what evidence it gave and whether it looks right to you, then let them choose: change the goal (e.g. a reachable target, other data) via a new loop, ask for alternatives (propose_alternatives), stop, or continue as is (resume_loop) if they think the sub-agent is wrong. Do not decide for them.',
					}));
				}
				if (run.status === 'paused' && run.evaluatorIssue) {
					return ok(JSON.stringify({
						...run,
						next: 'This loop PAUSED because the sub-agent reported that the locked evaluator itself cannot pass correct work (evaluatorIssue; its full note is in the last history entry agentNote). Tell the user (in their language) what it found and whether the evidence looks right to you, then let them choose: fix the evaluator (redesign: same goal and success rule, corrected check, their approval, save_loop + start_loop the new loopId), or continue as is (resume_loop) if they think the sub-agent is wrong. Do not decide for them.',
					}));
				}
				if (run.status === 'paused' && run.evaluatorMissingModule) {
					return ok(JSON.stringify({
						...run,
						next: `This loop PAUSED because its locked evaluator cannot import "${run.evaluatorMissingModule}" - a design problem the loop cannot fix itself (resume_loop will refuse). Tell the user (in their language) and offer to redesign it with the package in evaluator.dependencies (same goal and success rule), then save_loop + start_loop after their approval.`,
					}));
				}
				if (run.status === 'paused' && run.stall) {
					return ok(JSON.stringify({
						...run,
						next: 'This loop PAUSED because nothing changed (the same failure repeated). Show the user stall.report (the recent iterations, budget used, where the code versions are) in their language, briefly say whether the history suggests it is stuck on something the loop cannot fix itself (a missing tool, data or permission) or might still improve, and ask them to choose: continue (resume_loop, optionally with more budget), stop, or alternative designs (propose_alternatives). Do not decide for them.',
					}));
				}
				return ok(JSON.stringify(run));
			},
		},
	];
}
