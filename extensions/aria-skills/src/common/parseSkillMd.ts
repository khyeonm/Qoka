/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EnvVarRequirement, SkillDependency } from './types';

/**
 * Regex-based SKILL.md parser. Used as the always-available baseline
 * when Claude analysis is unavailable, and as a sanity guard around the
 * Claude output (we union the two so a misformatted LLM response never
 * loses a key the regex would have caught).
 *
 * The parser is intentionally lenient: it scans the whole document for
 * env-var-shaped tokens, mentions of dependent skills, and a few common
 * "obtain key here" URLs. False positives are expected — the wizard
 * always asks the user to confirm before saving.
 */

export interface ParsedSkillMd {
	name: string | undefined;
	description: string | undefined;
	category: string | undefined;
	envVars: EnvVarRequirement[];
	dependencies: SkillDependency[];
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;
const NAME_KEY_RE = /^name:\s*(.+)$/m;
const DESCRIPTION_KEY_RE = /^description:\s*(.+?)(?:\n\w|\n$|$)/ms;

const ENV_VAR_NAME_RE = /\b([A-Z][A-Z0-9_]{3,}_(?:KEY|TOKEN|SECRET|ID|PASSWORD|URL))\b/g;
const ENV_VAR_EMAIL_RE = /\bUSER_EMAIL\b/g;
const PY_ENVIRON_RE = /os\.environ(?:\.get)?\(['"]([A-Z][A-Z0-9_]{2,})['"]/g;

const DEPENDENCY_PATTERNS: RegExp[] = [
	/Read the\s+`?([\w-]+)`?\s+skill/gi,
	/Depends on\s+(?:the\s+)?`?([\w-]+)`?\s+skill/gi,
	/Requires\s+`?([\w-]+)`?(?:\s+to be\s+|\s+for\s+|\s+skill)/gi,
	/prerequisite[s]?:[^\n]*?`([\w-]+)`/gi,
];

const URL_NEAR_KEY_RE = /(?:register|sign\s*up|api\s+key|obtain|create)[^\n]{0,80}(https?:\/\/[^\s<>"')]+)/gi;

/**
 * Run the parser against a SKILL.md body. Returns whatever it can find;
 * the caller decides which fields to surface to the user.
 */
export function parseSkillMd(content: string): ParsedSkillMd {
	const frontmatter = extractFrontmatter(content);
	const name = extractFrontmatterField(frontmatter, NAME_KEY_RE);
	const description = extractDescription(frontmatter, content);
	const category = inferCategoryFromText(content);
	const envVars = extractEnvVars(content);
	const dependencies = extractDependencies(content);
	return { name, description, category, envVars, dependencies };
}

function extractFrontmatter(content: string): string {
	const m = FRONTMATTER_RE.exec(content);
	return m ? m[1] : '';
}

function extractFrontmatterField(frontmatter: string, re: RegExp): string | undefined {
	const m = re.exec(frontmatter);
	if (!m) {
		return undefined;
	}
	return m[1].trim().replace(/^["']|["']$/g, '');
}

function extractDescription(frontmatter: string, content: string): string | undefined {
	const desc = extractFrontmatterField(frontmatter, DESCRIPTION_KEY_RE);
	if (desc) {
		return desc.replace(/\s+/g, ' ').trim();
	}
	// Fall back to the first paragraph of the body. Markdown headings are
	// skipped so we don't return "# Title".
	const lines = content
		.replace(FRONTMATTER_RE, '')
		.split('\n')
		.map(l => l.trim())
		.filter(l => l && !l.startsWith('#'));
	if (lines.length > 0) {
		return lines.slice(0, 2).join(' ').slice(0, 280);
	}
	return undefined;
}

function inferCategoryFromText(_content: string): string | undefined {
	// Category is now fully user-driven — Aria no longer guesses one from
	// keyword matches. Skill install leaves category blank; the user types
	// whatever they want in the sidebar's Details pane.
	return undefined;
}

function extractEnvVars(content: string): EnvVarRequirement[] {
	const found = new Map<string, EnvVarRequirement>();

	const collect = (name: string): void => {
		if (found.has(name)) {
			return;
		}
		const ctx = contextAround(content, name, 240);
		// `os.environ['NAME']` (bracket access) throws KeyError on a
		// missing key — strong signal that the skill genuinely requires
		// this variable to be set. `os.environ.get('NAME')` only returns
		// None and is the optional pattern. Same idea for `os.getenv('NAME')`
		// without a default. Match anywhere in the file so we don't depend
		// on the 240-char window.
		const bracketAccess = new RegExp(`os\\.environ\\[\\s*['"]${name}['"]\\s*\\]`).test(content);
		const getenvWithoutDefault = new RegExp(`os\\.getenv\\(\\s*['"]${name}['"]\\s*\\)(?!\\s*,)`).test(content);
		const required = bracketAccess || getenvWithoutDefault || looksRequired(ctx);
		const obtainUrl = nearestUrl(content, name);
		const description = summariseContext(ctx);
		found.set(name, { name, required, description, obtainUrl });
	};

	let m: RegExpExecArray | null;
	ENV_VAR_NAME_RE.lastIndex = 0;
	while ((m = ENV_VAR_NAME_RE.exec(content)) !== null) {
		collect(m[1]);
	}
	ENV_VAR_EMAIL_RE.lastIndex = 0;
	while ((m = ENV_VAR_EMAIL_RE.exec(content)) !== null) {
		collect('USER_EMAIL');
	}
	PY_ENVIRON_RE.lastIndex = 0;
	while ((m = PY_ENVIRON_RE.exec(content)) !== null) {
		collect(m[1]);
	}
	return [...found.values()];
}

function looksRequired(ctx: string): boolean {
	const lowered = ctx.toLowerCase();

	// Explicit "optional" signals — checked first so a markdown table
	// like "| No (3 req/s without, 10 with) |" classifies correctly
	// even though the cell happens to mention rate limits.
	if (/\b(optional|recommended)\b/.test(lowered)) {
		return false;
	}
	if (/\bno\b[^\n]{0,80}\b(req\/s|rate|shared|pool|public|without|recommended|quota)\b/.test(lowered)) {
		return false;
	}
	if (/\|\s*no\b/.test(lowered)) {
		// markdown table cell: "| No (...)"
		return false;
	}
	if (/falls back to|works without/.test(lowered)) {
		return false;
	}

	// Explicit "required" signals.
	if (/\b(required|mandatory)\b/.test(lowered)) {
		return true;
	}
	if (/\b(must set|must provide|you need to set)\b/.test(lowered)) {
		return true;
	}
	if (/\|\s*yes\b/.test(lowered)) {
		// markdown table cell: "| Yes (for full text)"
		return true;
	}

	// When neither side gives us a signal, default to optional. Surfacing
	// the field as optional is the safer default: the wizard still shows
	// it, and the LLM merge can flip it to required if Claude's reading
	// of the prose disagrees. The previous default-to-required behavior
	// produced false positives in tables where every variable looked
	// required to the user.
	return false;
}

function nearestUrl(content: string, anchor: string): string | undefined {
	const idx = content.indexOf(anchor);
	if (idx < 0) {
		return undefined;
	}
	const window = content.slice(Math.max(0, idx - 300), Math.min(content.length, idx + 300));
	URL_NEAR_KEY_RE.lastIndex = 0;
	const m = URL_NEAR_KEY_RE.exec(window);
	return m ? m[1] : undefined;
}

function contextAround(content: string, anchor: string, span: number): string {
	const idx = content.indexOf(anchor);
	if (idx < 0) {
		return '';
	}
	return content.slice(Math.max(0, idx - span), Math.min(content.length, idx + span));
}

function summariseContext(ctx: string): string | undefined {
	const sentences = ctx
		.replace(/\s+/g, ' ')
		.split(/(?<=[.!?])\s+/)
		.map(s => s.trim())
		.filter(Boolean);
	return sentences[0]?.slice(0, 180);
}

function extractDependencies(content: string): SkillDependency[] {
	const found = new Map<string, SkillDependency>();
	for (const pattern of DEPENDENCY_PATTERNS) {
		pattern.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = pattern.exec(content)) !== null) {
			const name = m[1]?.trim();
			if (!name || /^(this|that|the|a)$/i.test(name)) {
				continue;
			}
			if (found.has(name)) {
				continue;
			}
			const ctx = contextAround(content, name, 180);
			found.set(name, {
				name,
				required: !/optional/i.test(ctx),
				reason: summariseContext(ctx),
			});
		}
	}
	return [...found.values()];
}
