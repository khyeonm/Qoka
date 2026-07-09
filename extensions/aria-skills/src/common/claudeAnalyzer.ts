/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { EnvVarRequirement, SkillDependency } from './types';
import { parseSkillMd } from './parseSkillMd';
import { log, logBlock } from './logger';

const execAsync = promisify(exec);

/**
 * Use Claude Code (CLI in headless mode) to extract structured metadata
 * from a SKILL.md document. Falls back to regex on every kind of
 * failure: missing CLI, three timeouts in a row, unparseable response.
 * The wizard always shows the merged result to the user, so even when
 * Claude misses something the regex pass usually catches it.
 */

const CLAUDE_PATH_CANDIDATES = [
	'claude',
	'/usr/local/bin/claude',
	'/opt/homebrew/bin/claude',
	path.join(os.homedir(), '.local/bin/claude'),
	path.join(os.homedir(), '.claude/local/claude'),
];

const NVM_DIR = path.join(os.homedir(), '.nvm/versions/node');

const MAX_ATTEMPTS = 3;
const PER_ATTEMPT_TIMEOUT_MS = 30000;

export interface AnalysisResult {
	name: string | undefined;
	description: string | undefined;
	category: string | undefined;
	envVars: EnvVarRequirement[];
	dependencies: SkillDependency[];
	/** Did Claude actually run, or did we use the regex fallback only? */
	usedClaude: boolean;
	/** When set, the wizard surfaces the message so the user knows. */
	fallbackReason?: string;
}

/**
 * Analyze a SKILL.md body. Tries Claude up to MAX_ATTEMPTS times; if all
 * attempts fail, returns the regex-only result with a fallback reason
 * the caller can surface.
 */
export async function analyzeSkillMd(content: string): Promise<AnalysisResult> {
	const regex = parseSkillMd(content);
	log(`Regex pass found ${regex.envVars.length} env var(s) and ${regex.dependencies.length} dependency reference(s).`);

	const claudeBin = await resolveClaude();
	if (!claudeBin) {
		log('Claude CLI not located — skipping LLM analysis.');
		return {
			...regex,
			usedClaude: false,
			fallbackReason: 'Claude CLI not found on PATH — using built-in pattern matcher.',
		};
	}
	log(`Using Claude binary: ${claudeBin}`);

	let lastError: string | undefined;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		log(`Claude attempt ${attempt}/${MAX_ATTEMPTS}...`);
		try {
			const llm = await runClaudeAnalysis(claudeBin, content);
			if (llm) {
				log(`Claude attempt ${attempt} parsed successfully — merging with regex pass.`);
				return mergeResults(regex, llm, true);
			}
			log(`Claude attempt ${attempt} returned a response we could not parse as JSON — retrying.`);
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			log(`Claude attempt ${attempt} failed: ${lastError}`);
		}
	}

	log(`All ${MAX_ATTEMPTS} Claude attempts exhausted. Falling back to regex.`);
	return {
		...regex,
		usedClaude: false,
		fallbackReason: `Claude analysis failed after ${MAX_ATTEMPTS} attempts (${lastError ?? 'no response'}) — using built-in pattern matcher.`,
	};
}

async function resolveClaude(): Promise<string | null> {
	for (const candidate of CLAUDE_PATH_CANDIDATES) {
		try {
			await execAsync(`"${candidate}" --version`, { timeout: 3000 });
			return candidate;
		} catch {
			// try next
		}
	}
	if (fs.existsSync(NVM_DIR)) {
		try {
			for (const ver of fs.readdirSync(NVM_DIR)) {
				const candidate = path.join(NVM_DIR, ver, 'bin/claude');
				if (fs.existsSync(candidate)) {
					return candidate;
				}
			}
		} catch {
			// ignore
		}
	}
	return null;
}

/** Build the prompt we send Claude. The instruction is rigid about the
 *  output shape because we json-parse it directly. */
