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
 * runtime from the pipeline's own config.yaml. The parser is "deep": it exposes
 * top-level scalars, nested mapping leaves (as `parent.child`) and list blocks (as
 * one multi-line field), so a config that groups or lists its values still edits
 * correctly and writes back keeping the YAML structure and type.
 *
 * Whether a key renders a file picker is decided from the comment first (an
 * explicit `(input file)` / `(not a file)` marker), and only guessed when the
 * comment is silent (a file-ish key name AND a value that looks like a path).
 */

export type FieldType = 'string' | 'int' | 'float' | 'bool';

export interface ConfigField {
	/** Dotted path for a nested leaf (e.g. `qc.min_reads`), bare key otherwise. */
	key: string;
	/** The display value (unquoted; for a list, items joined by `sep`). */
	value: string;
	type: FieldType;
	/** True when this field should render a file picker (input data file). */
	isFile: boolean;
	required: boolean;
	description: string;
	/** 'scalar' for a single value, 'list' for a YAML list block. */
	kind: 'scalar' | 'list';
	/** Indentation of the value's line (spaces), for writing back in place. */
	indent: number;
	/** List only: how items were joined for display (', ' or '\n'). */
	sep?: string;
	/** List only: whether the file quotes its items (so save re-quotes them). */
	quoted?: boolean;
}

// Key names that denote a pickable INPUT data file. Precise on purpose: a value
// that merely ends in a data extension (e.g. an internal output filename) must NOT
// be treated as a file, or Save would create a broken symlink. Only raw-input keys,
// or defaults already pointing into the /input mount, qualify.
const FILE_KEYS = ['r1', 'r2', 'reads', 'input', 'fastq', 'fq', 'reference', 'genome', 'fasta', 'fa', 'bam'];

/** Whether a config field is a pickable INPUT file (by key name or /input/ value). */
export function isFileField(key: string, value: string): boolean {
	const k = key.toLowerCase();
	if (FILE_KEYS.some(fk => k === fk || k.endsWith(`_${fk}`) || k.startsWith(`${fk}_`))) {
		return true;
	}
	return value.trim().startsWith('/input/');
}

/**
 * Explicit file markers an author can put in a config comment. They decide whether
 * the Input page shows a file picker, and are stripped from the text shown as the
 * field's description.
 *   `(input file)` -> always a file picker
 *   `(not a file)` -> never a file picker, even for a name like `genome`
 * Returns the marker (true/false, or undefined when none) and the cleaned text.
 */
export function takeFileMarker(desc: string): { marker: boolean | undefined; cleaned: string } {
	const YES = ['(input file)', '(input files)'];
	const NO = ['(not a file)', '(not file)'];
	const lower = desc.toLowerCase();
	let marker: boolean | undefined;
	let out = desc;
	for (const m of [...YES, ...NO]) {
		const pos = lower.indexOf(m);
		if (pos !== -1) {
			marker = YES.includes(m);
			out = desc.slice(0, pos) + desc.slice(pos + m.length);
			break;
		}
	}
	const cleaned = out.split(/\s+/).filter(Boolean).join(' ').replace(/^[ -]+|[ -]+$/g, '');
	return { marker, cleaned };
}

/**
 * Heuristic used when a comment carries no explicit marker: the key has to be
 * named like an input file AND the value has to look like a path (or be blank,
 * i.e. still to be filled in). The value test keeps identifiers such as
 * `genome: "mm10"` out of the file picker.
 */
