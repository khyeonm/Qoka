/* Headless self-test for the deterministic engine (no vscode, no app). Bundle with
 * esbuild and run with node: validates success / no-progress / budget / evaluator-lock.
 * The evaluatorRunner is injected (a LOCAL runner here; the extension injects a run-env one). */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { LoopRun, LoopSpec } from './schema';
import { runLoop, runLockedEvaluator, materializeAndLockEvaluator, failureSignature, preflightEvaluator, AgentStep, ScriptRunner } from './engine';

let failures = 0;
function assert(cond: boolean, msg: string): void {
	if (cond) { console.log(`  ok  - ${msg}`); }
	else { console.error(`  FAIL - ${msg}`); failures++; }
}

// A python evaluator that passes only when <cwd>/answer.txt contains exactly "42".
const ANSWER_EVALUATOR = `import os, json
p = os.path.join(os.getcwd(), 'answer.txt')
v = open(p).read().strip() if os.path.exists(p) else ''
print(json.dumps({"pass": v == "42", "detail": "got %r" % v}))`;

/** A ScriptRunner that runs the evaluator LOCALLY in cwd (stands in for the run-env runner). */
function localRunner(cwd: string): ScriptRunner {
	return (script, language) => new Promise((resolve) => {
		const cmd = language === 'python' ? 'python3' : language === 'node' ? 'node' : 'bash';
		const f = path.join(cwd, `.eval-${Math.random().toString(16).slice(2)}.tmp`);
		fs.writeFileSync(f, script);
		let out = '';
		let err = '';
		const proc = spawn(cmd, [f], { cwd });
		proc.stdout.on('data', d => { out += d; });
		proc.stderr.on('data', d => { err += d; });
		proc.on('error', e => resolve({ stdout: '', stderr: String(e), exitCode: null }));
		proc.on('close', code => { try { fs.unlinkSync(f); } catch { /* ignore */ } resolve({ stdout: out, stderr: err, exitCode: code }); });
	});
}

function makeRun(evaluatorCode: string, maxIter = 15): LoopRun {
	const spec: LoopSpec = {
		title: 'test', goal: 'answer.txt == 42',
		flow: { steps: ['write answer'], checks: [{ c: 'answer==42', why: 'objective' }] },
		evaluator: { code: evaluatorCode, language: 'python' },
		budget: { maxIter, maxMin: 5 },
	};
	const now = new Date().toISOString();
	return {
		id: 'test' + Math.random().toString(16).slice(2, 8), spec, status: 'pending-approval',
		iteration: 0, budget: { maxIter, maxMin: 5, usedTokens: 0 }, history: [],
		createdAt: now, updatedAt: now,
	};
}

