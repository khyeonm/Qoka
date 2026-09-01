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
import { LoopRun, LoopHistoryEntry } from './schema';

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
export type AgentStep = (run: LoopRun, feedback: string | undefined) => Promise<AgentResult>;

/** The evaluator's deterministic verdict. `detail` is the SHORT one-line cause (history/UI); `raw` is the
 *  FULL evaluator stdout+stderr, fed to the next iteration so the sub-agent can fix the real error. */
export interface Verdict { pass: boolean; detail: string; raw?: string; }

export type LoopOutcome = 'success' | 'failed-structural' | 'failed-budget' | 'paused' | 'stopped';

/** Runs a script and returns its result. Injected so the evaluator executes WHERE the work
 *  happened: the extension provides a runner that executes in the RUN environment (SSH/WSL/
 *  vfkit), the same place the sub-agent's run_code wrote its files; the test provides a local
 *  one. Without this the engine would run the evaluator locally and miss a remote file. */
export type ScriptRunner = (script: string, language: string | undefined) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

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
	/** git binary for code versioning (bundled MinGit path on Windows, else 'git'). Defaults to 'git'. */
	gitPath?: string;
	/** Hidden dir (.qoka/<loopScope>/code) where run_code drops each run's REAL script under <runId>/.
	 *  The engine copies the scripts written THIS iteration into codeDir so the version shows real code,
	 *  not just the transcript-parsed capture. Unset -> falls back to the transcript code. */
	captureDir?: string;
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

/** Keep only the newest child (by mtime) of a results dir, so a FINISHED loop leaves just the final
 *  run's outputs. Done ONCE at the end - never mid-loop, which would delete a file the user has open. */
function keepOnlyNewestChild(dir: string, log?: (m: string) => void): void {
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('.'));
		if (entries.length <= 1) { return; }
		const scored = entries.map(e => { let m = 0; try { m = fs.statSync(path.join(dir, e.name)).mtimeMs; } catch { /* keep 0 */ } return { name: e.name, m }; });
		scored.sort((a, b) => b.m - a.m);
		for (const s of scored.slice(1)) { try { fs.rmSync(path.join(dir, s.name), { recursive: true, force: true }); } catch { /* best-effort */ } }
		log?.(`results pruned to final: kept ${scored[0].name}, removed ${scored.length - 1}`);
	} catch { /* best-effort */ }
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
	const hash = sha256(code);
	run.lockedEvaluatorRef = { path: p, hash };
	run.spec.evaluator.hash = hash;
}

/** Run the locked evaluator via the injected runner and return a deterministic verdict. The
 *  SOURCE OF TRUTH is `run.spec.evaluator.code` (locked in engine state at approval - the
 *  sub-agent has no access to it), so there is nothing on disk for the sub-agent to tamper
 *  with. Executes WHERE the work happened (the ScriptRunner runs in the run environment).
 *  Verdict protocol: a JSON {"pass": bool, "detail": string} on stdout wins; else exit 0 = pass. */
