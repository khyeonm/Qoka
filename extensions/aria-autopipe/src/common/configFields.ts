/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parse a pipeline's config.yaml into a list of editable INPUT fields, and write
 * chosen values back into the YAML in place (comments and structure preserved).
 *
 * A faithful TypeScript port of autopipe-app's viewer.rs input_* helpers: Qoka has
 * no separate input schema, so - exactly like autopipe - the "form" is derived at
 * runtime from the pipeline's own config.yaml (top-level scalars + comments). Type
 * is inferred from the raw YAML scalar, "required" from a "required" keyword in the
 * comment, and "is file" from a key-name allowlist or a value already under /input/.
 */

export type FieldType = 'string' | 'int' | 'float' | 'bool';

export interface ConfigField {
	key: string;
	/** The display value (unquoted). */
	value: string;
	type: FieldType;
	/** True when this field should render a file picker (input data file). */
	isFile: boolean;
	required: boolean;
	description: string;
}

// Key names that denote a pickable INPUT data file. Precise on purpose: a value
// that merely ends in a data extension (e.g. an internal output filename) must NOT
// be treated as a file, or Save would create a broken symlink. Only raw-input keys,
// or defaults already pointing into the /input mount, qualify.
const FILE_KEYS = ['r1', 'r2', 'reads', 'input', 'fastq', 'fq', 'reference', 'genome', 'fasta', 'fa', 'bam'];

/** Whether a config field is a pickable INPUT file. */
export function isFileField(key: string, value: string): boolean {
	const k = key.toLowerCase();
	if (FILE_KEYS.some(fk => k === fk || k.endsWith(`_${fk}`) || k.startsWith(`${fk}_`))) {
		return true;
	}
	return value.trim().startsWith('/input/');
}

/** Detect a YAML scalar's type from its RAW (unstripped) form, so it can be written
 *  back with the same type. Quoted values stay strings. */
export function detectType(raw: string): FieldType {
	const r = raw.trim();
	if (r.startsWith('"') || r.startsWith("'") || r === '') { return 'string'; }
	if (r === 'true' || r === 'false') { return 'bool'; }
	if (/^[+-]?\d+$/.test(r)) { return 'int'; }
	if (!Number.isNaN(Number(r)) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(r)) { return 'float'; }
	return 'string';
}

/** Split "value  # comment" respecting a leading double-quoted string. */
function splitInlineComment(s: string): { value: string; comment: string } {
	const t = s.trim();
	if (t.startsWith('"')) {
		const end = t.indexOf('"', 1);
		if (end !== -1) {
			const val = t.slice(0, end + 1);
			const rest = t.slice(end + 1).trimStart();
			const comment = rest.startsWith('#') ? rest.slice(1).trim() : '';
			return { value: val, comment };
		}
	}
	const hpos = t.indexOf('#');
	if (hpos !== -1) { return { value: t.slice(0, hpos).trim(), comment: t.slice(hpos + 1).trim() }; }
	return { value: t, comment: '' };
}

/**
 * Parse top-level scalar config fields with type, required flag (comment contains
 * "required"), and description (preceding comment block + inline). `aiDesc` supplies
 * clean per-key descriptions written by the AI; the raw config comment is the
 * fallback. Nested/indented lines are ignored (only top-level scalars are editable).
 */
export function parseConfigFields(yaml: string, aiDesc: Record<string, string> = {}): ConfigField[] {
	const out: ConfigField[] = [];
	let pending: string[] = [];
	// A comment block above a GROUP of keys describes every key in that group, so it
	// persists across consecutive key lines and clears only on a blank line or a NEW
	// comment block after some keys.
	let lastWasKey = false;
	for (const line of yaml.split('\n')) {
		const trimmed = line.replace(/^\s+/, '');
		if (trimmed === '') { pending = []; lastWasKey = false; continue; }
		if (/^\s/.test(line)) { continue; } // nested / indented - not a top-level scalar
		if (trimmed.startsWith('#')) {
			if (lastWasKey) { pending = []; lastWasKey = false; }
			const c = trimmed.replace(/^#+/, '').trim();
			if (c !== '' && !/^[=-]+$/.test(c)) { pending.push(c); }
			continue;
		}
		const idx = line.indexOf(':');
		if (idx === -1) { pending = []; lastWasKey = false; continue; }
		const key = line.slice(0, idx).trim();
		if (key === '' || key.includes(' ')) { pending = []; lastWasKey = false; continue; }
		const after = line.slice(idx + 1).trim();
		const { value: rawVal, comment: inlineComment } = splitInlineComment(after);
		const ty = detectType(rawVal);
		const display = rawVal.trim().replace(/^["']|["']$/g, '');
		const isFile = isFileField(key, display);

		let configComment = pending.join(' ');
		if (inlineComment !== '') { configComment = configComment === '' ? inlineComment : `${configComment} ${inlineComment}`; }
		const required = configComment.toLowerCase().includes('required');
		const desc = aiDesc[key] ?? configComment;

		out.push({ key, value: display, type: ty, isFile, required, description: desc });
		lastWasKey = true;
	}
	return out;
}

/** Double-quote a YAML string value, escaping backslashes and quotes. */
function dquote(v: string): string {
	return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Format a value for YAML in the given type, so ints stay ints, bools stay bools,
 *  and strings stay quoted strings. */
export function formatValue(value: string, type: FieldType): string {
	const v = value.trim();
	if (type === 'bool') { return (v === 'true' || v === 'false') ? v : dquote(v); }
	if (type === 'int') { return /^[+-]?\d+$/.test(v) ? v : dquote(v); }
	if (type === 'float') { return (!Number.isNaN(Number(v)) && v !== '') ? v : dquote(v); }
	return dquote(v);
}

/**
 * Replace the value of a top-level key in place, preserving comments/structure,
 * INCLUDING any inline `# comment` on that key's line (so descriptions survive
 * repeated saves). `formattedValue` is written verbatim (already formatted).
 */
export function setYamlValue(yaml: string, key: string, formattedValue: string): string {
	let found = false;
	const lines = yaml.split('\n').map(line => {
		if (found || /^\s/.test(line)) { return line; }
		if (line.startsWith(key) && line.slice(key.length).replace(/^\s+/, '').startsWith(':')) {
			found = true;
			const c = line.indexOf(':');
			const after = c !== -1 ? line.slice(c + 1) : '';
			const { comment } = splitInlineComment(after.trim());
			const tail = comment === '' ? '' : `  # ${comment}`;
			return `${key}: ${formattedValue}${tail}`;
		}
		return line;
	});
	return lines.join('\n');
}
