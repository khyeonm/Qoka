/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Pipeline } from '../common/types';

export interface HubPlugin {
	plugin_id: number;
	name: string;
	description: string;
	category: string;
	extensions: string[];
	tags: string[];
	github_url: string;
	author: string;
	version: string;
	verified: boolean;
	forked_from?: number | null;
	version_history?: Array<{ version: string; github_url: string; updated_at: string }>;
	created_at?: string | null;
}

/**
 * Minimal HTTP client for Autopipe Hub (hub.autopipe.org by default). Aria
 * uses Node's built-in `fetch` (Node 18+) so this stays dependency-free.
 *
 * The endpoints mirror autopipe-app's `crates/common/src/api_client.rs`.
 */
export class HubApiClient {

	constructor(private readonly baseUrl: string) {}

	async listPipelines(): Promise<Pipeline[]> {
		return this.getJson<Pipeline[]>('/api/pipelines');
	}

	async searchPipelines(query: string): Promise<Pipeline[]> {
		// Hub treats `/api/pipelines/{anything}` as an ID lookup, so the
		// search isn't a sub-route — it's the same `/api/pipelines`
		// endpoint with a `?q=` query parameter. The 400 we saw earlier
		// came from the server parsing "search" as a pipeline ID.
		const url = `/api/pipelines?q=${encodeURIComponent(query)}`;
		return this.getJson<Pipeline[]>(url);
	}

	async getPipeline(pipelineId: number): Promise<Pipeline> {
		return this.getJson<Pipeline>(`/api/pipelines/${pipelineId}`);
	}

	async publishPipeline(payload: {
		github_url: string;
		forked_from?: number | null;
	}): Promise<Pipeline> {
		return this.postJson<Pipeline>('/api/pipelines', payload);
	}

	async unpublishPipeline(pipelineId: number, scope?: 'latest' | 'all'): Promise<{ removed: number }> {
		const path = `/api/pipelines/${pipelineId}` + (scope ? `?scope=${scope}` : '');
		return this.deleteJson<{ removed: number }>(path);
	}

	async listPlugins(): Promise<HubPlugin[]> {
		return this.getJson<HubPlugin[]>('/api/plugins');
	}

	async getPluginByName(name: string): Promise<HubPlugin | null> {
		// Hub doesn't expose a name lookup directly, so we list and filter
		// client-side. This call is cached at the panel level so the
		// extra cost is one HTTP request per panel refresh.
		const all = await this.listPlugins();
		return all.find(p => p.name === name) ?? null;
	}

	private async getJson<T>(path: string): Promise<T> {
		const res = await fetch(this.baseUrl + path);
		await this.assertOk(res, `GET ${path}`);
		return await res.json() as T;
	}

	private async postJson<T>(path: string, body: unknown): Promise<T> {
		const res = await fetch(this.baseUrl + path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		await this.assertOk(res, `POST ${path}`);
		return await res.json() as T;
	}

	private async deleteJson<T>(path: string): Promise<T> {
		const res = await fetch(this.baseUrl + path, { method: 'DELETE' });
		await this.assertOk(res, `DELETE ${path}`);
		return await res.json() as T;
	}

	private async assertOk(res: Response, what: string): Promise<void> {
		if (res.ok) {
			return;
		}
		// Hub error responses are JSON with a `message` field — fall back to
		// status text when parsing fails.
		let body = '';
		try { body = await res.text(); } catch { /* ignore */ }
		throw new Error(`Hub ${what} → ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
	}
}