function tmp(): { loopDir: string; cwd: string } {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qoka-loop-test-'));
	const loopDir = path.join(base, 'loops');
	const cwd = path.join(base, 'work');
	fs.mkdirSync(loopDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	return { loopDir, cwd };
}

async function main(): Promise<void> {
	// 1) SUCCESS: agent converges to "42" on the 3rd turn.
	{
		const { loopDir, cwd } = tmp();
		const run = makeRun(ANSWER_EVALUATOR);
		const values = ['wrong', 'aaa', '42'];
		const agent: AgentStep = async (r) => {
			fs.writeFileSync(path.join(cwd, 'answer.txt'), values[Math.min(r.iteration, values.length - 1)]);
			return { output: 'wrote', exitCode: 0 };
		};
		const outcome = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		console.log('Test 1 (success):');
		assert(outcome === 'success', `outcome is success (got ${outcome})`);
		assert(run.iteration === 3, `succeeded on iteration 3 (got ${run.iteration})`);
	}

	// 2) NO-PROGRESS: agent writes the same wrong value every time -> stop at N=3.
	{
		const { loopDir, cwd } = tmp();
		const run = makeRun(ANSWER_EVALUATOR);
		const agent: AgentStep = async () => {
			fs.writeFileSync(path.join(cwd, 'answer.txt'), 'wrong');
			return { output: 'wrote', exitCode: 0 };
		};
		const outcome = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		console.log('Test 2 (no change -> pause with report):');
		assert(outcome === 'paused' && run.status === 'paused', `same failure 3x pauses, not fails (got ${outcome})`);
		assert(run.iteration === 3, `paused at 3 identical failures (got ${run.iteration})`);
		assert(!!run.stall && run.stall.fromIteration === 0 && run.stall.toIteration === 2, 'stall records iterations 1-3');
		assert(!!run.stall && /Recent iterations:/.test(run.stall.report) && /Budget used: 3\/15 iterations/.test(run.stall.report), 'stall report lists the history and budget');
		assert(/No change/.test(run.reason ?? ''), `reason explains the pause (got ${run.reason})`);
	}

	// 3) BUDGET: agent keeps changing (distinct non-numeric values) but never hits 42.
	{
		const { loopDir, cwd } = tmp();
		const run = makeRun(ANSWER_EVALUATOR, 4);
		const vals = ['aaa', 'bbb', 'ccc', 'ddd', 'eee'];
		const agent: AgentStep = async (r) => {
			fs.writeFileSync(path.join(cwd, 'answer.txt'), vals[r.iteration % vals.length]);
			return { output: 'wrote', exitCode: 0 };
		};
		const outcome = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		console.log('Test 3 (budget):');
		assert(outcome === 'failed-budget', `outcome is failed-budget (got ${outcome})`);
		assert(run.iteration === 4, `stopped at maxIter=4 (got ${run.iteration})`);
	}

	// 4) EVALUATOR LOCK: the code string in engine state is the source of truth. Tampering the
	//    on-disk copy does nothing - execution uses the locked string, so no forced pass.
	{
		const { loopDir, cwd } = tmp();
		const run = makeRun(ANSWER_EVALUATOR);
		materializeAndLockEvaluator(run, loopDir);
		fs.writeFileSync(run.lockedEvaluatorRef!.path, 'import json; print(json.dumps({"pass": True, "detail": "cheat"}))');
		const verdict = await runLockedEvaluator(run, localRunner(cwd));
		console.log('Test 4 (evaluator lock):');
		assert(verdict.pass === false, 'tampered on-disk copy did NOT force a pass (locked string used)');
		assert(verdict.detail !== 'cheat', `real verdict used, not the cheat (got: ${verdict.detail})`);
	}

	// 5) VERDICT PARSING: the evaluator's JSON must win over the exit code, even when the detail is a
	//    nested object or a log line with braces precedes it (a lazy match used to fall back to exit 0).
	{
		const verdictOf = async (stdout: string, exitCode: number | null) => {
			const run = makeRun('placeholder');
			return runLockedEvaluator(run, async () => ({ stdout, stderr: '', exitCode }));
		};
		console.log('Test 5 (verdict parsing):');
		let v = await verdictOf('{"pass": false, "detail": {"auc": 0.71, "need": 0.9}}', 0);
		assert(v.pass === false, 'nested detail object + exit 0 -> fail');
		assert(v.detail.includes('0.71'), `nested detail kept as text (got ${v.detail})`);
		v = await verdictOf('config {"lr": 0.01}\n{"pass": false, "detail": "auc 0.71"}', 0);
		assert(v.pass === false, 'log line with braces before the verdict + exit 0 -> fail');
		v = await verdictOf("params {'lr': 0.01}\n{\"pass\": true, \"detail\": \"ok\"}", 0);
		assert(v.pass === true, 'python dict repr before the verdict does not hide the JSON pass');
		v = await verdictOf('{"pass": false, "detail": "first"}\n{"pass": true, "detail": "final"}', 0);
		assert(v.pass === true && v.detail === 'final', 'the LAST verdict object is used');
		v = await verdictOf('{"pass": true, "detail": "ok"}\nTraceback: boom', 1);
		assert(v.pass === false && /exited abnormally/.test(v.detail), 'JSON pass + crash (exit 1) -> fail');
		v = await verdictOf('{"pass": true, "detail": "ok"}', null);
		assert(v.pass === false, 'JSON pass + killed (exit null) -> fail');
		v = await verdictOf('{"pass": "true", "detail": "string"}', 0);
		assert(v.pass === false, 'pass must be boolean true (string "true" -> fail)');
		v = await verdictOf('{"pass": false, "detail": "brace } inside { a string"}', 0);
		assert(v.pass === false, 'braces inside a JSON string do not break the parse');
		v = await verdictOf('all checks ok', 0);
		assert(v.pass === false && v.json === false && /no JSON verdict/.test(v.detail), 'no JSON + exit 0 -> FAIL (strict protocol)');
		v = await verdictOf('no json here', 2);
		assert(v.pass === false, 'no JSON -> non-zero exit = fail');
		v = await verdictOf('', null);
		assert(v.pass === false, 'killed evaluator (exit null, no output) -> fail');
		const crash = await runLockedEvaluator(makeRun('x'), async () => { throw new Error('runner down'); });
		assert(crash.pass === false, 'runner exception -> fail, never pass');
	}

	// 6) FAILURE SIGNATURE: an improving metric is progress; a repeated error with only volatile
	//    numbers (traceback line, temp path, duration) changed is still the same failure.
	{
		console.log('Test 6 (failure signature):');
		const improving = ['AUC 0.71 < target 0.90', 'AUC 0.78 < target 0.90', 'AUC 0.86 < target 0.90'].map(failureSignature);
		assert(new Set(improving).size === 3, 'improving metric -> three distinct signatures');
		const same = ['AUC 0.71 < target 0.90', 'AUC 0.71 < target 0.90'].map(failureSignature);
		assert(same[0] === same[1], 'identical metric -> identical signature');
		const tb = [
			'File "/tmp/run_1/x.py", line 12, in <module> KeyError: \'gene\' (took 3.2s)',
			'File "/tmp/run_7/x.py", line 40, in <module> KeyError: \'gene\' (took 9.8s)',
		].map(failureSignature);
		assert(tb[0] === tb[1], `same error, different line/path/duration -> same signature (got ${tb.join(' || ')})`);
	}

	// 7) NO-PROGRESS vs CONVERGING: a loop whose metric keeps improving must NOT be stopped as
	//    "no progress"; it runs until it passes.
	{
		const { loopDir, cwd } = tmp();
		const METRIC_EVALUATOR = `import os, json
v = float(open('auc.txt').read()) if os.path.exists('auc.txt') else 0.0
print(json.dumps({"pass": v >= 0.9, "detail": "AUC %.2f < target 0.90" % v}))`;
		const run = makeRun(METRIC_EVALUATOR);
		const aucs = ['0.71', '0.78', '0.84', '0.88', '0.93'];
		const agent: AgentStep = async (r) => {
			fs.writeFileSync(path.join(cwd, 'auc.txt'), aucs[Math.min(r.iteration, aucs.length - 1)]);
			return { output: 'trained', exitCode: 0 };
		};
		const outcome = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		console.log('Test 7 (converging metric):');
		assert(outcome === 'success', `converging loop succeeds (got ${outcome}, reason ${run.reason ?? '-'})`);
		assert(run.iteration === 5, `succeeded on iteration 5 (got ${run.iteration})`);
	}

	// 8) STUCK METRIC: the same metric three times in a row is still no progress.
	{
		const { loopDir, cwd } = tmp();
		const run = makeRun(`import json; print(json.dumps({"pass": False, "detail": "AUC 0.71 < target 0.90"}))`);
		const agent: AgentStep = async () => ({ output: 'trained', exitCode: 0 });
		const outcome = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		console.log('Test 8 (stuck metric):');
		assert(outcome === 'paused' && run.iteration === 3, `stuck metric pauses at 3 (got ${outcome} @ ${run.iteration})`);
	}

	// 9) STOP, PAUSE, RESUME: stop mid-run; an environment error pauses without counting an
	//    iteration; a resumed run continues the iteration count and history.
	{
		const { loopDir, cwd } = tmp();
		const run = makeRun(ANSWER_EVALUATOR);
		let calls = 0;
		const agent: AgentStep = async () => { calls++; fs.writeFileSync(path.join(cwd, 'answer.txt'), 'nope' + calls); return { output: 'x', exitCode: 0 }; };
		const stopped = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { }, shouldStop: () => calls >= 2 });
		console.log('Test 9 (stop / pause / resume):');
		assert(stopped === 'stopped' && run.status === 'stopped', `stop honored (got ${stopped})`);

		const run2 = makeRun(ANSWER_EVALUATOR);
		let n = 0;
		const flaky: AgentStep = async () => {
			n++;
			if (n === 2) { return { output: '', exitCode: 1, envError: true, error: 'quota exceeded' }; }
			fs.writeFileSync(path.join(cwd, 'answer.txt'), n >= 3 ? '42' : 'wrong');
			return { output: 'x', exitCode: 0 };
		};
		const paused = await runLoop(run2, flaky, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		assert(paused === 'paused' && run2.iteration === 1, `env error pauses without counting an iteration (got ${paused} @ ${run2.iteration})`);
		assert(run2.reason === 'quota exceeded', `pause reason surfaced (got ${run2.reason})`);
		const resumed = await runLoop(run2, flaky, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		assert(resumed === 'success' && run2.iteration === 2 && run2.history.length === 2, `resume continues count + history (got ${resumed} @ ${run2.iteration}, history ${run2.history.length})`);

		const run3 = makeRun(ANSWER_EVALUATOR);
		const slow: AgentStep = async () => ({ output: '', exitCode: null, timedOut: true });
		const to = await runLoop(run3, slow, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		assert(to === 'paused' && /time budget/.test(run3.reason ?? ''), `timed-out turn pauses with a time-budget reason (got ${to})`);
	}

	// 10) TIME BUDGET: wall-clock limit ends a loop that never passes.
	{
		const { loopDir, cwd } = tmp();
		const run = makeRun(ANSWER_EVALUATOR, 1000);
		run.budget.maxMin = 0.01; // 0.6 s
		let k = 0;
		const agent: AgentStep = async () => { k++; await new Promise(r => setTimeout(r, 250)); fs.writeFileSync(path.join(cwd, 'answer.txt'), 'v' + k); return { output: 'x', exitCode: 0 }; };
		const outcome = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		console.log('Test 10 (time budget):');
		assert(outcome === 'failed-budget' && run.iteration < 1000, `time budget stops the loop (got ${outcome} @ ${run.iteration})`);
	}


	// 11) PREFLIGHT: before a new loop starts the evaluator must print a JSON verdict on an empty
	//     results folder and must NOT pass there.
	{
		console.log('Test 11 (preflight):');
		const { cwd } = tmp();
		let pf = await preflightEvaluator(makeRun(ANSWER_EVALUATOR), localRunner(cwd));
		assert(pf.ok, `well-formed evaluator passes preflight (got ${pf.problem ?? 'ok'})`);
		pf = await preflightEvaluator(makeRun(`print(open('answer.txt').read())`), localRunner(cwd));
		assert(!pf.ok && /did not print a JSON verdict/.test(pf.problem ?? ''), 'evaluator that crashes on a missing file is refused');
		pf = await preflightEvaluator(makeRun(`import json; print(json.dumps({"pass": True, "detail": "always"}))`), localRunner(cwd));
		assert(!pf.ok && /already PASSES/.test(pf.problem ?? ''), 'evaluator that passes with no work is refused');
		const exitOnly = makeRun(`import sys, os; sys.exit(0 if os.path.exists('answer.txt') else 1)`);
		pf = await preflightEvaluator(exitOnly, localRunner(cwd));
		assert(!pf.ok, 'exit-code-only evaluator (no JSON) is refused');
	}

	// 12) RESUME AFTER A STALL: the user chose to continue; the loop runs on, does not re-pause on the
	//     same three failures at once, keeps the last feedback, and can still succeed.
	{
		const { loopDir, cwd } = tmp();
		const run = makeRun(ANSWER_EVALUATOR);
		let n = 0;
		const seen: Array<string | undefined> = [];
		const agent: AgentStep = async (_r, fb) => {
			n++; seen.push(fb);
			fs.writeFileSync(path.join(cwd, 'answer.txt'), n >= 5 ? '42' : 'wrong');
			return { output: 'x', exitCode: 0 };
		};
		const first = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		console.log('Test 12 (resume after stall):');
		assert(first === 'paused' && !!run.stall && !!run.lastFeedback, `stalled with feedback kept (got ${first})`);
		const second = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		assert(second === 'success' && run.iteration === 5, `continued and succeeded on iteration 5 (got ${second} @ ${run.iteration})`);
		assert(run.stall === undefined && run.noProgressFrom === 3, 'stall cleared and repeat window restarted at the resume point');
		assert(!!seen[3] && /answer|got/.test(seen[3] ?? ''), 'first iteration after resume received the previous fix-this feedback');
		assert(run.lastFeedback === undefined, 'feedback cleared on success');
	}

	// 13) TOTAL TIME BUDGET: time spent before a pause counts after resume.
	{
		const { loopDir, cwd } = tmp();
		const run = makeRun(ANSWER_EVALUATOR, 1000);
		run.budget.maxMin = 0.02; // 1.2 s total
		let k = 0;
		const agent: AgentStep = async () => {
			k++;
			await new Promise(r => setTimeout(r, 300));
			if (k === 3) { return { output: '', exitCode: 1, envError: true, error: 'quota' }; }
			fs.writeFileSync(path.join(cwd, 'answer.txt'), 'v' + k);
			return { output: 'x', exitCode: 0 };
		};
		const a = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		const usedAfterPause = run.budget.usedMs ?? 0;
		const b = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		console.log('Test 13 (total time budget across resume):');
		assert(a === 'paused' && usedAfterPause >= 800, `time before the pause was recorded (${usedAfterPause} ms)`);
		assert(b === 'failed-budget' && (run.budget.usedMs ?? 0) >= 1200 && (run.budget.usedMs ?? 0) < 2500, `resumed run stopped on the TOTAL budget (used ${run.budget.usedMs} ms)`);
		const again = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		assert(again === 'failed-budget' && k <= 6, `resuming with no budget left runs no new turn (turns ${k})`);
	}

	// 14) ERRORS NEVER LEAVE A LOOP "RUNNING": a sub-agent turn that throws pauses with the reason; a
	//     failed save right after a pass keeps the success (a resume must not run past a passing iteration).
	{
		const { loopDir, cwd } = tmp();
		const run = makeRun(ANSWER_EVALUATOR);
		const thrower: AgentStep = async () => { throw new Error('spawn ENOENT'); };
		const o = await runLoop(run, thrower, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		console.log('Test 14 (errors):');
		assert(o === 'paused' && run.status === 'paused' && /failed to run: spawn ENOENT/.test(run.reason ?? ''), `throwing turn pauses with the reason (got ${o}, ${run.reason})`);

		const run2 = makeRun(ANSWER_EVALUATOR);
		const writer: AgentStep = async () => { fs.writeFileSync(path.join(cwd, 'answer.txt'), '42'); return { output: 'x', exitCode: 0 }; };
		let saves = 0;
		const flakySave = (r: LoopRun) => { saves++; if (r.history.length === 1 && r.iteration === 1) { throw new Error('disk full'); } };
		const o2 = await runLoop(run2, writer, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: flakySave });
		assert(o2 === 'success' && run2.status === 'success', `save failure after a pass keeps success (got ${o2}/${run2.status}, saves ${saves})`);
	}

	console.log(failures === 0 ? '\nALL ENGINE TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

void main();
