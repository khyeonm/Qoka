/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The deterministic controller (loop_engine_design.md sections 14-15). This module is
// intentionally vscode-free: all paths and the persist callback are injected, so the
// control logic can be unit-tested headlessly. The engine RUNS the loop and JUDGES each
// iteration with the sha256-locked evaluator; it never edits the work code - that is the
// sub-agent's job, fed the previous verdict as feedback.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { LoopRun, LoopHistoryEntry, LoopStall } from './schema';

/** How many identical failures in a row count as "no progress". */
export const NO_PROGRESS_N = 3;

/** What a single sub-agent turn returns to the engine. */
export interface AgentResult {
	output: string;
	exitCode: number | null;
	/** Set when the turn hit an environment problem (auth/quota/CLI down) - the engine
	 *  pauses instead of counting it as a failure. */
	envError?: boolean;
	error?: string;
	/** The literal RAW run_code source the sub-agent executed this turn, saved as a clean source
	 *  file so the Loops tab shows the real work - not just the narration. Undefined when none. */
	code?: string;
	/** Language of `code` (python/node/...), for the saved file's extension. */
	codeLanguage?: string;
	/** Tokens used this turn (input + output), accumulated into the run's budget for live display. */
	tokens?: number;
	/** The turn hit its time limit before finishing - the engine pauses (not fail) so the user can
	 *  raise the loop's time budget and resume, instead of the same timeout repeating every iteration. */
	timedOut?: boolean;
}

/** A sub-agent turn: does the work for one iteration, given the previous verdict as
 *  feedback. Injected so the engine can be tested with a mock and run with a real
 *  headless CLI (agent_step, M1b). */
export type AgentStep = (run: LoopRun, feedback: string | undefined, limits?: TurnLimits) => Promise<AgentResult>;

/** Per-turn limits from the engine. `timeoutMs` is what is LEFT of the loop's total time budget, so one
 *  long turn cannot carry the loop past maxMin. */
export interface TurnLimits { timeoutMs: number }

/** Time kept free for the evaluator before a turn starts: its last measured run time x1.5 + 10 s (a minute
 *  and a half before it has run), at least 30 s, at most a quarter of what is left - the evaluator's run
 *  counts against the loop's time budget like the sub-agent's work. */
export function evalReserveMs(run: LoopRun, remainingMs: number): number {
	const est = Math.max(30_000, (run.evalMs ?? 60_000) * 1.5 + 10_000);
	return Math.min(est, remainingMs * 0.25);
}

/** A turn shorter than this is not worth starting: the loop ends as out of budget instead. Capped at a
 *  tenth of the budget so a tiny budget still gets turns. */
export const MIN_TURN_MS = 60_000;
export function minTurnMs(maxMin: number): number { return Math.min(MIN_TURN_MS, maxMin * 60_000 * 0.1); }

/** The evaluator's deterministic verdict. `detail` is the SHORT one-line cause (history/UI); `raw` is the
 *  FULL evaluator stdout+stderr, fed to the next iteration so the sub-agent can fix the real error. */
export interface Verdict {
	pass: boolean;
	detail: string;
	raw?: string;
	/** True when the evaluator printed a JSON verdict object; false means the protocol was not followed. */
	json?: boolean;
	/** Set when the evaluator's output shows it could not import a module (the name, or '?' when the
	 *  name is not in the message): the evaluator cannot judge, whatever the work produced. */
	missingModule?: string;
}

/** 'paused' covers an environment error, a timed-out turn, and a no-change stall (same failure
 *  repeated) - in every case the loop is resumable and the reason is on the run. */
export type LoopOutcome = 'success' | 'failed-budget' | 'paused' | 'stopped';

/** Runs a script and returns its result. Injected so the evaluator executes WHERE the work
 *  happened: the extension provides a runner that executes in the RUN environment (SSH/WSL/
 *  vfkit), the same place the sub-agent's run_code wrote its files; the test provides a local
 *  one. Without this the engine would run the evaluator locally and miss a remote file. */
