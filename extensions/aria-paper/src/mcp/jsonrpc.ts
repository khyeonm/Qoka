/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * JSON-RPC 2.0 types covering the subset MCP uses over HTTP+SSE and
 * Streamable HTTP. Mirrors the helper shipped alongside aria-notes /
 * aria-autopipe so all of Aria's MCP servers behave consistently.
 */

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id: number | string | null;
	method: string;
	params?: unknown;
}

export interface JsonRpcSuccess {
	jsonrpc: '2.0';
	id: number | string | null;
	result: unknown;
}

export interface JsonRpcError {
	jsonrpc: '2.0';
	id: number | string | null;
	error: {
		code: number;
		message: string;
		data?: unknown;
	};
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export const JsonRpcErrorCodes = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
} as const;

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const v = value as Record<string, unknown>;
	return v.jsonrpc === '2.0' && typeof v.method === 'string';
}

export function jsonRpcSuccess(id: JsonRpcRequest['id'], result: unknown): JsonRpcSuccess {
	return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): JsonRpcError {
	return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}
