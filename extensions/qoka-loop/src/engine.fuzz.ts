/* Randomized robustness test for the loop engine (no vscode, no AI, no python). Each scenario mixes
 * random sub-agent behaviour (ok / environment error / timed-out turn / thrown error), random evaluator
 * output (clean JSON, nested detail, log noise, no JSON, crash, runner failure) and random stops, then
 * drives the loop through user resumes until it ends - and checks engine invariants after every call.
 * Bundle with esbuild and run with node:  node engine.fuzz.js [scenarios] [seed]                     */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LoopRun } from './schema';
import { runLoop, AgentStep, ScriptRunner, LoopOutcome, failureSignature, NO_PROGRESS_N } from './engine';

const SCENARIOS = Number(process.argv[2] ?? 3000);
let seed = Number(process.argv[3] ?? 12345);
function rnd(): number { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick<T>(xs: T[]): T { return xs[Math.floor(rnd() * xs.length)]; }

type EvalOut = { stdout: string; stderr: string; exitCode: number | null; truthPass: boolean; throws?: boolean };

/** One random evaluator output plus the ground truth: it is a real pass only for a JSON pass + exit 0. */
function randomEval(passChance: number): EvalOut {
	const metric = (0.5 + Math.floor(rnd() * 5) / 10).toFixed(2);
	const pass = rnd() < passChance;
	const kind = pick(['json', 'json', 'json', 'nested', 'noise', 'nojson-0', 'nojson-1', 'crash-after-pass', 'killed', 'throw', 'string-true']);
	switch (kind) {
		case 'json': return { stdout: JSON.stringify({ pass, detail: `AUC ${metric} target 0.90` }), stderr: '', exitCode: pass ? 0 : pick([0, 1]), truthPass: pass };
		case 'nested': return { stdout: JSON.stringify({ pass, detail: { auc: Number(metric), need: 0.9 } }), stderr: '', exitCode: 0, truthPass: pass };
		case 'noise': return { stdout: `config {"lr": 0.01}\nparams {'k': 3}\n` + JSON.stringify({ pass, detail: `AUC ${metric}` }), stderr: 'warn: x', exitCode: 0, truthPass: pass };
		case 'nojson-0': return { stdout: 'all checks ok', stderr: '', exitCode: 0, truthPass: false };
		case 'nojson-1': return { stdout: '', stderr: 'FileNotFoundError: results/auc.txt', exitCode: 1, truthPass: false };
		case 'crash-after-pass': return { stdout: JSON.stringify({ pass: true, detail: 'ok' }), stderr: 'Traceback: boom', exitCode: 1, truthPass: false };
		case 'killed': return { stdout: JSON.stringify({ pass: true, detail: 'ok' }), stderr: '', exitCode: null, truthPass: false };
		case 'string-true': return { stdout: '{"pass": "true", "detail": "s"}', stderr: '', exitCode: 0, truthPass: false };
		default: return { stdout: '', stderr: '', exitCode: null, truthPass: false, throws: true };
	}
}

const violations: string[] = [];
const counts: Record<string, number> = {};
let agentThrowCrashes = 0;

function check(cond: boolean, msg: string): void { if (!cond) { violations.push(msg); } }

async function scenario(idx: number): Promise<void> {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qoka-fuzz-'));
	const loopDir = path.join(base, 'loops');
	fs.mkdirSync(loopDir);
	const maxIter = 1 + Math.floor(rnd() * 12);
	const passChance = pick([0, 0, 0.05, 0.15, 0.4]);
	const now = new Date().toISOString();
	const run: LoopRun = {
		id: 'f' + idx,
		spec: { title: 't', goal: 'g', flow: { steps: ['a'], checks: [] }, evaluator: { code: 'x', language: 'python' }, budget: { maxIter, maxMin: 600 } },
		status: 'pending-approval', iteration: 0, budget: { maxIter, maxMin: 600, usedTokens: 0 }, history: [], createdAt: now, updatedAt: now,
	};
	// A repeating evaluator output makes stalls likely; a fresh one per iteration makes them rare.
	const sticky = rnd() < 0.5;
	let stickyOut: EvalOut | undefined;
	const truth: boolean[] = [];             // ground truth per evaluated iteration
	const runner: ScriptRunner = async () => {
		const out = sticky ? (stickyOut ??= randomEval(passChance)) : randomEval(passChance);
		truth.push(out.truthPass);
		if (out.throws) { throw new Error('runner down'); }
		return { stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode };
	};
	let calls = 0;
	const feedbackSeen: Array<string | undefined> = [];
	const agent: AgentStep = async (_r, fb) => {
		calls++;
		feedbackSeen.push(fb);
		const k = rnd();
		if (k < 0.04) { throw new Error('sub-agent crashed'); }
		if (k < 0.10) { return { output: '', exitCode: 1, envError: true, error: 'quota exceeded' }; }
		if (k < 0.13) { return { output: '', exitCode: null, timedOut: true }; }
		return { output: 'did work', exitCode: 0, tokens: 10 };
	};
	const stopAt = rnd() < 0.15 ? 1 + Math.floor(rnd() * 6) : -1;

	let lastOutcome: LoopOutcome | 'crashed' = 'paused';
	let prevUsed = 0;
	for (let session = 0; session < 40; session++) {
		const feedbackBefore = run.lastFeedback;
		const callsBefore = calls;
		const histBefore = run.history.length;
		let outcome: LoopOutcome;
		try {
			outcome = await runLoop(run, agent, { loopDir, cwd: base, evaluatorRunner: runner, persist: () => { if (rnd() < 0.003) { throw new Error('disk full'); } }, shouldStop: () => stopAt > 0 && calls === stopAt && session === 0 });
		} catch (e) {
			// runLoop must never reject: every failure becomes a resumable pause.
			agentThrowCrashes++;
			lastOutcome = 'crashed';
			check(false, `scenario ${idx} session ${session}: runLoop rejected (${(e as Error).message}) with status ${run.status}`);
			run.status = 'paused';
			continue;
		}
		lastOutcome = outcome;
		counts[outcome] = (counts[outcome] ?? 0) + 1;
		if (outcome === 'paused' && /failed to run|unexpected error/.test(run.reason ?? '')) { counts['paused-on-error'] = (counts['paused-on-error'] ?? 0) + 1; }
		check(run.status !== 'running', `scenario ${idx} session ${session}: left in status running`);
		const tag = `scenario ${idx} session ${session}`;
		// I1 status matches the outcome
		const expectStatus = { success: 'success', 'failed-budget': 'failed', paused: 'paused', stopped: 'stopped' }[outcome];
		check(run.status === expectStatus, `${tag}: outcome ${outcome} but status ${run.status}`);
		// I2 counts are consistent and within budget
		check(run.history.length === run.iteration, `${tag}: history ${run.history.length} != iteration ${run.iteration}`);
		check(run.iteration <= maxIter, `${tag}: iteration ${run.iteration} > maxIter ${maxIter}`);
		// I3/I4 a pass is recorded only for a real pass, and ends the loop at once
		run.history.forEach((h, i) => {
			if (h.verdict === 'pass') { check(truth[i] === true, `${tag}: iter ${i} recorded pass but evaluator output was not a real pass`); }
			if (truth[i] === true) { check(h.verdict === 'pass' && i === run.history.length - 1, `${tag}: real pass at iter ${i} not recorded as the final pass`); }
		});
		if (outcome === 'success') { check(run.history[run.history.length - 1]?.verdict === 'pass', `${tag}: success without a final pass`); }
		// I5 a stall pause carries a report and really follows three identical failures
		if (outcome === 'paused' && run.stall) {
			const win = run.history.slice(run.noProgressFrom ?? 0).slice(-NO_PROGRESS_N).map(h => h.errorSignature);
			check(win.length === NO_PROGRESS_N && win.every(s => s && s === win[0]), `${tag}: stall without ${NO_PROGRESS_N} identical failures`);
			check(run.stall.report.includes('Recent iterations') && run.stall.report.length > 40, `${tag}: stall report missing`);
		}
		// I6 no missed stall: the engine never ran on past three identical failures in one session
		const nf = run.noProgressFrom ?? 0;
		for (let j = histBefore; j < run.history.length - 1; j++) {
			const w = run.history.slice(nf, j + 1).filter(h => h.errorSignature).slice(-NO_PROGRESS_N);
			if (w.length === NO_PROGRESS_N && w.every(h => h.errorSignature === w[0].errorSignature)) {
				check(false, `${tag}: continued after ${NO_PROGRESS_N} identical failures (iter ${j})`);
			}
		}
		// I7 a resumed session starts from the persisted fix-this feedback
		if (calls > callsBefore && session > 0) {
			check(feedbackSeen[callsBefore] === feedbackBefore, `${tag}: resume did not hand over the last feedback`);
		}
		// I8 time is monotone
		check((run.budget.usedMs ?? 0) >= prevUsed, `${tag}: usedMs went backwards`);
		prevUsed = run.budget.usedMs ?? 0;
		// I9 detail is always a one-line string the UI can show
		run.history.forEach(h => check(typeof h.detail === 'string', `${tag}: non-string detail`));

		if (outcome === 'success' || outcome === 'failed-budget') { break; }
		// paused / stopped: the user chooses to continue
	}
	check(lastOutcome === 'success' || lastOutcome === 'failed-budget', `scenario ${idx}: did not terminate within 40 sessions (last ${lastOutcome}, iter ${run.iteration}/${maxIter})`);
	fs.rmSync(base, { recursive: true, force: true });
}

async function main(): Promise<void> {
	const t0 = Date.now();
	for (let i = 0; i < SCENARIOS; i++) { await scenario(i); }
	// Sanity: the stored signature of a metric-free repeated error is stable.
	const a = failureSignature('File "/tmp/a.py", line 3 KeyError'), b = failureSignature('File "/tmp/b.py", line 9 KeyError');
	if (a !== b) { violations.push('signature unstable for the same error'); }
	console.log(`scenarios: ${SCENARIOS}, seconds: ${((Date.now() - t0) / 1000).toFixed(1)}`);
	console.log('outcomes per session:', JSON.stringify(counts));
	console.log(`runLoop rejections: ${agentThrowCrashes}`);
	const uniq = [...new Set(violations.filter(Boolean))];
	console.log(uniq.length === 0 ? 'NO INVARIANT VIOLATIONS' : `${uniq.length} INVARIANT VIOLATION(S):\n` + uniq.slice(0, 25).join('\n'));
	process.exit(uniq.length === 0 ? 0 : 1);
}

void main();