export function looksLikeFile(key: string, value: string): boolean {
	if (!isFileField(key, value)) { return false; }
	const v = value.trim();
	return v === '' || v.includes('/') || v.includes('.');
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

/** Strip surrounding YAML quotes from a value for display. */
function unquote(v: string): string {
	return v.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

/** One parsed line of a config block: how deep it is indented and what it holds. */
interface CfgLine {
	indent: number;
	key?: string;
	value: string;
	comment: string;
	isItem: boolean; // "- ..." list entry
}

/** Scan every line of the YAML into an indent-aware structure. */
function scanLines(yaml: string): CfgLine[] {
	return yaml.split('\n').map(l => {
		const indent = l.length - l.replace(/^\s+/, '').length;
		const t = l.trim();
		if (t === '' || t.startsWith('#')) {
			return { indent, value: '', comment: t.replace(/^#+/, '').trim(), isItem: false };
		}
		if (t.startsWith('- ')) {
			const { value, comment } = splitInlineComment(t.slice(2));
			return { indent, value, comment, isItem: true };
		}
		const i = t.indexOf(':');
		if (i !== -1 && !t.slice(0, i).includes(' ')) {
			const { value, comment } = splitInlineComment(t.slice(i + 1).trim());
			return { indent, key: t.slice(0, i).trim(), value, comment, isItem: false };
		}
		return { indent, value: t, comment: '', isItem: false };
	});
}

/**
 * Parse config fields INCLUDING nested mapping leaves (as "parent.child") and list
 * blocks (as one multi-line field). Type is inferred from the raw YAML scalar;
 * "required" from a `required` keyword in the comment (or, for a file, unless the
 * comment says `Optional`); "is file" from an explicit comment marker, else a
 * key-name + path-ish-value guess. `aiDesc` supplies clean per-key descriptions
 * written by the AI (keyed by the full dotted key); the raw config comment is the
 * fallback. Input files are sorted to the top, keeping config order within groups.
 */
export function parseConfigFields(yaml: string, aiDesc: Record<string, string> = {}): ConfigField[] {
	const lines = scanLines(yaml);
	const raw = yaml.split('\n');
	const out: ConfigField[] = [];
	const path: Array<{ indent: number; key: string }> = [];
	let pending: string[] = [];
	let lastWasKey = false;

	let i = 0;
	while (i < lines.length) {
		const l = lines[i];
		// blank line
		if (raw[i].trim() === '') { pending = []; lastWasKey = false; i++; continue; }
		// comment line
		if (raw[i].replace(/^\s+/, '').startsWith('#')) {
			if (lastWasKey) { pending = []; lastWasKey = false; }
			const c = l.comment;
			if (c !== '' && !/^[=-]+$/.test(c)) { pending.push(c); }
			i++;
			continue;
		}
		const key = l.key;
		if (key === undefined) { i++; continue; }
		while (path.length && path[path.length - 1].indent >= l.indent) { path.pop(); }

		// Does an indented block follow?
		let j = i + 1;
		while (j < lines.length && (raw[j].trim() === '' || raw[j].replace(/^\s+/, '').startsWith('#'))) { j++; }
		const child = j < lines.length && lines[j].indent > l.indent;

		const full = path.length === 0 ? key : `${path.map(p => p.key).join('.')}.${key}`;
		let desc = pending.join(' ');
		if (l.comment !== '') { desc = desc === '' ? l.comment : `${desc} ${l.comment}`; }

		if (child && lines[j].isItem) {
			// a list block: collect every item line
			const items: string[] = [];
			let k = j;
			let lastItem = j;
			while (k < lines.length) {
				if (raw[k].trim() === '' || raw[k].replace(/^\s+/, '').startsWith('#')) { k++; continue; }
				if (lines[k].indent <= l.indent || !lines[k].isItem) { break; }
				items.push(lines[k].value);
				lastItem = k;
				k++;
			}
			// Show items without their YAML quotes, on one comma-separated line when no
			// item itself contains a comma; otherwise one per line.
			const shown = items.map(unquote);
			const quoted = items.some(s => s.trim().startsWith('"'));
			const sep = shown.some(s => s.includes(',')) ? '\n' : ', ';
			const cleaned = takeFileMarker(desc).cleaned;
			out.push({
				key: full, value: shown.join(sep), type: 'string', isFile: false,
				required: cleaned.toLowerCase().includes('required'),
				description: aiDesc[full] ?? cleaned,
				kind: 'list', indent: lines[j].indent, sep, quoted,
			});
			i = lastItem + 1;
			lastWasKey = true;
			continue;
		}
		if (child) {
			// a nested mapping: descend, do not emit the parent itself
			path.push({ indent: l.indent, key });
			pending = [];
			lastWasKey = false;
			i++;
			continue;
		}
		// a plain scalar
		const display = unquote(l.value);
		const { marker, cleaned } = takeFileMarker(desc);
		const isFile = marker !== undefined ? marker : looksLikeFile(key, display);
		const low = cleaned.toLowerCase();
		// An input file is required unless the comment says it is optional, so a
		// pipeline whose comments never say "Required" still flags its inputs.
		const required = (low.includes('required') || isFile) && !low.includes('optional');
		out.push({
			key: full, value: display, type: detectType(l.value), isFile, required,
			description: aiDesc[full] ?? cleaned, kind: 'scalar', indent: l.indent,
		});
		// NOTE: pending is deliberately NOT cleared here - a comment block above a group
		// of keys describes every key in that group.
		lastWasKey = true;
		i++;
	}
	// Input files first - they are what the user has to supply - keeping the config's
	// own order within each group (Array.sort is stable).
	out.sort((a, b) => Number(b.isFile) - Number(a.isFile));
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

/**
 * Replace the value of a key addressed by a dotted path ("parent.child"), keeping
 * its indentation and any inline comment. Top-level paths fall back to
 * setYamlValue so existing behaviour is untouched.
 */
export function setDeepValue(yaml: string, pathKey: string, formattedValue: string): string {
	const parts = pathKey.split('.');
	if (parts.length === 1) { return setYamlValue(yaml, parts[0], formattedValue); }
	const lines = scanLines(yaml);
	const raw = yaml.split('\n');
	let depth = 0;
	let parentIndent: number | undefined;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		const key = l.key;
		if (key === undefined) { continue; }
		if (parentIndent !== undefined && l.indent <= parentIndent && key !== parts[depth]) { continue; }
		if (key !== parts[depth]) { continue; }
		if (depth + 1 === parts.length) {
			const indent = ' '.repeat(l.indent);
			const tail = l.comment === '' ? '' : `  # ${l.comment}`;
			raw[i] = `${indent}${key}: ${formattedValue}${tail}`;
			break;
		}
		parentIndent = l.indent;
		depth++;
	}
	return raw.join('\n');
}

/** Split the text shown for a list field back into YAML item texts, restoring the
 *  quoting style the file used. */
export function listItemsFromText(text: string, sep: string, quoted: boolean): string[] {
	const parts = sep === '\n' ? text.split('\n') : text.split(',');
	return parts
		.map(s => s.trim())
		.filter(s => s !== '')
		.map(s => (quoted && !s.startsWith('"')) ? dquote(s) : s);
}

/**
 * Replace a list block addressed by a dotted path with new items (one YAML item per
 * entry). Indentation and the key's own line are preserved, so the value stays a
 * real YAML list.
 */
export function setListBlock(yaml: string, pathKey: string, items: string[]): string {
	const parts = pathKey.split('.');
	const lines = scanLines(yaml);
	const raw = yaml.split('\n');
	let depth = 0;
	let parentIndent: number | undefined;
	let keyLine: number | undefined;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		const key = l.key;
		if (key === undefined) { continue; }
		if (parentIndent !== undefined && l.indent <= parentIndent && key !== parts[depth]) { continue; }
		if (key !== parts[depth]) { continue; }
		if (depth + 1 === parts.length) { keyLine = i; break; }
		parentIndent = l.indent;
		depth++;
	}
	if (keyLine === undefined) { return yaml; }
	// span of the existing item lines
	let start = keyLine + 1;
	while (start < lines.length && (raw[start].trim() === '' || raw[start].replace(/^\s+/, '').startsWith('#'))) { start++; }
	const itemIndent = (start < lines.length && lines[start].isItem) ? lines[start].indent : lines[keyLine].indent + 2;
	let end = start;
	while (end < lines.length) {
		if (raw[end].trim() === '' || raw[end].replace(/^\s+/, '').startsWith('#')) { end++; continue; }
		if (lines[end].indent <= lines[keyLine].indent || !lines[end].isItem) { break; }
		end++;
	}
	const pad = ' '.repeat(itemIndent);
	const newItems = items.map(s => `${pad}- ${s}`);
	return [...raw.slice(0, start), ...newItems, ...raw.slice(end)].join('\n');
}