function buildPrompt(skillMd: string): string {
	const trimmed = skillMd.length > 24000 ? skillMd.slice(0, 24000) + '\n…[truncated]' : skillMd;
	return [
		'You are extracting metadata from a Claude skill\'s SKILL.md.',
		'Respond with ONLY a single JSON object (no prose, no fences) using this schema:',
		'{',
		'  "name": "string or null",',
		'  "description": "string or null",',
		'  "category": "string or null — a short, generic topic label like \\"Literature\\", \\"Protein\\", or whatever fits; freeform",',
		'  "envVars": [{ "name": "ALL_CAPS_NAME", "required": true/false, "description": "string or null", "obtainUrl": "string or null" }],',
		'  "dependencies": [{ "name": "skill-name", "required": true/false, "reason": "string or null" }]',
		'}',
		'',
		'envVars are environment variables the skill reads (API keys, tokens, emails, etc.).',
		'For each envVar, the description MUST be written from the USER\'S perspective,',
		'telling them WHAT VALUE TO ENTER. Use 1 short sentence (under 100 chars).',
		'Good examples:',
		'  "Your NCBI account API key for E-utilities."',
		'  "Your email address — NCBI uses it to identify your requests."',
		'  "Your OpenAI API key from platform.openai.com."',
		'  "A Bearer token from the Crossref dashboard."',
		'Bad examples (do NOT write these):',
		'  "Environment variable for HTTP authentication."',
		'  "API key that increases rate limits from 3 to 10 req/s."',
		'  "Required for accessing the service."',
		'obtainUrl is the page where the user signs up / generates this key, if the doc mentions one.',
		'',
		'For the `required` flag, evaluate against the skill\'s PRIMARY PURPOSE',
		'(what the skill\'s name + first paragraph describe).',
		'  Set required=true ONLY when the skill can NOT fulfill its primary',
		'  purpose without the value — the skill would emit errors on basic',
		'  use, or one of its main capabilities literally cannot run.',
		'  Set required=false when the skill\'s primary purpose still works without',
		'  the value. This includes ALL of:',
		'    - The variable only unlocks a sub-feature or optional output.',
		'    - The variable improves rate limits, quotas, or shared-pool fairness.',
		'    - The doc lists alternate paths that don\'t need the key.',
		'    - The variable is for one of MANY databases the skill queries.',
		'  Concrete signals:',
		'    OPTIONAL (required=false):',
		'      "No", "No (...)", "optional", "recommended"',
		'      "higher rate limit", "shared pool", "without it"',
		'      "falls back to public access", "increases quota"',
		'      "Yes for full text" — full text is one feature among many',
		'      Python `os.environ.get("X")` or `os.getenv("X", default)` (returns None / default)',
		'    REQUIRED (required=true):',
		'      "Yes" without qualifiers, "Mandatory", "Required" (in a Required? column or as a header)',
		'      "must set", "must provide", "skill requires"',
		'      Explicit headers like "**Required credentials**" or "Required environment variables"',
		'      Python `os.environ["X"]` (bracket access — throws KeyError if missing)',
		'      Python `os.getenv("X")` without a default argument',
		'      The skill literally fails or returns errors without the value',
		'  Examples (skill: paper-lookup — searches 10 paper databases):',
		'    NCBI_API_KEY: "No (3 req/s without, 10 with)" → required=false',
		'    CORE_API_KEY: "Yes for full text" → required=false (search still works without it,',
		'      full text is just one optional output among many)',
		'    S2_API_KEY: "No (shared pool without)" → required=false',
		'    OPENALEX_API_KEY: "No (recommended)" → required=false',
		'  When in doubt, prefer required=false. The user can always type it in;',
		'  marking optional variables as required just clutters the "missing" badge.',
		'',
		'dependencies are other Claude skills this skill expects to be installed.',
		'Same required/optional rules apply.',
		'Suggest a short, generic category label (one or two words). The user can rename it later in the sidebar, so just pick what best fits the skill\'s primary topic. Set null if nothing obvious applies.',
		'',
		'SKILL.md:',
		'```',
		trimmed,
		'```',
	].join('\n');
}

async function runClaudeAnalysis(claudeBin: string, content: string): Promise<Partial<AnalysisResult> | null> {
	const prompt = buildPrompt(content);
	logBlock(`Claude prompt (${prompt.length} chars)`, prompt);
	const stdout = await runWithStdin(claudeBin, ['--print', '--output-format', 'text'], prompt, PER_ATTEMPT_TIMEOUT_MS);
	logBlock(`Claude raw response (${stdout.length} chars)`, stdout);
	const json = extractJson(stdout);
	if (!json) {
		log('Could not extract a JSON object from Claude\'s response.');
		return null;
	}
	log(`Parsed JSON: ${JSON.stringify(json).slice(0, 500)}${JSON.stringify(json).length > 500 ? '...' : ''}`);
	return normalizeLlmShape(json);
}

/**
 * Drive a child process by writing a prompt to its stdin and collecting
 * stdout. We need this because child_process.exec doesn't expose an
 * `input` option — the obvious-looking `execAsync(cmd, {input})` call
 * silently dropped the prompt, which was why Claude kept exiting with
 * an empty buffer and the wizard fell back to regex.
 */
