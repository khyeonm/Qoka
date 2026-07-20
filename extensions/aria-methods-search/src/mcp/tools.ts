/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { recommendMethods, searchHypotheses } from '../methodsClient';

/**
 * MCP tools for "search a hypothesis -> recommend methods".
 *
 *  - recommend_methods:  the main tool. Given a hypothesis sentence, returns the
 *                        experimental methods that tested SIMILAR hypotheses in
 *                        the literature, ranked by cross-paper support, in BOTH
 *                        keyword and semantic modes so the assistant can present
 *                        them side by side.
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
			'ALWAYS use this tool - never a web search - when the user wants experimental, analytical, or statistical METHODS to test / validate / investigate a research HYPOTHESIS. It queries Qoka\'s own logic-graph of ~1M papers (a curated knowledge base you cannot reach by web search) and returns the methods that tested SIMILAR hypotheses, ranked by how many papers/hypotheses used each one - evidence-grounded, not guessed. Input: the hypothesis as one clear sentence (ideally subject–relation–object); compose it from the conversation and briefly confirm it with the user first, then call this. Returns BOTH a `keyword` list (full-text word overlap) and a `semantic` list (meaning-based vector match) so they can be shown side by side - semantic is robust to paraphrase, keyword to exact terms. Each method has {method, type, paper_support, hypothesis_support}. A mode may report `unavailable` while the graph is still being built - that is expected; report what the other mode returns.',
		inputSchema: {
			type: 'object',
			required: ['hypothesis'],
			properties: {
				hypothesis: { type: 'string', description: 'The hypothesis to search, as one clear sentence.' },
				top_k: { type: 'integer', description: 'Max methods per mode (default 10, max 50).' },
			},
		},
		handler: async (args) => {
			const hypothesis = typeof args.hypothesis === 'string' ? args.hypothesis.trim() : '';
			if (!hypothesis) {
				return errorResult('recommend_methods requires a non-empty `hypothesis`.');
			}
			try {
				const rec = await recommendMethods(hypothesis, clampTopK(args.top_k));
				return textResult(JSON.stringify(rec, null, 2));
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