export type ScriptRunner = (script: string, language: string | undefined, dependencies?: string[], limits?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

export interface RunOptions {
	/** <project>/.qoka/loops - where the locked evaluator artifact is written. */
	loopDir: string;
	/** Working directory the evaluator (and the sub-agent's work) runs in. */
	cwd: string;
	/** Execute the locked evaluator in the run environment (see ScriptRunner). */
	evaluatorRunner: ScriptRunner;
	/** Persist the run after every state change (the resume point). */
	persist: (run: LoopRun) => void;
	/** Checked at the top of every iteration; returning true stops the loop cleanly (status
	 *  'stopped'). Lets the user cancel a running loop from the chat (stop_loop tool). */
	shouldStop?: () => boolean;
	/** VISIBLE git-versioned code folder (loops/<folder>/code): each iteration overwrites
	 *  solution.<ext> and commits it, so the working tree is the latest code and `git log` is the full
	 *  attempt history (pass + fail). Unset (tests) -> no code recording. */
	codeDir?: string;
	/** This loop's results folder (loops/<folder>/results): cleared before each iteration so, when the
	 *  loop ends, only the FINAL run's outputs remain. Unset -> not cleared. */
	resultsDir?: string;
	/** Read the CURRENT iteration's live stdout.log text from INSIDE the run environment. Needed for a
	 *  REMOTE SSH run, whose log lives only on the server mid-run (the local resultsDir stays empty until
	 *  the run finishes), so tailing the local file shows no progress. Mounted local envs can still use
	 *  resultsDir. When set, the live-progress poller reads through this instead of the local file. */
	readIterLog?: () => Promise<string | undefined>;
	/** git binary for code versioning (bundled MinGit path on Windows, else 'git'). Defaults to 'git'. */
	gitPath?: string;
	/** Hidden dir (.qoka/<loopScope>/code) where run_code drops each run's REAL script under <runId>/.
	 *  The engine copies the scripts written THIS iteration into codeDir so the version shows real code,
	 *  not just the transcript-parsed capture. Unset -> falls back to the transcript code. */
	captureDir?: string;
	/** Stop every process this loop still has running in the run environment (run_code scripts and the
	 *  evaluator, tagged with the loop's scope). A sub-agent turn that is cut off or stopped only ends the
	 *  agent; the code it started would otherwise keep running there. Called before each iteration and when
	 *  the loop ends. Unset (tests) -> nothing to stop. */
	killWork?: () => Promise<void>;
	/** Called before each iteration: a reason when the active run target is no longer the one the loop
	 *  started on (the loop then pauses instead of running its work or evaluator somewhere else). */
	runTargetChanged?: () => Promise<string | undefined>;
	/** Diagnostics sink (the "Qoka Loop" output channel). Injected so the engine stays vscode-free. */
	log?: (msg: string) => void;
}

function sha256(s: string): string {
	return crypto.createHash('sha256').update(s).digest('hex');
}

function evaluatorPath(run: LoopRun, loopDir: string): string {
	const lang = run.spec.evaluator.language;
	const ext = lang === 'python' ? 'py' : lang === 'node' ? 'js' : 'sh';
	return path.join(loopDir, run.id, `evaluator.${ext}`);
}

/** Extension for a run_code language, for the saved iteration source file. */
function codeExt(language?: string): string {
	switch (language) {
		case 'python': return 'py';
		case 'node': case 'javascript': case 'js': return 'js';
		case 'bash': case 'sh': case 'shell': return 'sh';
		case 'r': case 'R': return 'R';
		default: return 'txt';
	}
}

/** A clean git environment: drop any inherited GIT_DIR / GIT_WORK_TREE (etc.) so our `-C codeDir`
 *  operations always target the loop's OWN nested repo, never the workspace repo aria-vcs manages. */
function gitEnv(): NodeJS.ProcessEnv {
	const e = { ...process.env };
	delete e.GIT_DIR; delete e.GIT_WORK_TREE; delete e.GIT_INDEX_FILE; delete e.GIT_COMMON_DIR; delete e.GIT_OBJECT_DIRECTORY;
	return e;
}

/** Run a git subcommand in `cwd` (best-effort; git may be absent). `-c safe.directory=*` disarms git's
 *  "dubious ownership" refusal (common on Windows for a freshly created nested repo). Returns ok +
 *  captured stderr so the caller can log WHY a commit did nothing instead of swallowing the error. */
function git(gitBin: string, cwd: string, args: string[]): { ok: boolean; err?: string } {
	try { execFileSync(gitBin, ['-c', 'safe.directory=*', ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: gitEnv() }); return { ok: true }; }
	catch (e) {
		const err = e as { stderr?: Buffer; message?: string };
		return { ok: false, err: ((err.stderr && err.stderr.toString()) || err.message || 'unknown').trim().slice(0, 200) };
	}
}

/** Empty (and recreate) a directory. */
function clearDir(dir: string): void {
	try { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
}

/** Record one iteration's code as a git version: overwrite solution.<ext> in the loop's code folder
 *  and commit it (message = "iter N: pass/fail - reason"). The working tree stays the latest code; the
 *  commit history is every attempt (pass + fail), so the Files tab can show a version tree. Local repo,
 *  no remote / GitHub. Best-effort: if git is missing it just leaves solution.<ext> uncommitted. */
/** One real script file the sub-agent executed this iteration (relative path + content). */
interface CapturedScript { rel: string; content: string; }

/** Read the run_code scripts written THIS iteration: each run drops its script under captureDir/<runId>/;
 *  we pick files touched at/after `sinceMs` (so a reused run label that overwrites in place is still
 *  caught by mtime, not by a new folder name). Returns them keyed by "<runId>/<file>" so multiple runs
 *  don't collide. Best-effort. */
function captureIterationScripts(captureDir: string, sinceMs: number): CapturedScript[] {
	const out: CapturedScript[] = [];
	let subs: fs.Dirent[];
	try { subs = fs.readdirSync(captureDir, { withFileTypes: true }); } catch { return out; }
	for (const sub of subs) {
		if (!sub.isDirectory()) { continue; }
		const subAbs = path.join(captureDir, sub.name);
		let files: fs.Dirent[];
		try { files = fs.readdirSync(subAbs, { withFileTypes: true }); } catch { continue; }
		for (const f of files) {
			if (!f.isFile() || f.name.startsWith('.')) { continue; }
			const abs = path.join(subAbs, f.name);
			let m = 0;
			try { m = fs.statSync(abs).mtimeMs; } catch { continue; }
			if (m >= sinceMs) {
				try { out.push({ rel: `${sub.name}/${f.name}`, content: fs.readFileSync(abs, 'utf8') }); } catch { /* skip */ }
			}
		}
	}
	return out;
}

/** Empty a git working tree of everything except .git, so each commit is exactly THIS iteration's code. */
function clearWorkTree(dir: string): void {
	let entries: string[];
	try { entries = fs.readdirSync(dir); } catch { return; }
	for (const e of entries) {
		if (e === '.git') { continue; }
		try { fs.rmSync(path.join(dir, e), { recursive: true, force: true }); } catch { /* best-effort */ }
	}
}

function commitIterationCode(gitBin: string, codeDir: string, iteration: number, code: string | undefined, codeLanguage: string | undefined, verdict: 'pass' | 'fail', detail: string, scripts: CapturedScript[], log?: (m: string) => void): void {
	try {
		fs.mkdirSync(codeDir, { recursive: true });
		if (scripts.length) {
			// Preferred: the REAL executed scripts. Reset the tree to just this iteration's files.
			clearWorkTree(codeDir);
			for (const s of scripts) {
				const dest = path.join(codeDir, s.rel);
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.writeFileSync(dest, s.content);
			}
			log?.(`commit iter ${iteration}: gitBin=${gitBin} codeDir=${codeDir} realScripts=${scripts.map(s => s.rel).join(', ')}`);
		} else {
			// Fallback: the transcript-parsed source (or a placeholder when even that is empty).
			const hadCode = !!(code && code.trim());
			const body = hadCode ? (code as string).trim() : '# (no code captured this iteration)';
			const file = `solution.${codeExt(codeLanguage)}`;
			clearWorkTree(codeDir);
			fs.writeFileSync(path.join(codeDir, file), body + '\n');
			log?.(`commit iter ${iteration}: gitBin=${gitBin} codeDir=${codeDir} wrote=${file} codeCaptured=${hadCode} (no real scripts found)`);
		}
		if (!fs.existsSync(path.join(codeDir, '.git'))) {
			const r = git(gitBin, codeDir, ['init', '-q']);
			log?.(`  git init: ${r.ok ? 'ok' : 'FAILED ' + r.err}`);
			if (!r.ok) { return; }
		}
		const ra = git(gitBin, codeDir, ['add', '-A']);
		if (!ra.ok) { log?.(`  git add: FAILED ${ra.err}`); return; }
		const reason = (detail || '').replace(/\s+/g, ' ').trim().slice(0, 100);
		const msg = `iter ${iteration}: ${verdict}${reason ? ` - ${reason}` : ''}`;
		const rc = git(gitBin, codeDir, ['-c', 'user.name=Qoka', '-c', 'user.email=loops@qoka.local', 'commit', '-q', '--allow-empty', '-m', msg]);
		log?.(`  git commit: ${rc.ok ? 'ok - ' + msg : 'FAILED ' + rc.err}`);
	} catch (e) { log?.(`commit iter ${iteration}: EXCEPTION ${(e as Error).message}`); }
}

/** Materialize the evaluator to a file and record its sha256 = the lock. Called once at
 *  the start of a run. From here the engine only ever runs THIS artifact. */
export function materializeAndLockEvaluator(run: LoopRun, loopDir: string): void {
	const p = evaluatorPath(run, loopDir);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const code = run.spec.evaluator.code;
	fs.writeFileSync(p, code);
	// The package list is part of what judges, so it is locked with the code (unchanged hash without one).
	const deps = evaluatorDeps(run);
	const hash = sha256(deps.length ? `${code}\n#qoka-evaluator-dependencies:${JSON.stringify(deps)}` : code);
	run.lockedEvaluatorRef = { path: p, hash };
	run.spec.evaluator.hash = hash;
}

/** Run the locked evaluator via the injected runner and return a deterministic verdict. The
 *  SOURCE OF TRUTH is `run.spec.evaluator.code` (locked in engine state at approval - the
 *  sub-agent has no access to it), so there is nothing on disk for the sub-agent to tamper
 *  with. Executes WHERE the work happened (the ScriptRunner runs in the run environment).
 *  Verdict protocol: a JSON {"pass": bool, "detail": string} on stdout wins; else exit 0 = pass. */
export async function runLockedEvaluator(run: LoopRun, runner: ScriptRunner, limits?: { timeoutMs?: number }): Promise<Verdict> {
	const code = run.spec.evaluator.code;
	if (!code) { return { pass: false, detail: 'no locked evaluator' }; }
	let r: { stdout: string; stderr: string; exitCode: number | null };
	const t0 = Date.now();
	try {
		r = await runner(code, run.spec.evaluator.language, evaluatorDeps(run), limits);
		run.evalMs = Date.now() - t0;
	} catch (e) {
		return { pass: false, detail: `evaluator failed to run: ${(e as Error).message}`, raw: (e as Error).message };
	}
	// The FULL evaluator output (stdout+stderr) is kept as `raw` so the engine can feed the real cause
	// (a traceback, "file not found", a metric dump) to the NEXT iteration - the one-line `detail` is
	// only for the history/UI.
	const raw = [r.stdout, r.stderr].filter(s => s && s.trim()).join('\n').trim();
	const j = findVerdictJson(r.stdout);
	if (j) {
		const d = j.detail;
		const detail = typeof d === 'string' ? d : d === undefined || d === null ? '' : JSON.stringify(d);
		// A pass needs BOTH the JSON verdict and a clean exit: an evaluator that printed pass and then
		// crashed (or was killed) did not finish its checks.
		if (j.pass === true && r.exitCode !== 0) {
			return { pass: false, detail: `evaluator reported pass but exited abnormally (exit ${r.exitCode ?? 'killed'})`, raw, json: true };
		}
		const missing = j.pass === true ? undefined : findMissingModule(raw);
		return { pass: j.pass === true, detail, raw, json: true, ...(missing ? { missingModule: missing } : {}) };
	}
	// Strict protocol: no JSON verdict is never a pass, whatever the exit code (a shell evaluator without
	// `set -e` exits 0 when only its last command succeeds). The raw output still reaches the next
	// iteration, so a crash caused by a missing output file is fixable by the sub-agent.
	const why = firstLine(r.stderr) || firstLine(r.stdout) || 'no output';
	const missing = findMissingModule(raw);
	return { pass: false, detail: `evaluator printed no JSON verdict (exit ${r.exitCode ?? 'killed'}): ${why}`.slice(0, 300), raw, json: false, ...(missing ? { missingModule: missing } : {}) };
}

/** The evaluator's declared packages, cleaned (strings only, trimmed, de-duplicated, sorted). */
export function evaluatorDeps(run: LoopRun): string[] {
	const d = run.spec.evaluator.dependencies;
	if (!Array.isArray(d)) { return []; }
	return [...new Set(d.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean))].sort();
}

/** Name of the module an import failure in the evaluator's output names, '?' for an import failure
 *  without a name, or undefined. Python's "No module named 'x'" (ModuleNotFoundError, also when an
 *  evaluator catches it and puts it in its detail) and "cannot import name" are both import failures. */
export function findMissingModule(raw: string | undefined): string | undefined {
	if (!raw) { return undefined; }
	const m = /No module named ['"]?([A-Za-z0-9_.]+)['"]?/.exec(raw);
	if (m) { return m[1].split('.')[0]; }
	if (/ModuleNotFoundError|ImportError/.test(raw)) { return '?'; }
	return undefined;
}

/** A Python script that lists the evaluator's top-level absolute imports (any nesting, so imports placed
 *  after an early "file missing" exit count too) that cannot be found in the environment it runs in. */
function importCheckScript(code: string): string {
	const b64 = Buffer.from(code, 'utf8').toString('base64');
	return [
		'import ast, base64, importlib.util, json',
		`src = base64.b64decode('${b64}').decode('utf-8')`,
		'mods = set()',
		'try:',
		'    tree = ast.parse(src)',
		'except SyntaxError:',
		'    tree = None',
		'for n in (ast.walk(tree) if tree else []):',
		'    if isinstance(n, ast.Import):',
		'        mods.update(a.name.split(".")[0] for a in n.names)',
		'    elif isinstance(n, ast.ImportFrom) and n.level == 0 and n.module:',
		'        mods.add(n.module.split(".")[0])',
		'missing = sorted(m for m in mods if importlib.util.find_spec(m) is None)',
		'print(json.dumps({"qoka_import_check": True, "missing": missing}))',
	].join('\n');
}

function firstLine(s: string | undefined): string {
	const lines = (s ?? '').split('\n').map(l => l.trim()).filter(Boolean);
	return lines.length ? lines[lines.length - 1].slice(0, 200) : '';
}

/** Result of running the locked evaluator once on the empty results folder, before iteration 0. */
export interface PreflightResult { ok: boolean; problem?: string; verdict: Verdict }

/**
 * Run the evaluator once BEFORE the loop starts (results folder empty, no work done). A usable
 * evaluator must (1) print a JSON verdict even when the outputs do not exist yet, and (2) NOT pass on
 * an empty folder. The evaluator is locked during the run and the sub-agent cannot fix it, so a broken
 * evaluator caught here saves the whole budget; the chat rewrites it and the user re-approves.
 */
export async function preflightEvaluator(run: LoopRun, runner: ScriptRunner): Promise<PreflightResult> {
	const verdict = await runLockedEvaluator(run, runner);
	if (!verdict.json) {
		return { ok: false, verdict, problem: `The evaluator did not print a JSON verdict on an empty results folder (${verdict.detail}). It must always print one line {"pass": bool, "detail": "..."} - including when the expected output files do not exist yet (then pass=false with a detail naming the missing file).` };
	}
	if (verdict.pass) {
		return { ok: false, verdict, problem: `The evaluator already PASSES before any work was done (detail: ${verdict.detail || '-'}), so the loop would end at once without testing anything. Make it fail when the required outputs are missing or below the target.` };
	}
	// The inputs the user approved must exist WHERE the evaluator runs (a WSL / vfkit mount or an SSH host
	// sees other paths than the user's PC, and an SSH host may not have the data at all). Checked here, before
	// the lock, because the evaluator usually reads inputs only after its "output missing" exit above.
	const inputs = (run.spec.inputs ?? []).filter(x => typeof x === 'string' && x.trim());
	if (inputs.length) {
		try {
			const r = await runner(inputCheckScript(inputs), 'python', []);
			const line = (r.stdout || '').split('\n').reverse().find(l => l.includes('"qoka_input_check"'));
			const j = line ? JSON.parse(line) as { missing?: unknown; root?: unknown } : undefined;
			if (j && Array.isArray(j.missing) && j.missing.length) {
				return { ok: false, verdict, problem: `These input files do not exist in the run environment, where the evaluator runs (project folder there: ${String(j.root)}): ${(j.missing as string[]).join(', ')}. If the files are on the user's computer, ask whether to upload them and, on a yes, call upload_local_input with dest "project_data" for each (it puts them at the same project-relative path on the run host), then call start_loop again for this loopId. If they live elsewhere on the run host, ask the user for the path, fix inputs and the evaluator's input paths, get their approval, then save_loop and start_loop the new loopId. Never tell the user to copy files by hand (scp).` };
			}
		} catch { /* best-effort: a runner failure here is not an input problem */ }
	}
	// A fail caused by an import error is not "outputs missing": the evaluator cannot run at all and would
	// fail every iteration, however good the work. Catch the import that ran (even if the evaluator caught
	// it and printed it as its detail), then every import it WOULD reach later (after an early "file
	// missing" exit), checked in the same environment the evaluator runs in.
	const missingProblem = (mods: string) => `The evaluator cannot import ${mods} in its environment. A python evaluator runs in its own environment with ONLY the standard library plus evaluator.dependencies, so it would fail every iteration whatever the work produced. List the pip package(s) in evaluator.dependencies (e.g. ["scikit-learn"] for sklearn, ["pillow"] for PIL), or use the standard library instead.`;
	if (verdict.missingModule) {
		return { ok: false, verdict, problem: missingProblem(verdict.missingModule === '?' ? 'a module' : `"${verdict.missingModule}"`) };
	}
	if (isPythonEvaluator(run)) {
		try {
			const r = await runner(importCheckScript(run.spec.evaluator.code), 'python', evaluatorDeps(run));
			const line = (r.stdout || '').split('\n').reverse().find(l => l.includes('"qoka_import_check"'));
			const missing = line ? (JSON.parse(line).missing as unknown) : undefined;
			if (Array.isArray(missing) && missing.length) {
				return { ok: false, verdict, problem: missingProblem(missing.map(m => `"${m}"`).join(', ')) };
			}
		} catch { /* the check is best-effort; the verdict above already passed the protocol */ }
	}
	return { ok: true, verdict };
}

/** A Python script (standard library only) that reports which inputs are missing in the run environment.
 *  Relative inputs resolve against QOKA_PROJECT_ROOT, falling back to the project root three levels above
 *  the evaluator's working directory (loops/<folder>/results) - the same rule the evaluator uses. */
function inputCheckScript(inputs: string[]): string {
	const b64 = Buffer.from(JSON.stringify(inputs), 'utf8').toString('base64');
	return [
		'import base64, json, os',
		`inputs = json.loads(base64.b64decode('${b64}').decode('utf-8'))`,
		'root = os.environ.get("QOKA_PROJECT_ROOT") or os.path.abspath("../../..")',
		'missing = [p for p in inputs if not os.path.exists(os.path.expanduser(p) if os.path.isabs(os.path.expanduser(p)) else os.path.join(root, p))]',
		'print(json.dumps({"qoka_input_check": True, "root": root, "missing": missing}))',
	].join('\n');
}

/** The user's LOCAL project path (as the chat sees it) written into evaluator code. It is never the path
 *  the run environment sees on WSL / vfkit / an SSH host, so such an evaluator cannot read its inputs. */
export function findLocalRootLiteral(code: string, localRoot: string | undefined): string | undefined {
	if (!localRoot || localRoot.length < 4) { return undefined; }
	const root = localRoot.replace(/[\\/]+$/, '');
	const variants = new Set([root, root.replace(/\\/g, '/'), root.replace(/\\/g, '\\\\'), root.replace(/\//g, '\\')]);
	for (const v of variants) { if (v && code.includes(v)) { return root; } }
	return undefined;
}

/** A Python raw string in the evaluator that holds a DOUBLED backslash before a regex escape (r"\\d+").
 *  In a raw string that matches a literal backslash, so the check can never match real data - the usual
 *  slip when evaluator code is written inside a JSON string and its escapes are doubled once too often.
 *  Returns the offending literal (shortened), or undefined. */
export function findDoubleEscapedRawString(code: string): string | undefined {
	const raw = /(?<![A-Za-z0-9_])[rR][bB]?("""|'''|"|')([\s\S]*?)\1/g;
	for (const m of code.matchAll(raw)) {
		if (/\\\\[dDsSwWbB.()[\]{}+*?|^$-]/.test(m[2])) { return m[0].length > 60 ? m[0].slice(0, 57) + '...' : m[0]; }
	}
	return undefined;
}

function isPythonEvaluator(run: LoopRun): boolean {
	// The run-env runner treats a missing language as python.
	const l = (run.spec.evaluator.language ?? '').toLowerCase();
	return l === '' || l === 'python' || l === 'python3' || l === 'py';
}

/** True when `mod` is imported by the evaluator's own code (so an import failure is the evaluator's). */
function evaluatorImports(run: LoopRun, mod: string): boolean {
	const esc = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(^|\\n)\\s*(import\\s+[^\\n]*\\b${esc}\\b|from\\s+${esc}(\\.|\\s))`).test(run.spec.evaluator.code);
}

/** Find the evaluator's verdict object in stdout: the LAST top-level balanced `{...}` that parses as
 *  JSON and has a `pass` key. Scanning balanced braces (string-aware) instead of a lazy regex keeps a
 *  nested `detail` object or an earlier log line with braces from breaking the parse and silently
 *  falling back to the exit code (which could turn a reported failure into a pass). */
export function findVerdictJson(stdout: string): { pass?: unknown; detail?: unknown } | undefined {
	let found: { pass?: unknown; detail?: unknown } | undefined;
	let i = stdout.indexOf('{');
	while (i >= 0) {
		const end = matchingBrace(stdout, i);
		if (end < 0) { i = stdout.indexOf('{', i + 1); continue; }
		let parsed: unknown;
		try { parsed = JSON.parse(stdout.slice(i, end + 1)); } catch { parsed = undefined; }
		if (parsed === undefined) {
			// Not JSON (e.g. a log line or a Python dict repr): look inside it for a verdict.
			i = stdout.indexOf('{', i + 1);
			continue;
		}
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'pass' in (parsed as object)) {
			found = parsed as { pass?: unknown; detail?: unknown };
		}
		i = stdout.indexOf('{', end + 1);
	}
	return found;
}

/** Index of the `}` closing the `{` at `start`, ignoring braces inside JSON strings; -1 if unbalanced. */
function matchingBrace(s: string, start: number): number {
	let depth = 0;
	let inStr = false;
	for (let i = start; i < s.length; i++) {
		const ch = s[i];
		if (inStr) {
			if (ch === '\\') { i++; } else if (ch === '"') { inStr = false; }
			continue;
		}
		if (ch === '"') { inStr = true; }
		else if (ch === '{') { depth++; }
		else if (ch === '}') { depth--; if (depth === 0) { return i; } }
	}
	return -1;
}

/** Strip the volatile parts of an error (numbers, hex, paths, whitespace) so two runs of
 *  the "same" failure compare equal. Used for no-progress detection. */
export function normalizeSignature(s: string): string {
	return s
		.replace(/0x[0-9a-fA-F]+/g, '#')
		.replace(/\/[^\s:'"]+/g, '/PATH')
		.replace(/\d+/g, '#')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200);
}

/** The signature stored per failed iteration: the normalized error text PLUS the numbers it reports
 *  (metrics such as "AUC 0.71 < 0.90"). normalizeSignature alone maps every number to `#`, so an
 *  improving metric (0.71 -> 0.78 -> 0.86) looked like the same failure and the loop was stopped as
 *  "no progress" while it was converging. Volatile numbers (hex ids, paths, traceback line numbers,
 *  timestamps, durations) are dropped first so a genuinely repeated error still compares equal. */
export function failureSignature(detail: string): string {
	const metrics = (detail || '')
		.replace(/0x[0-9a-fA-F]+/g, ' ')
		.replace(/\/[^\s:'"]+/g, ' ')
		.replace(/\bline \d+/gi, ' ')
		.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?/g, ' ')
		.replace(/\d+(\.\d+)?\s*(ms|s|sec|secs|seconds|min|mins|minutes)\b/gi, ' ')
		.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi);
	const sig = normalizeSignature(detail);
	return metrics && metrics.length ? `${sig} | ${metrics.join(',')}` : sig;
}

/** No progress = the last NO_PROGRESS_N failures share one signature. */
export function noProgress(run: LoopRun): boolean {
	const sigs = run.history.slice(run.noProgressFrom ?? 0).map(h => h.errorSignature).filter((s): s is string => !!s);
	if (sigs.length < NO_PROGRESS_N) { return false; }
	const last = sigs.slice(-NO_PROGRESS_N);
	return last.every(s => s === last[0]);
}

function fmtDuration(ms: number | undefined): string {
	if (ms === undefined) { return '-'; }
	const sec = Math.round(ms / 1000);
	return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
}

/**
 * The record handed to the user when the loop pauses on no change. The engine does not judge whether
 * the loop is improving (goals are too varied for one rule); it lays out what happened so the user
 * can: the recent verdicts in order (a metric trend is visible when the detail carries the measured
 * value), the budget spent, and where each iteration's code is kept.
 */
export function buildStall(run: LoopRun, usedMs: number): LoopStall {
	const window = run.history.slice(run.noProgressFrom ?? 0);
	const repeated = window.slice(-NO_PROGRESS_N);
	const from = repeated[0]?.iteration ?? 0;
	const to = repeated[repeated.length - 1]?.iteration ?? 0;
	const detail = repeated[repeated.length - 1]?.detail ?? '';
	const recent = run.history.slice(-8).map(h =>
		`  iter ${h.iteration + 1}  ${h.verdict ?? '-'}  ${(h.detail ?? '').replace(/\s+/g, ' ').slice(0, 160)}  (${fmtDuration(h.durationMs)})`);
	const usedMin = (usedMs / 60_000).toFixed(1);
	const note = run.history[run.history.length - 1]?.agentNote;
	const lines = [
		`The same failure repeated ${NO_PROGRESS_N} times in a row (iterations ${from + 1}-${to + 1}): "${detail}"`,
		'',
		'Recent iterations:',
		...recent,
		'',
		`Budget used: ${run.iteration}/${run.budget.maxIter} iterations, ${usedMin}/${run.budget.maxMin} min${run.budget.usedTokens ? `, ${run.budget.usedTokens.toLocaleString()} tokens` : ''}.`,
		run.rootDir ? `Each iteration's code is kept as a version in ${run.rootDir}/code.` : '',
		'',
		...(note ? ['What the sub-agent said at the end of the last iteration:', note, ''] : []),
		'Options: continue (resume the loop as is, or with a larger budget), stop here, or ask for alternative loop designs.',
	].filter((l, i, a) => !(l === '' && a[i - 1] === ''));
	return { at: new Date().toISOString(), fromIteration: from, toIteration: to, detail, report: lines.join('\n').trim() };
}

/** The sub-agent's [QOKA_EVALUATOR_ISSUE] reason (the last one in its reply), or undefined. */
export function findEvaluatorIssue(output: string | undefined): string | undefined {
	return findMarker(output, 'QOKA_EVALUATOR_ISSUE');
}

/** The sub-agent's [QOKA_GOAL_UNREACHABLE] reason: the goal cannot be reached with this data at all. */
export function findGoalUnreachable(output: string | undefined): string | undefined {
	return findMarker(output, 'QOKA_GOAL_UNREACHABLE');
}

/** The reason after the LAST `[name]` marker in the sub-agent's reply. Only a line that STARTS with the
 *  marker counts, so quoting the rule mid-sentence does not trigger it. */
function findMarker(output: string | undefined, name: string): string | undefined {
	const all = [...(output ?? '').matchAll(new RegExp(`^[ \\t>*\`-]*\\[${name}\\][ \\t\`]*([^\\n]*)`, 'gm'))];
	const why = all.length ? all[all.length - 1][1].trim() : undefined;
	return all.length ? (why || 'no reason given') : undefined;
}

/** The end of the sub-agent's reply, for history and pause reports (bounded). */
function agentNote(output: string | undefined): string | undefined {
	const t = (output ?? '').trim();
	if (!t) { return undefined; }
	return t.length > 800 ? '...' + t.slice(-800) : t;
}

/** Keep the last `n` chars (a tail) of a possibly-huge blob, marked when truncated. */
function tail(s: string | undefined, n: number): string {
	const t = (s ?? '').trim();
	return t.length > n ? '...(truncated)...\n' + t.slice(-n) : t;
}

/** Rich feedback for the NEXT iteration: the one-line cause PLUS the full evaluator output and the
 *  sub-agent's own error/transcript tail, so the next turn can fix the REAL error (not just "it failed").
 *  Length-capped so the prompt stays bounded. The history/UI keeps only the one-line `verdict.detail`. */
function buildIterationFeedback(verdict: Verdict, agent: AgentResult): string {
	const parts: string[] = [`The previous iteration FAILED. Reason: ${verdict.detail || '(no detail)'}`];
	if (verdict.raw && verdict.raw.trim() && verdict.raw.trim() !== (verdict.detail || '').trim()) {
		parts.push(`Full evaluator output (fix what this shows):\n${tail(verdict.raw, 3000)}`);
	}
	if (agent.error && agent.error.trim()) {
		parts.push(`Your run reported an error:\n${tail(agent.error, 1500)}`);
	}
	const outTail = tail(agent.output, 1200);
	if (outTail) { parts.push(`Your previous turn ended with:\n${outTail}`); }
	parts.push('Diagnose the cause above and FIX it this turn (install/build the missing tool a different way, correct the path, or fix the code) - do not repeat the same approach.');
	return parts.join('\n\n');
}

/** Find the most-recently-written *.log under `dir` (recursively) whose mtime is >= `sinceMs` - i.e. a
 *  run from the CURRENT iteration, not a stale log from a previous one. */
function newestLog(dir: string, sinceMs: number): string | undefined {
	let bestPath = ''; let bestM = 0;
	const walk = (d: string): void => {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) { walk(p); }
			else if (e.name.endsWith('.log')) { try { const m = fs.statSync(p).mtimeMs; if (m >= sinceMs && m > bestM) { bestM = m; bestPath = p; } } catch { /* skip */ } }
		}
	};
	walk(dir);
	return bestPath || undefined;
}

/** Read the current within-iteration progress from the newest run log (from THIS iteration): the LAST
 *  `[QOKA_STEP k/N] label` marker the sub-agent printed, plus the last stdout line as a tail. The marker
 *  is MANDATORY (the prompt forces it), so a running turn that shows no marker reads as stuck - which is
 *  the signal we want. */
/** Pure parser: the LAST [QOKA_STEP k/N] marker in a run log's text, plus the last stdout line. */
function parseLiveStep(txt: string): { k: number; n: number; label: string; out?: string; at: string } | undefined {
	const lines = txt.split(/\r?\n/).filter(l => l.length);
	let marker: { k: number; n: number; label: string } | undefined;
	for (let i = lines.length - 1; i >= 0; i--) {
		const mm = /\[QOKA_STEP\s+(\d+)\s*\/\s*(\d+)\]\s*(.*)/.exec(lines[i]);
		if (mm) { marker = { k: parseInt(mm[1], 10), n: parseInt(mm[2], 10), label: (mm[3] || '').trim().slice(0, 80) }; break; }
	}
	if (!marker) { return undefined; }
	const out = lines.length ? lines[lines.length - 1].slice(0, 140) : undefined;
	return { ...marker, out, at: new Date().toISOString() };
}

/** Read the within-iteration progress from the newest LOCAL run log (mounted local env case). */
function readLiveStep(resultsDir: string, sinceMs: number): { k: number; n: number; label: string; out?: string; at: string } | undefined {
	const log = newestLog(resultsDir, sinceMs);
	if (!log) { return undefined; }
	let txt: string;
	try { txt = fs.readFileSync(log, 'utf8'); } catch { return undefined; }
	return parseLiveStep(txt);
}

/**
 * The control loop. Deterministic: the engine decides iterate/stop/pause; the injected
 * agentStep does the work; the locked evaluator judges. Persists after every iteration so
 * a restart can resume.
 */
export async function runLoop(run: LoopRun, agentStep: AgentStep, opts: RunOptions): Promise<LoopOutcome> {
	try {
		return await runLoopInner(run, agentStep, opts);
	} catch (e) {
		// Any other unexpected error (a failed persist, git, or file operation): never leave the run marked
		// "running" - pause it with the reason so the user can resume or delete it. If the engine had
		// already reached a decision (e.g. success) and only the final save failed, keep that decision:
		// downgrading a success to "paused" would let a resume run past a passing iteration.
		opts.log?.(`runLoop error: ${(e as Error)?.stack ?? String(e)}`);
		run.liveStep = undefined;
		if (run.status === 'running' && run.history[run.history.length - 1]?.verdict === 'pass') {
			// The pass was recorded but the save after it failed: the loop did succeed.
			run.status = 'success';
			run.lastFeedback = undefined;
		} else if (run.status === 'running') {
			run.status = 'paused';
			run.reason = `Paused by an unexpected error: ${(e as Error)?.message ?? String(e)}. Resume to retry.`;
		}
		try { opts.persist(run); } catch { /* nothing more we can do */ }
		return run.status === 'success' ? 'success'
			: run.status === 'failed' ? 'failed-budget'
			: run.status === 'stopped' ? 'stopped'
			: 'paused';
	} finally {
		// However the loop ended (success, budget, a cut-off turn, stop, error), nothing it started may keep
		// running in the run environment.
		await stopWork(opts, 'loop ended');
	}
}

/** Best-effort opts.killWork, never throwing: a failure to reach the run environment must not change the
 *  loop's outcome. */
async function stopWork(opts: RunOptions, why: string): Promise<void> {
	if (!opts.killWork) { return; }
	try { await opts.killWork(); } catch (e) { opts.log?.(`killWork (${why}) failed: ${(e as Error)?.message ?? String(e)}`); }
}

async function runLoopInner(run: LoopRun, agentStep: AgentStep, opts: RunOptions): Promise<LoopOutcome> {
	materializeAndLockEvaluator(run, opts.loopDir);
	// Resuming after a no-change pause means the user chose to continue: count repeats afresh from here.
	if (run.stall) { run.noProgressFrom = run.history.length; run.stall = undefined; }
	run.status = 'running';
	run.reason = undefined;
	run.evaluatorMissingModule = undefined;
	run.evaluatorIssue = undefined;
	run.goalUnreachable = undefined;
	if (!run.budget.startedAt) { run.budget.startedAt = new Date().toISOString(); }
	opts.persist(run);

	// maxMin is a TOTAL budget across start + every resume: time already spent in earlier sessions counts.
	const sessionStart = Date.now();
	const baseMs = run.budget.usedMs ?? 0;
	const elapsed = (): number => baseMs + (Date.now() - sessionStart);
	const finish = (): void => { run.budget.usedMs = elapsed(); };
	// A resumed loop picks up the fix-this feedback the previous session left for its next iteration.
	let feedback: string | undefined = run.lastFeedback;
	opts.log?.(`runLoop start: id=${run.id} gitPath=${opts.gitPath || 'git'} codeDir=${opts.codeDir || '(none)'} resultsDir=${opts.resultsDir || '(none)'}`);

	while (run.iteration < run.budget.maxIter && elapsed() < run.budget.maxMin * 60_000) {
		if (opts.shouldStop?.()) {
			run.status = 'stopped';
			run.reason = 'stopped by user';
			finish();
			opts.persist(run);
			return 'stopped';
		}
		// Clear the shared loop results dir at the START of each attempt, so it holds ONLY this iteration's
		// outputs (the final attempt's remain when the loop ends). Safe now that loop outputs are never
		// auto-opened in the editor. No end-of-loop prune needed - overwriting per iteration keeps it clean.
		// The turn may use only what is LEFT of the total time budget; with too little left for a useful
		// turn, end as out of budget rather than start one that would be cut off at once.
		const remainingMs = run.budget.maxMin * 60_000 - elapsed();
		// The turn gets what is left MINUS the time the evaluator needs afterwards.
		const turnMs = remainingMs - evalReserveMs(run, remainingMs);
		if (turnMs < minTurnMs(run.budget.maxMin)) { break; }
		const moved = opts.runTargetChanged ? await opts.runTargetChanged().catch(() => undefined) : undefined;
		if (moved) {
			run.status = 'paused';
			run.reason = moved;
			finish();
			opts.persist(run);
			return 'paused';
		}
		// Leftovers of an earlier turn (cut off, stopped, or a resumed loop) must not keep writing into the
		// results folder this iteration is about to use.
		await stopWork(opts, 'before iteration');
		if (opts.resultsDir) { clearDir(opts.resultsDir); }
		const iterStart = Date.now();
		opts.log?.(`iter ${run.iteration}: sub-agent turn starting${feedback ? ' (with previous-error feedback)' : ' (first attempt)'}`);
		// Live within-iteration progress: reset, then poll the run's stdout log for [QOKA_STEP k/N] markers
		// while the turn runs, persisting so the detail tab's Progress bar advances in real time.
		run.liveStep = undefined;
		opts.persist(run);
		let lastLiveKey = '';
		// Prefer reading the log THROUGH the run env (readIterLog) so a REMOTE SSH run - whose log is only
		// on the server mid-run - still updates the bar; fall back to the local file for mounted envs.
		// The poll is async (an ssh cat), so guard against overlap when a read runs longer than the tick.
		let liveBusy = false;
		let liveStopped = false;
		const pollLive = async (): Promise<void> => {
			if (liveBusy || liveStopped) { return; }
			liveBusy = true;
			try {
				let ls: { k: number; n: number; label: string; out?: string; at: string } | undefined;
				if (opts.readIterLog) {
					const txt = await opts.readIterLog();
					ls = txt ? parseLiveStep(txt) : undefined;
				} else if (opts.resultsDir) {
					ls = readLiveStep(opts.resultsDir, iterStart - 2000);
				}
				if (!ls || liveStopped) { return; }  // ignore a read that landed after the turn ended
				const key = `${ls.k}/${ls.n}:${ls.out ?? ''}`;
				if (key !== lastLiveKey) { lastLiveKey = key; run.liveStep = ls; opts.persist(run); opts.log?.(`iter ${run.iteration}: step ${ls.k}/${ls.n} ${ls.label}`); }
			} catch { /* transient read error - try again next tick */ }
			finally { liveBusy = false; }
		};
		const liveTimer = (opts.readIterLog || opts.resultsDir) ? setInterval(() => { void pollLive(); }, 2000) : undefined;
		let r: AgentResult;
		try {
			r = await agentStep(run, feedback, { timeoutMs: turnMs });
		} catch (e) {
			// A turn that could not even run (spawn failure, unwritable config, ...) is an environment
			// problem, not a wrong attempt: pause with the reason instead of escaping runLoop and leaving
			// the loop stuck in "running" (it could then be neither resumed nor deleted until a restart).
			r = { output: '', exitCode: null, envError: true, error: `sub-agent turn failed to run: ${(e as Error)?.message ?? String(e)}` };
		} finally {
			liveStopped = true;
			if (liveTimer) { clearInterval(liveTimer); }
		}
		run.liveStep = undefined;
		if (typeof r.tokens === 'number') { run.budget.usedTokens += r.tokens; }
		// Make what the sub-agent actually did visible in the "Qoka Loop" output: the tail of its output,
		// any error it reported, and whether it captured code - so a stuck loop can be diagnosed.
		opts.log?.(`iter ${run.iteration}: sub-agent done exit=${r.exitCode} tokens=${r.tokens ?? '-'} codeLang=${r.codeLanguage ?? '-'}${r.error ? ` ERROR=${r.error}` : ''}`);
		opts.log?.(`iter ${run.iteration}: agent output tail: ${JSON.stringify((r.output || '').slice(-600))}`);
		// A stop that arrived DURING the sub-agent turn (the turn may have been killed) is honored here,
		// before spending time running the evaluator - so a mid-iteration stop takes effect promptly.
		if (opts.shouldStop?.()) {
			run.status = 'stopped';
			run.reason = 'stopped by user';
			finish();
			opts.persist(run);
			return 'stopped';
		}
		// A turn cut off because the total time budget ran out did NOT do wrong work. PAUSE (not fail) so the
		// user can raise the loop's time budget (maxMin, the total) in chat and resume that iteration.
		if (r.timedOut) {
			run.status = 'paused';
			run.reason = `The ${run.budget.maxMin} min time budget ran out during iteration ${run.iteration + 1}, so that iteration was cut off. Action needed: ask in the chat to increase this loop's total time budget, then resume (or simplify the task).`;
			finish();
			opts.persist(run);
			return 'paused';
		}
		if (r.envError) {
			run.status = 'paused';
			run.reason = r.error ?? 'environment error';
			finish();
			opts.persist(run);
			return 'paused';
		}

		// The evaluator, too, runs only in what is left of the time budget.
		const evalLeftMs = run.budget.maxMin * 60_000 - elapsed();
		const evalStart = Date.now();
		const verdict = evalLeftMs > 0
			? await runLockedEvaluator(run, opts.evaluatorRunner, { timeoutMs: evalLeftMs })
			: { pass: false, detail: 'no time left to run the evaluator', json: false } as Verdict;
		// Out of time while judging = no time left at all, or the evaluator printed no verdict and used up
		// (nearly) all the time it was given, i.e. it was cut off by the limit.
		if (!verdict.pass && !verdict.json && (evalLeftMs <= 0 || Date.now() - evalStart >= evalLeftMs * 0.95)) {
			run.lastFeedback = feedback;
			run.status = 'paused';
			run.reason = `The ${run.budget.maxMin} min time budget ran out while the evaluator was judging iteration ${run.iteration + 1}. Action needed: ask in the chat to increase this loop's total time budget, then resume.`;
			finish();
			opts.persist(run);
			return 'paused';
		}
		const entry: LoopHistoryEntry = {
			iteration: run.iteration,
			verdict: verdict.pass ? 'pass' : 'fail',
			detail: verdict.detail,
			errorSignature: verdict.pass ? undefined : failureSignature(verdict.detail),
			at: new Date().toISOString(),
			durationMs: Date.now() - iterStart,
			...(agentNote(r.output) ? { agentNote: agentNote(r.output) } : {}),
		};
		// Commit THIS iteration's code as a git version (message carries the verdict + reason), so the
		// Files tab can show a version tree and the failed attempts are recoverable.
		if (opts.codeDir) {
			// Prefer the REAL scripts run_code wrote this iteration (mtime >= iteration start, minus a
			// small buffer for clock skew); fall back to the transcript-parsed code inside the committer.
			const scripts = opts.captureDir ? captureIterationScripts(opts.captureDir, iterStart - 2000) : [];
			commitIterationCode(opts.gitPath || 'git', opts.codeDir, run.iteration, r.code, r.codeLanguage, verdict.pass ? 'pass' : 'fail', verdict.detail, scripts, opts.log);
		}
		run.history.push(entry);
		run.iteration++;
		run.budget.usedMs = elapsed();
		opts.persist(run);

		if (verdict.pass) {
			run.lastFeedback = undefined;
			run.status = 'success';
			finish();
			opts.persist(run);
			return 'success';
		}
		// The evaluator itself cannot import one of ITS packages: no attempt can pass, and the sub-agent must
		// not "fix" it by changing the run environment. Only a redesign helps, so hand it to the user now.
		const mm = verdict.missingModule;
		// The sub-agent reported that the evaluator itself cannot pass any correct work (a bug in it, an
		// input it reads that is not there). Retrying cannot help and the sub-agent must not work around
		// it, so hand its reason to the user now instead of waiting for the no-change pause.
		const issue = findEvaluatorIssue(r.output);
		if (issue) {
			run.lastFeedback = buildIterationFeedback(verdict, r);
			run.evaluatorIssue = issue;
			run.status = 'paused';
			run.reason = `The sub-agent reports the evaluator itself cannot pass correct work: ${issue.slice(0, 300)}`;
			finish();
			opts.persist(run);
			return 'paused';
		}
		// The sub-agent reported that the GOAL cannot be reached with this data (e.g. labels carry no signal,
		// the target exceeds what the data allows). More attempts only burn budget, and a failure detail that
		// changes every time (a fluctuating metric) never trips the no-change pause - so hand it over now.
		const unreachable = findGoalUnreachable(r.output);
		if (unreachable) {
			run.lastFeedback = buildIterationFeedback(verdict, r);
			run.goalUnreachable = unreachable;
			run.status = 'paused';
			run.reason = `The sub-agent reports the goal cannot be reached with this data: ${unreachable.slice(0, 300)}`;
			finish();
			opts.persist(run);
			return 'paused';
		}
		if (mm && mm !== '?' && evaluatorImports(run, mm)) {
			run.lastFeedback = buildIterationFeedback(verdict, r);
			run.evaluatorMissingModule = mm;
			run.status = 'paused';
			run.reason = `The evaluator cannot import "${mm}" in its own environment, so it cannot judge any attempt. The loop needs a redesign (add the package to evaluator.dependencies), not another iteration.`;
			finish();
			opts.persist(run);
			return 'paused';
		}
		if (noProgress(run)) {
			// No change: the same failure repeated. The engine does not decide whether the loop is still
			// improving - it pauses and hands the user the history to judge (continue / stop / redesign).
			run.lastFeedback = buildIterationFeedback(verdict, r);
			run.stall = buildStall(run, elapsed());
			run.status = 'paused';
			run.reason = `No change: the same failure repeated ${NO_PROGRESS_N} times ("${verdict.detail.slice(0, 120)}"). Continue, stop, or ask for alternative designs.`;
			finish();
			opts.persist(run);
			return 'paused';
		}
		feedback = buildIterationFeedback(verdict, r);
		run.lastFeedback = feedback;
		// Show exactly what will be handed to the next iteration to fix (the full-error feedback).
		opts.log?.(`iter ${run.iteration - 1}: feedback handed to next iteration ->\n${feedback}`);
	}

	run.status = 'failed';
	run.reason = 'budget exhausted';
	finish();
	opts.persist(run);
	return 'failed-budget';
}
