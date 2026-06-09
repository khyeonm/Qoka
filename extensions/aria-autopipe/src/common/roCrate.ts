/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ro-Crate / config-file helpers. Ports `parse_ro_crate_metadata`,
 * `clean_content`, and `normalize_paths` from autopipe-app.
 */

export interface PipelineMetadata {
	name: string;
	description: string;
	version: string;
	author: string;
	tools: string[];
	input_formats: string[];
	output_formats: string[];
	tags: string[];
	verified: boolean;
	based_on_url?: string;
}

/**
 * Parse pipeline metadata from RO-Crate format. Mirrors Rust's
 * `parse_ro_crate_metadata` field by field, including the @graph node
 * cross-references for creator / softwareRequirements / input / output.
 */
export function parseRoCrateMetadata(jsonStr: string): PipelineMetadata {
	let v: unknown;
	try {
		v = JSON.parse(jsonStr);
	} catch (err) {
		throw new Error(`Invalid JSON: ${(err as Error).message}`);
	}
	const top = v as { '@graph'?: unknown };
	const graph = top['@graph'];
	if (!Array.isArray(graph)) {
		throw new Error('Missing @graph array');
	}
	const nodes = graph as Array<Record<string, unknown>>;

	const dataset = nodes.find(node => node['@id'] === './');
	if (!dataset) {
		throw new Error('Missing Dataset node (@id: "./") in @graph');
	}

	const asString = (x: unknown, fallback: string): string => (typeof x === 'string' ? x : fallback);
	const stringOr = (x: unknown, fallback: string): string => asString(x, fallback);

	const name = stringOr(dataset.name, '');
	const description = stringOr(dataset.description, '');
	const version = stringOr(dataset.version, '1.0.0');

	// creator → resolve referenced Person node's name
	let author = '';
	const creatorArr = dataset.creator;
	if (Array.isArray(creatorArr) && creatorArr.length > 0) {
		const first = creatorArr[0] as { '@id'?: unknown };
		const cid = typeof first['@id'] === 'string' ? first['@id'] : null;
		if (cid) {
			const personNode = nodes.find(node => node['@id'] === cid);
			if (personNode && typeof personNode.name === 'string') {
				author = personNode.name;
			}
		}
	}

	const resolveNames = (refs: unknown): string[] => {
		if (!Array.isArray(refs)) {
			return [];
		}
		const out: string[] = [];
		for (const ref of refs) {
			const refObj = ref as { '@id'?: unknown };
			const rid = typeof refObj['@id'] === 'string' ? refObj['@id'] : null;
			if (!rid) {
				continue;
			}
			const node = nodes.find(n => n['@id'] === rid);
			if (node && typeof node.name === 'string') {
				out.push(node.name);
			}
		}
		return out;
	};

	const tools = resolveNames(dataset.softwareRequirements);
	const input_formats = resolveNames(dataset.input);
	const output_formats = resolveNames(dataset.output);

	const tagsRaw = dataset.keywords;
	const tags: string[] = Array.isArray(tagsRaw)
		? tagsRaw.filter((t): t is string => typeof t === 'string')
		: [];

	// isBasedOn may be {"@id": "..."} or a plain string.
	let based_on_url: string | undefined;
	const isBasedOn = dataset.isBasedOn;
	if (typeof isBasedOn === 'string') {
		based_on_url = isBasedOn;
	} else if (isBasedOn && typeof isBasedOn === 'object') {
		const obj = isBasedOn as { '@id'?: unknown };
		if (typeof obj['@id'] === 'string') {
			based_on_url = obj['@id'];
		}
	}

	return { name, description, version, author, tools, input_formats, output_formats, tags, verified: false, based_on_url };
}

/**
 * Strip the `{"success":true}` prefix some SSH commands prepend, and
 * split `{"a":1}{"b":2}` concatenations on the first `}{` so JSON parsers
 * see clean input. Mirrors `clean_content` in Rust.
 */
export function cleanContent(raw: string): string {
	const s = raw.trim();
	if (!s) {
		return s;
	}
	if (s.startsWith('{')) {
		const pos = s.indexOf('}{');
		if (pos !== -1) {
			const after = s.slice(pos + 1);
			if (after.startsWith('{')) {
				return after;
			}
		}
	}
	for (const prefix of ['{"success":true}', '{"success": true}', '{"success" : true}']) {
		if (s.startsWith(prefix)) {
			return s.slice(prefix.length).replace(/^\s+/, '');
		}
	}
	return s;
}

/**
 * Replace absolute host paths in YAML/Snakefile lines with the Docker
 * mount points (`/input`, `/output`). Conservative: only triggers on
 * keys containing 'input' or 'output' (excluding `*_format` keys).
 * Mirrors `normalize_paths` in Rust.
 */
export function normalizePaths(content: string): string {
	const lines = content.split('\n');
	const out: string[] = [];
	for (const line of lines) {
		out.push(normalizePathInLine(line));
	}
	let result = out.join('\n');
	if (!content.endsWith('\n') && result.endsWith('\n')) {
		result = result.slice(0, -1);
	}
	return result;
}

function normalizePathInLine(line: string): string {
	if (line.trimStart().startsWith('#')) {
		return line;
	}
	const colon = line.indexOf(':');
	if (colon < 0) {
		return line;
	}
	const key = line.slice(0, colon).trim().toLowerCase();
	const value = line.slice(colon + 1).trim();
	if (key.includes('input') && !key.includes('format')) {
		const p = extractAbsolutePath(value);
		if (p) {
			return line.replace(p, '/input');
		}
	}
	if (key.includes('output') && !key.includes('format')) {
		const p = extractAbsolutePath(value);
		if (p) {
			return line.replace(p, '/output');
		}
	}
	return line;
}

function extractAbsolutePath(value: string): string | null {
	let v = value.trim();
	v = v.replace(/^["']|["']$/g, '');
	if (v.startsWith('/') && v.length > 1
		&& !v.startsWith('/input')
		&& !v.startsWith('/output')
		&& !v.startsWith('/pipeline')) {
		return v;
	}
	return null;
}

/** Strip control characters that break shell command boundaries. */
export function shellEscape(s: string): string {
	const sanitised = [...s].filter(c => c !== '\0' && c !== '\n' && c !== '\r').join('');
	return sanitised.replace(/'/g, "'\\''");
}
