/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { recommendMethods, searchHypotheses } from '../methodsClient';

/**
 * MCP tools for "search a hypothesis -> recommend methods".
 *
 *  - recommend_methods:  the main tool. Given a hypothesis sentence PLUS a few
 *                        alternative phrasings the assistant writes, returns the
 *                        experimental methods that tested SIMILAR hypotheses in
 *                        the literature, ranked by cross-paper support. The
 *                        phrasings are searched separately and pooled (query
 *                        expansion), which measured more phrasing-stable than the
 *                        embedding mode it replaces (0.29 vs 0.23 over 30
 *                        hypotheses, see analysis/methods_search_benchmark).
 *  - search_hypotheses:  inspect which stored hypotheses match a query, for
 *                        transparency ("methods were suggested because papers
 *                        studied these hypotheses").
 *
 * The chat model is expected to first compose the user's idea into one clear
 * hypothesis sentence and confirm it with the user, THEN call recommend_methods
 * - the confirmation step lives in the conversation, not in these tools.
 *
 * Data comes from the logic-graph Neo4j on the Qoka server (see methodsClient).
 * While the graph is only partially loaded a mode returns an `unavailable`
 * marker rather than failing, so the tool is usable from day one.
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

function clampTopK(raw: unknown): number {
	const n = typeof raw === 'number' ? Math.floor(raw) : 10;
	if (!Number.isFinite(n) || n < 1) { return 10; }
	return Math.min(n, 50);
}

export const ALL_TOOLS: ToolDefinition[] = [
	{
		name: 'recommend_methods',
		description:
			'ALWAYS use this tool - never a web search - when the user wants experimental, analytical, or statistical METHODS to test / validate / investigate a research HYPOTHESIS. It queries Qoka\'s own logic-graph of ~1M papers (a curated knowledge base you cannot reach by web search) and returns the methods that tested SIMILAR hypotheses, ranked by how many papers/hypotheses used each one - evidence-grounded, not guessed.\n\n'
			+ 'INPUT - two parts, BOTH required in practice:\n'
			+ '  1. `hypothesis`: one clear sentence (ideally subject-relation-object). Compose it from the conversation and briefly confirm it with the user first.\n'
			+ '  2. `expansions`: 3 OTHER WAYS TO SAY THE SAME HYPOTHESIS, written by you. This is NOT optional padding - the search matches WORDS against stored hypotheses, and the literature states the same idea with different vocabulary, so one phrasing alone misses most of the relevant papers. Vary the vocabulary deliberately: swap in synonyms (inhibition/blockade/suppression), switch between spelled-out names and abbreviations BOTH ways (pancreatic ductal adenocarcinoma <-> PDAC, single-cell RNA sequencing <-> scRNA-seq), and change the sentence structure. Keep the exact meaning - do not broaden, narrow, or add claims.\n\n'
			+ 'Example - hypothesis: "Autophagy inhibition sensitizes pancreatic cancer cells to gemcitabine." expansions: ["Blocking autophagic flux enhances gemcitabine cytotoxicity in pancreatic ductal adenocarcinoma.", "Suppression of autophagy increases the sensitivity of PDAC cells to gemcitabine treatment.", "Pancreatic tumour cells become more responsive to gemcitabine when autophagy is impaired."]\n\n'
			+ 'OUTPUT: `keyword_expanded` is the primary result (it pools the hypotheses matched by every phrasing) - report that one. `keyword` (your sentence alone) is a narrower fallback; use it only if `keyword_expanded` is missing. Each method has {method, type, paper_support, hypothesis_support}; higher support means more independent papers used it. A list may instead report `unavailable` while the graph is being rebuilt - say so plainly rather than inventing methods. If the results look generic (Western blot, flow cytometry...), that means the corpus has little specific support for this hypothesis; tell the user rather than presenting them as targeted recommendations.',
		inputSchema: {
			type: 'object',
			required: ['hypothesis'],
			properties: {
				hypothesis: { type: 'string', description: 'The hypothesis to search, as one clear sentence.' },
				expansions: {
					type: 'array',
					description: 'THREE other phrasings of the SAME hypothesis that you write (synonyms, abbreviation <-> full name in both directions, different sentence structure). Each is searched separately and the matches are pooled, which is what makes the result robust to how the user happened to word it. Omitting this searches your one sentence only and misses most relevant papers.',
					items: { type: 'string' },
				},
				top_k: { type: 'integer', description: 'Max methods per mode (default 10, max 50).' },
			},
		},
		handler: async (args) => {
			const hypothesis = typeof args.hypothesis === 'string' ? args.hypothesis.trim() : '';
			if (!hypothesis) {
				return errorResult('recommend_methods requires a non-empty `hypothesis`.');
			}
			const expansions = Array.isArray(args.expansions)
				? args.expansions.map(e => String(e).trim()).filter(e => e && e !== hypothesis).slice(0, 5)
				: [];
			try {
				const rec = await recommendMethods(hypothesis, clampTopK(args.top_k), expansions);
				const payload = expansions.length === 0
					// No expansions: the result is the narrow single-phrasing search. Say so in the
					// payload so the model asks itself for phrasings next time instead of presenting
					// a thin list as authoritative.
					? { ...rec, note: 'Searched ONE phrasing only because `expansions` was empty. Relevant papers that word the hypothesis differently were missed. Call recommend_methods again with 3 alternative phrasings in `expansions`.' }
					: rec;
				return textResult(JSON.stringify(payload, null, 2));
			} catch (err) {
				return errorResult(`Could not recommend methods: ${(err as Error).message}`);
			}
		},
	},
	{
		name: 'search_hypotheses',
		description:
			'Inspect which stored hypotheses in the logic-graph match a query (full-text). Use for transparency - to show the user the actual hypotheses behind a method recommendation, or to check coverage. Returns {hypothesis, example_pmcid, score} rows.',
		inputSchema: {
			type: 'object',
			required: ['query'],
			properties: {
				query: { type: 'string', description: 'Text to match against stored hypotheses.' },
				limit: { type: 'integer', description: 'Max hypotheses to return (default 10, max 50).' },
			},
		},
		handler: async (args) => {
			const query = typeof args.query === 'string' ? args.query.trim() : '';
			if (!query) {
				return errorResult('search_hypotheses requires a non-empty `query`.');
			}
			try {
				const matches = await searchHypotheses(query, clampTopK(args.limit));
				if (matches.length === 0) {
					return textResult('No stored hypotheses match that query yet.');
				}
				return textResult(JSON.stringify(matches, null, 2));
			} catch (err) {
				return errorResult(`Could not search hypotheses: ${(err as Error).message}`);
			}
		},
	},
];

export function findTool(name: string): ToolDefinition | undefined {
	return ALL_TOOLS.find(t => t.name === name);
}