function runWithStdin(bin: string, args: string[], input: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill('SIGTERM');
			reject(new Error(`Timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.on('data', d => { stdout += d.toString(); });
		child.stderr.on('data', d => { stderr += d.toString(); });
		child.on('error', err => {
			clearTimeout(timer);
			reject(err);
		});
		child.on('close', code => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`Exit ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
			}
		});
		try {
			child.stdin.write(input);
			child.stdin.end();
		} catch (e) {
			clearTimeout(timer);
			reject(e);
		}
	});
}

function extractJson(raw: string): unknown {
	const trimmed = raw.trim();
	// Tolerate fenced code blocks even though we asked for plain JSON.
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(trimmed);
	const body = fenced ? fenced[1] : trimmed;
	try {
		return JSON.parse(body);
	} catch {
		// Last-ditch: find the first { and last } and try that slice.
		const first = body.indexOf('{');
		const last = body.lastIndexOf('}');
		if (first >= 0 && last > first) {
			try {
				return JSON.parse(body.slice(first, last + 1));
			} catch {
				return null;
			}
		}
		return null;
	}
}

function normalizeLlmShape(raw: unknown): Partial<AnalysisResult> {
	const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
	const asStr = (x: unknown): string | undefined =>
		typeof x === 'string' && x.trim().length > 0 ? x.trim() : undefined;
	const envVars: EnvVarRequirement[] = Array.isArray(obj.envVars)
		? obj.envVars.flatMap(v => {
			const o = v as Record<string, unknown>;
			const name = asStr(o?.name);
			if (!name) {
				return [];
			}
			return [{
				name,
				required: o?.required === false ? false : true,
				description: asStr(o?.description),
				obtainUrl: asStr(o?.obtainUrl),
			}];
		})
		: [];
	const dependencies: SkillDependency[] = Array.isArray(obj.dependencies)
		? obj.dependencies.flatMap(v => {
			const o = v as Record<string, unknown>;
			const name = asStr(o?.name);
			if (!name) {
				return [];
			}
			return [{
				name,
				required: o?.required === false ? false : true,
				reason: asStr(o?.reason),
			}];
		})
		: [];
	return {
		name: asStr(obj.name),
		description: asStr(obj.description),
		category: asStr(obj.category),
		envVars,
		dependencies,
	};
}

/**
 * Combine regex + LLM results. The union of env vars and dependencies
 * is taken so neither source can drop one the other found; LLM wins on
 * name/description/category because it parses natural language better.
 */
function mergeResults(
	regex: ReturnType<typeof parseSkillMd>,
	llm: Partial<AnalysisResult>,
	usedClaude: boolean,
): AnalysisResult {
	const envVars = mergeEnvVars(regex.envVars, llm.envVars ?? []);
	const dependencies = mergeDependencies(regex.dependencies, llm.dependencies ?? []);
	return {
		name: llm.name ?? regex.name,
		description: llm.description ?? regex.description,
		category: llm.category ?? regex.category,
		envVars,
		dependencies,
		usedClaude,
	};
}

function mergeEnvVars(a: EnvVarRequirement[], b: EnvVarRequirement[]): EnvVarRequirement[] {
	// `a` is the regex pass, `b` is the LLM pass. For each field we
	// pick the source that's typically more reliable:
	//   - description: LLM wins. Regex grabs the first sentence within
	//     ~240 chars of the variable name, which is fine for prose
	//     docs but mangles markdown tables.
	//   - obtainUrl: regex wins. We pulled it out of the SKILL.md text
	//     verbatim, whereas LLMs can hallucinate paths.
	//   - required: LLM wins. Claude reads natural language and tables
	//     (e.g. "No (3 req/s without, 10 with)" → optional) much better
	//     than the regex's "default to required" heuristic.
	const map = new Map<string, EnvVarRequirement>();
	for (const v of a) {
		map.set(v.name, v);
	}
	for (const v of b) {
		const prior = map.get(v.name);
		if (!prior) {
			map.set(v.name, v);
		} else {
			map.set(v.name, {
				name: v.name,
				required: v.required,
				description: v.description ?? prior.description,
				obtainUrl: prior.obtainUrl ?? v.obtainUrl,
			});
		}
	}
	return [...map.values()];
}

function mergeDependencies(a: SkillDependency[], b: SkillDependency[]): SkillDependency[] {
	const map = new Map<string, SkillDependency>();
	for (const d of a) {
		map.set(d.name, d);
	}
	for (const d of b) {
		const prior = map.get(d.name);
		if (!prior) {
			map.set(d.name, d);
		} else {
			map.set(d.name, {
				name: d.name,
				required: d.required || prior.required,
				reason: prior.reason ?? d.reason,
			});
		}
	}
	return [...map.values()];
}