export async function runLockedEvaluator(run: LoopRun, runner: ScriptRunner): Promise<Verdict> {
	const code = run.spec.evaluator.code;
	if (!code) { return { pass: false, detail: 'no locked evaluator' }; }
	let r: { stdout: string; stderr: string; exitCode: number | null };
	try {
		r = await runner(code, run.spec.evaluator.language);
	} catch (e) {
		return { pass: false, detail: `evaluator failed to run: ${(e as Error).message}`, raw: (e as Error).message };
	}
	// The FULL evaluator output (stdout+stderr) is kept as `raw` so the engine can feed the real cause
	// (a traceback, "file not found", a metric dump) to the NEXT iteration - the one-line `detail` is
	// only for the history/UI.
	const raw = [r.stdout, r.stderr].filter(s => s && s.trim()).join('\n').trim();
	const m = r.stdout.match(/\{[\s\S]*?"pass"[\s\S]*?\}/);
	if (m) {
		try {
			const j = JSON.parse(m[0]) as { pass?: unknown; detail?: unknown };
			return { pass: j.pass === true, detail: String(j.detail ?? ''), raw };
		} catch { /* fall through to exit code */ }
	}
	return { pass: r.exitCode === 0, detail: (r.stderr || r.stdout).trim().slice(0, 500), raw };
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

/** No progress = the last NO_PROGRESS_N failures share one normalized signature. */
export function noProgress(run: LoopRun): boolean {
	const sigs = run.history.map(h => h.errorSignature).filter((s): s is string => !!s);
	if (sigs.length < NO_PROGRESS_N) { return false; }
	const last = sigs.slice(-NO_PROGRESS_N);
	return last.every(s => s === last[0]);
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

/**
 * The control loop. Deterministic: the engine decides iterate/stop/pause; the injected
 * agentStep does the work; the locked evaluator judges. Persists after every iteration so
 * a restart can resume.
 */
export async function runLoop(run: LoopRun, agentStep: AgentStep, opts: RunOptions): Promise<LoopOutcome> {
	materializeAndLockEvaluator(run, opts.loopDir);
	run.status = 'running';
	run.reason = undefined;
	run.budget.startedAt = new Date().toISOString();
	opts.persist(run);

	const startMs = Date.now();
	let feedback: string | undefined;
	opts.log?.(`runLoop start: id=${run.id} gitPath=${opts.gitPath || 'git'} codeDir=${opts.codeDir || '(none)'} resultsDir=${opts.resultsDir || '(none)'}`);

	// Clear stale outputs ONCE, only on a fresh start (not on resume). We deliberately do NOT clear
	// results between iterations - that would delete a file the user has opened to inspect. Instead the
	// results are pruned to the final run at the very end (keepOnlyNewestChild).
	if (opts.resultsDir && run.iteration === 0) { clearDir(opts.resultsDir); }
	const prune = (): void => { if (opts.resultsDir) { keepOnlyNewestChild(opts.resultsDir, opts.log); } };

	while (run.iteration < run.budget.maxIter && (Date.now() - startMs) < run.budget.maxMin * 60_000) {
		if (opts.shouldStop?.()) {
			run.status = 'stopped';
			run.reason = 'stopped by user';
			opts.persist(run);
			return 'stopped';
		}
		const iterStart = Date.now();
		opts.log?.(`iter ${run.iteration}: sub-agent turn starting${feedback ? ' (with previous-error feedback)' : ' (first attempt)'}`);
		const r = await agentStep(run, feedback);
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
			opts.persist(run);
			return 'stopped';
		}
		// A turn that ran out of time did NOT do wrong work - retrying would just time out again. PAUSE and
		// tell the user to raise the loop's time budget (maxMin) in chat, then resume.
		if (r.timedOut) {
			const perTurnMin = Math.max(run.budget.maxMin || 20, 10);
			run.status = 'paused';
			run.reason = `Iteration ${run.iteration} needs more time than the ${perTurnMin} min budget allows. Action needed: ask in the chat to increase this loop's time budget, then resume (or simplify the task).`;
			opts.persist(run);
			return 'paused';
		}
		if (r.envError) {
			run.status = 'paused';
			run.reason = r.error ?? 'environment error';
			opts.persist(run);
			return 'paused';
		}

		const verdict = await runLockedEvaluator(run, opts.evaluatorRunner);
		const entry: LoopHistoryEntry = {
			iteration: run.iteration,
			verdict: verdict.pass ? 'pass' : 'fail',
			detail: verdict.detail,
			errorSignature: verdict.pass ? undefined : normalizeSignature(verdict.detail),
			at: new Date().toISOString(),
			durationMs: Date.now() - iterStart,
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
		opts.persist(run);

		if (verdict.pass) {
			run.status = 'success';
			opts.persist(run);
			prune();
			return 'success';
		}
		if (noProgress(run)) {
			run.status = 'failed';
			run.reason = 'no progress (same failure repeated)';
			opts.persist(run);
			prune();
			return 'failed-structural';
		}
		feedback = buildIterationFeedback(verdict, r);
		// Show exactly what will be handed to the next iteration to fix (the full-error feedback).
		opts.log?.(`iter ${run.iteration - 1}: feedback handed to next iteration ->\n${feedback}`);
	}

	prune();
	run.status = 'failed';
	run.reason = 'budget exhausted';
	opts.persist(run);
	return 'failed-budget';
}
