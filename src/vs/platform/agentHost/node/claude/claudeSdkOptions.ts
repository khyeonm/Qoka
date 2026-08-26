/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpSdkServerConfigWithInstance, McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as os from 'os';
import { delimiter, dirname, join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { rgDiskPath } from '../../../../base/node/ripgrep.js';
import { ClaudePermissionMode } from '../../common/claudeSessionConfigKeys.js';
import { resolveClaudeEffort } from '../../common/claudeModelConfig.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import type { ModelSelection } from '../../common/state/protocol/state.js';
import { IClaudeAgentSdkService } from './claudeAgentSdkService.js';
import { buildClientToolMcpServer } from './clientTools/claudeClientToolMcpServer.js';
import { IClaudeProxyHandle } from './claudeProxyService.js';
import { SessionClientToolsDiff } from './clientTools/claudeSessionClientToolsModel.js';

/**
 * Inputs to {@link buildOptions} that vary per startup. Pure-data: no
 * services, no live event subscribers. The function is a deterministic
 * projection from this bag plus a {@link IClaudeProxyHandle} onto the
 * SDK's {@link Options} discriminated union.
 */
export interface IBuildOptionsInput {
	readonly sessionId: string;
	readonly workingDirectory: URI;
	readonly model: ModelSelection | undefined;
	readonly abortController: AbortController;
	readonly permissionMode: ClaudePermissionMode;
	readonly canUseTool: NonNullable<Options['canUseTool']>;
	readonly isResume: boolean;
	readonly mcpServers: Record<string, McpServerConfig> | undefined;
	/**
	 * Local plugin directories to load at SDK startup. Projected onto
	 * `Options.plugins` as `{ type: 'local', path }`. Omitted from the
	 * returned options entirely when empty so the SDK keeps its default
	 * (no plugins). Built per-session from
	 * {@link SessionClientCustomizationsDiff.consume}.
	 */
	readonly plugins?: readonly URI[];
	/**
	 * Resolved SDK agent name (matches a key in `Options.agents`, or an
	 * agent loaded from `~/.claude/agents/**`). Projected onto
	 * `Options.agent` — the SDK's `--agent` flag. The plugin URI captured
	 * at startup is the only path the SDK consults, so any `changeAgent`
	 * after materialize triggers a yield-restart through the rematerializer.
	 * Omit when no custom agent is selected (SDK default behavior).
	 */
	readonly agent?: string;
}

/**
 * Build the SDK {@link Options} bag for a Claude session startup.
 * Deterministic over its declared inputs plus three ambient reads:
 *   1. `process.env.PATH` (composed into `Options.settings.env.PATH`
 *      so ripgrep wins over any system install),
 *   2. `process.env` keys via {@link buildSubprocessEnv} (used to
 *      strip `VSCODE_*` / `ELECTRON_*` / `NODE_OPTIONS` /
 *      `ANTHROPIC_API_KEY` from the spawn env),
 *   3. the memoized `rgDiskPath()` lookup.
 * The returned options carry the caller-supplied `abortController` so a
 * racing dispose unwinds `sdk.startup()` cleanly.
 *
 * Used by both the initial materialize and the yield-restart rematerialize
 * — both call sites pass a freshly-built `mcpServers` snapshot consumed
 * from the session's {@link SessionClientToolsDiff}.
 */
/**
 * Appended to the Claude Code system-prompt preset so the agent routes ALL
 * long-term memory through Qoka's `aria-memory` MCP tools instead of the
 * built-in auto-memory (which we disable via `managedSettings.autoMemoryEnabled`).
 * Without this, the native memory habit wins and the agent never touches our
 * store — see the test where every "remember this" landed in ~/.claude.
 */
const ARIA_MEMORY_APPEND = [
	'## Qoka memory',
	'This workbench manages long-term memory through the `aria-memory` MCP tools. The built-in auto-memory is disabled — those tools are your only memory store, so never write memory into MEMORY.md or any ~/.claude path.',
	'There are two scopes, each with its own tools:',
	'- PROJECT memory (this project only): `remember_project_memory`, `search_project_memory`, `project_memory_index`. For this project\'s decisions, architecture, data locations, experiment results, and project-specific terms.',
	'- USER memory (cross-project): `remember_user_memory`, `recall_user_memory`. For facts about the user that stay true in ANY project — their preferences, working style, identity, favoured tools, and cross-cutting conventions.',
	'Routing test for saving a fact: "Would this still be true and useful in a completely different project?" Yes → user memory. No (only meaningful in this project) → project memory. When unsure, prefer project memory.',
	'Before answering something that may depend on what you know, recall first: `recall_user_memory` for the user, plus `search_project_memory` / `project_memory_index` for this project.',
	'When the user states something durable and non-obvious — a decision, a fact, a data location, a preference, or a correction — save it to the matching scope. Reuse an existing project page title to update rather than duplicate. Before `remember_user_memory`, `recall_user_memory` first and skip storing a fact you already have.',
	'Skip one-off task instructions, chit-chat, and anything already obvious from the code or git history. Only store what would still be useful in a later session.',
].join('\n');

export async function buildOptions(
	input: IBuildOptionsInput,
	proxyHandle: IClaudeProxyHandle,
	logStderr: (data: string) => void,
	logElicitation: (msg: string) => void,
): Promise<Options> {
	const subprocessEnv = buildSubprocessEnv();
	const resolvedRgDiskPath = await rgDiskPath();

	const settingsEnv: Record<string, string> = {
		ANTHROPIC_BASE_URL: proxyHandle.baseUrl,
		ANTHROPIC_AUTH_TOKEN: `${proxyHandle.nonce}.${input.sessionId}`,
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		USE_BUILTIN_RIPGREP: '0',
		PATH: `${dirname(resolvedRgDiskPath)}${delimiter}${process.env.PATH ?? ''}`,
	};

	return {
		cwd: input.workingDirectory.fsPath,
		executable: process.execPath as 'node',
		env: subprocessEnv,
		abortController: input.abortController,
		allowDangerouslySkipPermissions: true,
		canUseTool: input.canUseTool,
		onElicitation: async req => {
			logElicitation(req.message ?? '');
			return { action: 'cancel' };
		},
		disallowedTools: ['WebSearch'],
		includePartialMessages: true,
		forwardSubagentText: true,
		enableFileCheckpointing: true,
		model: input.model?.id,
		effort: resolveClaudeEffort(input.model),
		permissionMode: input.permissionMode,
		...(input.isResume
			? { resume: input.sessionId }
			: { sessionId: input.sessionId }),
		...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
		...(input.plugins && input.plugins.length > 0
			? { plugins: input.plugins.map(p => ({ type: 'local' as const, path: p.fsPath })) }
			: {}),
		...(input.agent ? { agent: input.agent } : {}),
		settingSources: ['user', 'project', 'local'],
		settings: { env: settingsEnv },
		// Turn off Claude's native auto-memory via the MANAGED (policy) layer, not
		// the flag layer. `settings.autoMemoryEnabled` sits in the user-controlled
		// "flag settings" tier, which the loaded settingSources override — it had
		// no effect in testing (native memory kept writing to ~/.claude).
		// `managedSettings` is the policy tier that user/project settings cannot
		// widen, and its doc names desktop-app embedding as the exact use case:
		// enforce config on the spawned subprocess without writing files. With
		// native memory off, the `aria-memory` MCP tools (steered by
		// ARIA_MEMORY_APPEND) become the sole memory store. Applies to every Qoka
		// session; writes no files and does not affect the user's own `claude` CLI.
		managedSettings: { autoMemoryEnabled: false },
		systemPrompt: { type: 'preset', preset: 'claude_code', append: ARIA_MEMORY_APPEND },
		stderr: logStderr,
	};
}

/** Match mcpConfig.claudeProjectKey: forward slashes + lowercase drive letter so
 *  the key we look up equals the one the extension WROTE for this window. */
function claudeProjectKey(p: string): string {
	return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
}

/**
 * Read THIS session's Qoka MCP servers straight from
 * `<CLAUDE_CONFIG_DIR>/.claude.json` -> `projects[<cwd>].mcpServers` and return
 * them as SDK sse configs, to INJECT explicitly into `Options.mcpServers`.
 *
 * Why not just let the SDK's own `settingSources: ['local', …]` scan find them?
 * The agent host is ONE shared process running every window's chat session; that
 * per-process SDK scan did not reliably re-resolve the per-session cwd, so only
 * the FIRST window's chat connected and the rest opened with "MCP not connected"
 * (or routed a tool into the wrong window). A direct, cwd-keyed file read here is
 * deterministic per session, so each window connects to ITS OWN servers. Returns
 * `{}` on any failure (missing file, no block) so injection is best-effort.
 */
export function readWorkspaceQokaMcpServers(workspaceFsPath: string | undefined): Record<string, McpServerConfig> {
	const out: Record<string, McpServerConfig> = {};
	if (!workspaceFsPath) { return out; }
	try {
		const dir = process.env['CLAUDE_CONFIG_DIR'] || join(os.homedir(), '.qoka', 'claude');
		const obj = JSON.parse(fs.readFileSync(join(dir, '.claude.json'), 'utf8')) as {
			projects?: Record<string, { mcpServers?: Record<string, { type?: string; url?: string }> }>;
		};
		const servers = obj.projects?.[claudeProjectKey(workspaceFsPath)]?.mcpServers ?? {};
		for (const [name, cfg] of Object.entries(servers)) {
			if (cfg && cfg.type === 'sse' && typeof cfg.url === 'string') {
				out[name] = { type: 'sse', url: cfg.url };
			}
		}
	} catch { /* best-effort: leave empty */ }
	return out;
}

/**
 * Consume the diff (clears its dirty bit) and build the in-process MCP
 * server config from the resulting tool snapshot. Resolves to
 * `undefined` when the snapshot is empty so `Options.mcpServers` is
 * omitted entirely and the SDK keeps its default.
 *
 * On builder throw the caller is responsible for re-marking the diff
 * dirty (the diff has already been consumed). See
 * {@link SessionClientToolsDiff.markDirty}.
 */
export async function buildClientMcpServers(
	toolDiff: SessionClientToolsDiff,
	registry: PendingRequestRegistry<CallToolResult>,
	sdkService: IClaudeAgentSdkService,
): Promise<Record<string, McpSdkServerConfigWithInstance> | undefined> {
	const { tools } = toolDiff.consume();
	if (!tools || tools.length === 0) {
		return undefined;
	}
	const server = await buildClientToolMcpServer(tools, id => registry.register(id), sdkService);
	return { client: server };
}

/**
 * Build the {@link Options.env} payload for the Claude subprocess.
 *
 * The agent host runs in an Electron utility process; the spawn env
 * inherits the parent's env which contains `NODE_OPTIONS`,
 * `ELECTRON_*`, and `VSCODE_*` variables that break the Claude
 * subprocess (it's a plain Node script driven by Electron's
 * `process.execPath` + `ELECTRON_RUN_AS_NODE`). Strip them via
 * {@link Options.env} `undefined` semantics (sdk.d.ts:1075-1078:
 * "Set a key to `undefined` to remove an inherited variable").
 *
 * Mirror of CopilotAgent's strip pattern at copilotAgent.ts:434-450.
 *
 * Exported for unit testing as a pure function over `process.env`.
 */
export function buildSubprocessEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		ELECTRON_RUN_AS_NODE: '1',
		NODE_OPTIONS: undefined,
		ANTHROPIC_API_KEY: undefined,
	};
	for (const key of Object.keys(process.env)) {
		if (key === 'ELECTRON_RUN_AS_NODE') { continue; }
		if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_')) {
			env[key] = undefined;
		}
	}
	return env;
}
