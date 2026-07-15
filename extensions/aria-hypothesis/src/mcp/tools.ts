/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { searchHypothesis, getFulltext } from '../client';

/**
 * Two MCP tools the hypothesis-search server exposes:
 *
 *  - search_hypothesis:        grep the local corpus for papers that may contain a
 *                              hypothesis, returning candidate papers + context
 *                              windows. The CALLER (the chat model) does keyword
 *                              extraction before, and verdict/method judgment after
 *                              - this tool is only the deterministic grep step.
 *  - get_hypothesis_fulltext:  pull one candidate's full packed content for a wider
 *                              read when the context windows are insufficient to judge.
 */

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: JsonSchemaObject;
	handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface CallToolResult {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
}

interface JsonSchemaObject {
	type: 'object';
	properties: Record<string, JsonSchemaProp>;
	required?: string[];
	additionalProperties?: boolean;
}

type JsonSchemaProp =
	| { type: 'string'; description?: string }
	| { type: 'integer'; description?: string }
	| { type: 'number'; description?: string }
	| { type: 'array'; description?: string; items: JsonSchemaProp }
	| { type: 'object'; description?: string; properties?: Record<string, JsonSchemaProp> };

function textResult(text: string): CallToolResult {
	return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): CallToolResult {
	return { content: [{ type: 'text', text }], isError: true };
}

export const ALL_TOOLS: ToolDefinition[] = [
	{
		name: 'search_hypothesis',
		description:
			'Search the local research corpus (~1M PMC open-access research articles, 2023-2026, reviews/protocols already excluded) for papers that may actually contain or test a given hypothesis, and see the methods each used. This is a deterministic literal-substring grep - YOU do the reasoning around it:\n\n' +
			'STEP 1 (before calling) - extract keywords from the hypothesis:\n' +
			'  • `primary`: the single most specific / rarest term - a gene, protein, molecule, drug, disease, or cell type. It anchors the AND. NEVER use a generic word (cell, cancer, expression, study).\n' +
			'  • `kw`: 1-3 other defining terms - the phenotype/outcome, the mechanism/process, and/or the model system.\n' +
			'  • Matching is literal, case-insensitive SUBSTRING. Use the spelling most likely to appear verbatim; prefer a shared stem when a word has variants (e.g. "autophag" matches autophagy/autophagic, "phosphoryl" matches phosphorylation). Mind hyphen-vs-space.\n' +
			'  • Keep 2-4 keywords total. Tighter AND = fewer, more precise candidates; the server auto-falls back AND -> OR -> primary-only if AND is empty.\n\n' +
			'STEP 2 (after calling) - judge each candidate from its `context` windows: co-occurrence of keywords does NOT mean the hypothesis is present, so be strict. Classify match / partial / no, and for match/partial extract the concrete experimental methods used. If a context window is insufficient, call get_hypothesis_fulltext for that pmcid.\n\n' +
			'Returns { match_mode, n, results: [{ pmcid, title, year, journal, context[] }] }. `match_mode` is which tier matched (AND / OR-fallback / primary-only).',
		inputSchema: {
			type: 'object',
			required: ['primary'],
			properties: {
				primary: { type: 'string', description: 'The single most specific/rarest anchoring term (gene, protein, molecule, drug, disease, or cell type). Not a generic word.' },
				kw: { type: 'array', items: { type: 'string' }, description: '1-3 other defining terms (phenotype/outcome, mechanism, model system). Use shared stems for variant words.' },
				topn: { type: 'integer', description: 'Max candidates to return (default 10, capped at 20). Fewer = faster to read.' },
			},
		},
		handler: async (args) => {
			const primary = typeof args.primary === 'string' ? args.primary.trim() : '';
			if (!primary) {
				return errorResult('`primary` is required - the most specific/rarest anchoring keyword from the hypothesis.');
			}
			const kw = Array.isArray(args.kw)
				? args.kw.map(k => String(k).trim()).filter(Boolean)
				: [];
			const topn = typeof args.topn === 'number' && Number.isFinite(args.topn)
				? Math.max(1, Math.min(Math.trunc(args.topn), 20))
				: 10;
			try {
				const res = await searchHypothesis(primary, kw, topn);
				return textResult(JSON.stringify(res));
			} catch (err) {
				return errorResult(`hypothesis search failed: ${(err as Error).message}`);
			}
		},
	},
	{
		name: 'get_hypothesis_fulltext',
		description:
			'Fetch one corpus paper\'s full packed content (abstract + body, references and XML already removed) by PMCID, for a wider read when search_hypothesis context windows are not enough to judge whether the hypothesis is present or to extract methods. Returns { pmcid, content }.',
		inputSchema: {
			type: 'object',
			required: ['pmcid'],
			properties: {
				pmcid: { type: 'string', description: 'The paper\'s PMCID, e.g. "PMC10115976".' },
			},
		},
		handler: async (args) => {
			const pmcid = typeof args.pmcid === 'string' ? args.pmcid.trim() : '';
			if (!/^PMC\d+$/.test(pmcid)) {
				return errorResult('`pmcid` must look like "PMC10115976".');
			}
			try {
				const res = await getFulltext(pmcid);
				return textResult(JSON.stringify(res));
			} catch (err) {
				return errorResult(`fulltext fetch failed: ${(err as Error).message}`);
			}
		},
	},
];

export function findTool(name: string): ToolDefinition | undefined {
	return ALL_TOOLS.find(t => t.name === name);
}
