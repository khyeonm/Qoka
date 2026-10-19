/* Headless self-test for the deterministic engine (no vscode, no app). Bundle with
 * esbuild and run with node: validates success / no-progress / budget / evaluator-lock.
 * The evaluatorRunner is injected (a LOCAL runner here; the extension injects a run-env one). */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { LoopRun, LoopSpec } from './schema';
import { parseClaudeStream } from './headlessRun';
import { runLoop, runLockedEvaluator, materializeAndLockEvaluator, failureSignature, preflightEvaluator, findEvaluatorIssue, findLocalRootLiteral, findDoubleEscapedRawString, findGoalUnreachable, AgentStep, ScriptRunner } from './engine';

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
		const cmd = language === 'python' ? 'python3' : language === 'node' ? 'node' : language === 'uv' ? 'uv' : 'bash';
		const f = path.join(cwd, `.eval-${Math.random().toString(16).slice(2)}.${language === 'uv' ? 'py' : 'tmp'}`);
		fs.writeFileSync(f, script);
		let out = '';
		let err = '';
		const proc = spawn(cmd, language === 'uv' ? ['run', '--no-project', '--quiet', f] : [f], { cwd, env: language === 'uv' ? { ...process.env, PYTHONNOUSERSITE: '1' } : process.env });
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
		// This mock turn ignores its time limit, so the budget can run out before the evaluator gets to judge:
		// then the loop pauses for more time instead of ending as out of budget.
		const outOfTime = b === 'failed-budget' || (b === 'paused' && /time budget ran out/.test(run.reason ?? ''));
		assert(outOfTime && (run.budget.usedMs ?? 0) >= 1200 && (run.budget.usedMs ?? 0) < 2500, `resumed run stopped on the TOTAL budget (got ${b}, used ${run.budget.usedMs} ms)`);
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

	// 15) EVALUATOR PACKAGES: an import the evaluator cannot satisfy is refused before the start (also when
	//     the evaluator catches it, or only reaches it after an early "file missing" exit), pauses a running
	//     loop at once (the sub-agent cannot fix it), the declared packages reach the runner and the lock.
	{
		const { loopDir, cwd } = tmp();
		console.log('Test 15 (evaluator packages):');
		const caught = `import json
try:
	import qoka_no_such_mod
except Exception as e:
	print(json.dumps({"pass": False, "detail": "missing dependency: %s" % e}))
	raise SystemExit(0)
print(json.dumps({"pass": False, "detail": "x"}))`;
		let pf = await preflightEvaluator(makeRun(caught), localRunner(cwd));
		assert(!pf.ok && /qoka_no_such_mod/.test(pf.problem ?? ''), `caught import error is refused (got ${pf.problem ?? 'ok'})`);
		const lazy = `import json, os, sys
if not os.path.exists('answer.txt'):
	print(json.dumps({"pass": False, "detail": "answer.txt missing"})); sys.exit(0)
import qoka_no_such_mod
print(json.dumps({"pass": True, "detail": "ok"}))`;
		pf = await preflightEvaluator(makeRun(lazy), localRunner(cwd));
		assert(!pf.ok && /qoka_no_such_mod/.test(pf.problem ?? ''), `import after an early exit is refused (got ${pf.problem ?? 'ok'})`);
		pf = await preflightEvaluator(makeRun(ANSWER_EVALUATOR), localRunner(cwd));
		assert(pf.ok, 'standard-library evaluator still passes preflight');

		const run = makeRun(lazy, 5);
		const agent: AgentStep = async () => { fs.writeFileSync(path.join(cwd, 'answer.txt'), '42'); return { output: 'x', exitCode: 0 }; };
		const o = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		assert(o === 'paused' && run.evaluatorMissingModule === 'qoka_no_such_mod' && run.iteration === 1, `running loop pauses at once on the evaluator's own import failure (got ${o}, ${run.evaluatorMissingModule}, iter ${run.iteration})`);

		const seen: (string[] | undefined)[] = [];
		const spy: ScriptRunner = (code, lang, deps) => { seen.push(deps); return localRunner(cwd)(code, lang, deps); };
		const withDeps = makeRun(ANSWER_EVALUATOR);
		withDeps.spec.evaluator.dependencies = ['scikit-learn', ' numpy ', 'numpy'];
		await runLockedEvaluator(withDeps, spy);
		assert(JSON.stringify(seen[0]) === '["numpy","scikit-learn"]', `declared packages reach the runner, cleaned (got ${JSON.stringify(seen[0])})`);
		const plain = makeRun(ANSWER_EVALUATOR);
		materializeAndLockEvaluator(plain, loopDir);
		materializeAndLockEvaluator(withDeps, loopDir);
		assert(!!plain.spec.evaluator.hash && plain.spec.evaluator.hash !== withDeps.spec.evaluator.hash, 'the package list is part of the lock');

		// The real run-env runner: python through uv with an always-present PEP 723 block. A package that is
		// only installed for the user (or in some other venv) must be invisible; a declared one is there.
		if (spawnSync('uv', ['--version']).status === 0) {
			const uvRunner: ScriptRunner = (script, _language, deps) => {
				const arr = (deps ?? []).map(d => `"${d}"`).join(', ');
				return localRunner(cwd)(`# /// script\n# dependencies = [${arr}]\n# ///\n${script}`, 'uv', deps);
			};
			const probe = makeRun(`import json, importlib.util
print(json.dumps({"pass": importlib.util.find_spec("numpy") is not None, "detail": "numpy"}))`);
			const bare = await runLockedEvaluator(probe, uvRunner);
			probe.spec.evaluator.dependencies = ['numpy'];
			const declared = await runLockedEvaluator(probe, uvRunner);
			assert(!bare.pass && declared.pass, `uv evaluator sees only declared packages (bare ${bare.pass}, declared ${declared.pass})`);
		} else { console.log('  skip - uv not installed'); }
	}

	// 16) EVALUATOR ISSUE: a sub-agent that reports [QOKA_EVALUATOR_ISSUE] pauses the loop at once with its
	//     reason (no waiting for the no-change pause); a pass still wins; quoting the marker mid-sentence
	//     does not count; the no-change report carries the sub-agent's last note.
	{
		const { loopDir, cwd } = tmp();
		console.log('Test 16 (evaluator issue):');
		const run = makeRun(ANSWER_EVALUATOR, 10);
		const reporter: AgentStep = async () => ({ output: 'Wrote answer.txt.\n[QOKA_EVALUATOR_ISSUE] regex A\\\\d+ can never match the A1..A6 headers', exitCode: 0 });
		const o = await runLoop(run, reporter, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		assert(o === 'paused' && run.iteration === 1 && /regex/.test(run.evaluatorIssue ?? '') && /evaluator itself/.test(run.reason ?? ''), `paused after 1 iteration with the reason (got ${o}, iter ${run.iteration}, ${run.evaluatorIssue})`);

		const run2 = makeRun(ANSWER_EVALUATOR, 10);
		const passer: AgentStep = async () => { fs.writeFileSync(path.join(cwd, 'answer.txt'), '42'); return { output: '[QOKA_EVALUATOR_ISSUE] looks odd', exitCode: 0 }; };
		const o2 = await runLoop(run2, passer, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		assert(o2 === 'success', `a passing iteration still succeeds (got ${o2})`);
		fs.rmSync(path.join(cwd, 'answer.txt'), { force: true });

		assert(findEvaluatorIssue('I will not use the [QOKA_EVALUATOR_ISSUE] marker here.') === undefined, 'marker quoted mid-sentence is ignored');
		assert(findEvaluatorIssue('done\n- [QOKA_EVALUATOR_ISSUE] reads /mnt/x/data.csv which is absent') === 'reads /mnt/x/data.csv which is absent', 'marker at line start (list item) is read');

		const run3 = makeRun(ANSWER_EVALUATOR, 10);
		const stuck: AgentStep = async () => ({ output: 'I think the evaluator path is wrong, but I am not sure.', exitCode: 0 });
		const o3 = await runLoop(run3, stuck, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		assert(o3 === 'paused' && !!run3.stall && /What the sub-agent said/.test(run3.stall.report) && /path is wrong/.test(run3.stall.report), `no-change report includes the sub-agent's last note (got ${o3})`);
	}

	// 17) INPUTS WHERE THE EVALUATOR RUNS: every declared input must exist in the run environment before the
	//     lock (relative ones under QOKA_PROJECT_ROOT, the run env's view of the project); the user's local
	//     project path written into evaluator code is detected in any slash style.
	{
		const { cwd } = tmp();
		console.log('Test 17 (inputs):');
		const runRoot = path.dirname(cwd);
		fs.mkdirSync(path.join(runRoot, 'data'), { recursive: true });
		fs.writeFileSync(path.join(runRoot, 'data', 'reads.fasta'), '>r\nACGT\n');
		const prev = process.env.QOKA_PROJECT_ROOT;
		process.env.QOKA_PROJECT_ROOT = runRoot;
		try {
			const ok = makeRun(ANSWER_EVALUATOR); ok.spec.inputs = ['data/reads.fasta', path.join(runRoot, 'data', 'reads.fasta')];
			let pf = await preflightEvaluator(ok, localRunner(cwd));
			assert(pf.ok, `present inputs pass (got ${pf.problem ?? 'ok'})`);
			const bad = makeRun(ANSWER_EVALUATOR); bad.spec.inputs = ['data/reads.fasta', 'data/missing.csv', '/no/such/server/file.h5ad'];
			pf = await preflightEvaluator(bad, localRunner(cwd));
			assert(!pf.ok && /data\/missing\.csv/.test(pf.problem ?? '') && /\/no\/such\/server/.test(pf.problem ?? '') && !/data\/reads\.fasta,/.test(pf.problem ?? ''), `missing inputs are refused, present ones not listed (got ${pf.problem ?? 'ok'})`);
		} finally { if (prev === undefined) { delete process.env.QOKA_PROJECT_ROOT; } else { process.env.QOKA_PROJECT_ROOT = prev; } }
		assert(findLocalRootLiteral('open("/tmp/qoka-t-A2/data/reads.fasta")', '/tmp/qoka-t-A2') === '/tmp/qoka-t-A2', 'posix local root found');
		assert(!!findLocalRootLiteral('p = r"C:\\Users\\me\\proj\\data\\x.csv"', 'C:\\Users\\me\\proj'), 'windows local root (raw string) found');
		assert(!!findLocalRootLiteral('p = "C:/Users/me/proj/data/x.csv"', 'C:\\Users\\me\\proj'), 'windows local root (forward slashes) found');
		assert(!!findLocalRootLiteral('p = "C:\\\\Users\\\\me\\\\proj\\\\data"', 'C:\\Users\\me\\proj'), 'windows local root (escaped backslashes) found');
		assert(findLocalRootLiteral('ROOT = os.environ.get("QOKA_PROJECT_ROOT") or os.path.abspath("../../..")', '/tmp/qoka-t-A2') === undefined, 'QOKA_PROJECT_ROOT evaluator is accepted');
	}

	// 18) THE TIME BUDGET IS A HARD TOTAL: each turn gets only what is LEFT of maxMin (not a fresh full
	//     budget), so a long turn is cut at the budget instead of carrying the loop past it.
	{
		const { loopDir, cwd } = tmp();
		console.log('Test 18 (turn limited to the remaining budget):');
		const run = makeRun(ANSWER_EVALUATOR, 100);
		run.budget.maxMin = 0.05; // 3 s total
		const limits: number[] = [];
		// A turn that honours its limit like the real CLI: 1.2 s of work, or cut off at the limit.
		const agent: AgentStep = async (_r, _f, lim) => {
			const t = lim?.timeoutMs ?? Infinity;
			limits.push(t);
			await new Promise(res => setTimeout(res, Math.min(1200, t)));
			if (t < 1200) { return { output: '', exitCode: null, timedOut: true }; }
			fs.writeFileSync(path.join(cwd, 'answer.txt'), 'wrong');
			return { output: 'x', exitCode: 0 };
		};
		const o = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		const used = run.budget.usedMs ?? 0;
		assert(limits[0] <= 3000 && limits[0] > 2000, `first turn may use the whole remaining budget (${Math.round(limits[0])} ms)`);
		assert(limits.length >= 2 && limits.every((l, i) => i === 0 || l < limits[i - 1]), `each later turn gets only what is left (${limits.map(l => Math.round(l)).join(', ')} ms)`);
		assert(used < 3000 + 2500, `total stays near the budget, not budget + a full turn (used ${used} ms)`);
		assert(o === 'failed-budget' || (o === 'paused' && /ran out during iteration/.test(run.reason ?? '')), `ends out of budget or paused as cut off (got ${o}: ${run.reason})`);
	}

	// 19) DOUBLED BACKSLASH IN A RAW STRING: r"\\d" in the evaluator matches a literal backslash, so the check
	//     can never match real data. Seen three times in real designs (C4, A2, H1); ordinary strings are fine.
	{
		console.log('Test 19 (doubled backslash in raw strings):');
		const bugs = ['ai = [i for i, h in enumerate(hdr) if re.fullmatch(r"A\\\\d+", h)]', "if not re.match(r'^\\\\d+$', txt):",
			'nums = re.findall(r"-?\\\\d+", txt)', 'p = re.compile(r"""\\\\s+""")'];
		for (const b of bugs) { assert(!!findDoubleEscapedRawString(b), `flagged: ${b}`); }
		const fine = ['m = re.fullmatch(r"A\\d+", h)', 'p = re.compile("\\\\d+")', "ROOT = os.environ.get('QOKA_PROJECT_ROOT') or os.path.abspath('../../..')",
			'rows = re.split(r"\\s*,\\s*", s)', 'print("a\\\\b")', "pat = r'^[A-Z]\\w*$'"];
		for (const f of fine) { assert(!findDoubleEscapedRawString(f), `not flagged: ${f}`); }
	}

	// 20) GOAL UNREACHABLE: a sub-agent that reports [QOKA_GOAL_UNREACHABLE] with evidence pauses the loop at
	//     once - a fluctuating metric (random labels) never repeats the same detail, so the no-change pause
	//     would not fire and the loop would spend its whole budget.
	{
		const { loopDir, cwd } = tmp();
		console.log('Test 20 (goal unreachable):');
		const run = makeRun(ANSWER_EVALUATOR, 10);
		let n = 0;
		const agent: AgentStep = async () => {
			n++;
			fs.writeFileSync(path.join(cwd, 'answer.txt'), String(100 + n));  // a different failure each time
			return { output: n < 2 ? 'tried a model' : 'Permuted-label AUC equals the real one.\n[QOKA_GOAL_UNREACHABLE] labels carry no signal: CV AUC 0.50 +/- 0.02 for 5 model types', exitCode: 0 };
		};
		const o = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		assert(o === 'paused' && run.iteration === 2 && /no signal/.test(run.goalUnreachable ?? '') && /goal cannot be reached/.test(run.reason ?? ''), `paused right after the report (got ${o}, iter ${run.iteration}, ${run.goalUnreachable})`);
		assert(findGoalUnreachable('I did not use [QOKA_GOAL_UNREACHABLE] here.') === undefined, 'quoting the marker mid-sentence is ignored');
		const again = await runLoop(run, async () => { fs.writeFileSync(path.join(cwd, 'answer.txt'), '42'); return { output: 'x', exitCode: 0 }; }, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		assert(again === 'success' && run.goalUnreachable === undefined, `the user may still resume; the flag clears (got ${again})`);
	}

	// 21) NOTHING KEEPS RUNNING: the loop's leftover work in the run environment is stopped before every
	//     iteration and whenever the loop ends (success, a cut-off turn, stop); a failing kill never changes
	//     the outcome.
	{
		const { loopDir, cwd } = tmp();
		console.log('Test 21 (stop leftover work):');
		let kills = 0;
		const killWork = async () => { kills++; };
		const run = makeRun(ANSWER_EVALUATOR, 5);
		let n = 0;
		const agent: AgentStep = async () => { n++; fs.writeFileSync(path.join(cwd, 'answer.txt'), n >= 3 ? '42' : 'x' + n); return { output: 'x', exitCode: 0 }; };
		const o = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { }, killWork });
		assert(o === 'success' && kills === 4, `stopped before each of 3 iterations and once at the end (got ${o}, ${kills} kills)`);

		kills = 0;
		const cut = makeRun(ANSWER_EVALUATOR, 5);
		const o2 = await runLoop(cut, async () => ({ output: '', exitCode: null, timedOut: true }), { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { }, killWork });
		assert(o2 === 'paused' && kills === 2, `a cut-off turn's work is stopped when the loop pauses (got ${o2}, ${kills} kills)`);

		kills = 0;
		let stop = false;
		const stopper = makeRun(ANSWER_EVALUATOR, 5);
		const o3 = await runLoop(stopper, async () => { stop = true; return { output: 'x', exitCode: 0 }; }, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { }, killWork, shouldStop: () => stop });
		assert(o3 === 'stopped' && kills >= 2, `work is stopped when the user stops the loop (got ${o3}, ${kills} kills)`);

		const failing = makeRun(ANSWER_EVALUATOR, 5);
		const o4 = await runLoop(failing, async () => { fs.writeFileSync(path.join(cwd, 'answer.txt'), '42'); return { output: 'x', exitCode: 0 }; },
			{ loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { }, killWork: async () => { throw new Error('run env unreachable'); } });
		assert(o4 === 'success', `a failing kill does not change the outcome (got ${o4})`);
	}

	// 22) THE EVALUATOR RUNS INSIDE THE TIME BUDGET: a turn leaves room for it (from its measured run time),
	//     it gets only what is left as its limit, and when the budget runs out while it judges, the loop
	//     pauses with that reason instead of overrunning.
	{
		const { loopDir, cwd } = tmp();
		console.log('Test 22 (evaluator inside the budget):');
		const run = makeRun(ANSWER_EVALUATOR, 10);
		run.budget.maxMin = 0.1; // 6 s total
		run.evalMs = 400;
		const turnLimits: number[] = []; const evalLimits: number[] = [];
		const slowEval: ScriptRunner = async (code, lang, deps, lim) => {
			evalLimits.push(lim?.timeoutMs ?? -1);
			const wait = Math.min(2500, lim?.timeoutMs ?? 2500);  // a slow evaluator, cut at its limit
			await new Promise(res => setTimeout(res, wait));
			if (wait < 2500) { return { stdout: '', stderr: 'killed by timeout', exitCode: 124 }; }
			return localRunner(cwd)(code, lang, deps);
		};
		const agent: AgentStep = async (_r, _f, lim) => { turnLimits.push(lim?.timeoutMs ?? -1); fs.writeFileSync(path.join(cwd, 'answer.txt'), 'x'); return { output: 'x', exitCode: 0 }; };
		const t0 = Date.now();
		const o = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: slowEval, persist: () => { } });
		const wall = Date.now() - t0;
		assert(turnLimits[0] > 0 && turnLimits[0] <= 6000 - 30_000 * 0 - 1000, `the first turn leaves room for the evaluator (turn limit ${Math.round(turnLimits[0])} ms of 6000)`);
		assert(evalLimits.length > 0 && evalLimits.every(l => l > 0 && l <= 6000), `the evaluator gets only what is left (${evalLimits.map(l => Math.round(l)).join(', ')} ms)`);
		assert(wall < 6000 + 1500, `the loop ends near its budget, evaluator included (wall ${wall} ms)`);
		assert(o === 'failed-budget' || (o === 'paused' && /while the evaluator was judging/.test(run.reason ?? '')), `ends out of budget or paused while judging (got ${o}: ${run.reason})`);
		assert(typeof run.evalMs === 'number' && run.evalMs >= 400, `the evaluator's run time is measured for the next reserve (${run.evalMs} ms)`);
	}

	// 23) TOKENS OF A CUT-OFF TURN: per-call usage is summed, so a turn killed before its final "result" line
	//     still reports what it spent.
	{
		console.log('Test 23 (tokens of a cut-off turn):');
		const lines = [
			{ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'loading data' }], usage: { input_tokens: 1000, output_tokens: 200 } } },
			{ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'mcp__qoka-run__run_code', input: { code: 'print(1)', language: 'python' } }], usage: { input_tokens: 1000, output_tokens: 200 } } },
			{ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'fitting' }], usage: { input_tokens: 1500, output_tokens: 300 } } },
		].map(l => JSON.stringify(l)).join('\n');
		const p = parseClaudeStream(lines);
		assert(p.tokens === 3000, `cut-off turn: two calls counted once each = 3000 (got ${p.tokens})`);
		const done = parseClaudeStream(lines + '\n' + JSON.stringify({ type: 'result', result: 'done', usage: { input_tokens: 2500, output_tokens: 900 } }));
		assert(done.tokens === 3400, `finished turn: the result total wins when larger (got ${done.tokens})`);
	}

	console.log(failures === 0 ? '\nALL ENGINE TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

void main();
