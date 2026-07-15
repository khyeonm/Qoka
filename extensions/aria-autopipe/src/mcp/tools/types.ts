/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One MCP tool: description that the AI assistant sees, a JSON Schema for
 * its arguments, and an async handler that produces a CallToolResult-shaped
 * payload (matching the MCP spec).
 */
export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: JsonSchemaObject;
	handler: ToolHandler;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

export interface CallToolResult {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
}

/**
 * Loose JSON-Schema-ish type. MCP accepts any JSON Schema, but in practice
 * every autopipe tool's schema is an object with named properties - we
 * encode that constraint at the type level.
 */
export interface JsonSchemaObject {
	type: 'object';
	properties: Record<string, JsonSchemaProp>;
	required?: string[];
	additionalProperties?: boolean;
}

export type JsonSchemaProp =
	| { type: 'string'; description?: string; enum?: readonly string[] }
	| { type: 'integer'; description?: string }
	| { type: 'number'; description?: string }
	| { type: 'boolean'; description?: string }
	| { type: 'array'; description?: string; items: JsonSchemaProp }
	| { type: 'object'; description?: string; properties?: Record<string, JsonSchemaProp> }
	// `nullable` represents Rust's `Option<T>` - the Open API style is what
	// autopipe-app's rmcp emits, so we match it.
	| { type: 'string'; description?: string; nullable: true };

/**
 * Build a CallToolResult with one text block. Most tool stubs return a
 * single explanatory message rather than structured JSON during Phase 3.
 */
export function textResult(text: string): CallToolResult {
	return { content: [{ type: 'text', text }] };
}

/**
 * Build a CallToolResult marked as an error. The AI assistant will see this
 * and treat it as a failed call - same shape as `textResult` plus the
 * `isError` flag.
 */
export function errorResult(text: string): CallToolResult {
	return { content: [{ type: 'text', text }], isError: true };
}
