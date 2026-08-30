/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Spawn a provider CLI (Claude/Codex) headlessly as a loop SUB-AGENT, with run_code wired in
// via --mcp-config. Mirrors aria-skills/headlessCli.ts's isolated-CLI resolution (~/.qoka) but
// stays vscode-free (so it can be unit-tested) and adds the --mcp-config the sub-agent needs to
// reach the run environment. See loop_engine_design.md sections 4 and 9.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

export type Provider = 'claude' | 'codex';

const isWin = process.platform === 'win32';
const HOME = os.homedir();
const QOKA_HOME = path.join(HOME, '.qoka');
const QOKA_NODE_DIR = path.join(QOKA_HOME, 'node');
const QOKA_NPM_PREFIX = path.join(QOKA_HOME, 'npm');
const QOKA_BIN_DIR = path.join(QOKA_HOME, 'bin');
const QOKA_CODEX_HOME = path.join(QOKA_HOME, 'codex');
const QOKA_CLAUDE_CONFIG_DIR = path.join(QOKA_HOME, 'claude');

function providerDirs(): string[] {
	if (isWin) {
		return [QOKA_BIN_DIR, QOKA_NODE_DIR, QOKA_NPM_PREFIX];
	}
	return [QOKA_BIN_DIR, path.join(QOKA_NPM_PREFIX, 'bin'), path.join(QOKA_NODE_DIR, 'bin')];
}

function binNames(provider: Provider): string[] {
	return isWin ? [`${provider}.cmd`, `${provider}.exe`, `${provider}.bat`, provider] : [provider];
}

/** Resolve the Qoka-installed provider binary, or undefined if it is not present. Only the
 *  isolated ~/.qoka locations are searched (never a system CLI on PATH). */
export function resolveProviderBin(provider: Provider): string | undefined {
	for (const dir of providerDirs()) {
		for (const name of binNames(provider)) {
			const full = path.join(dir, name);
			try { if (fs.existsSync(full)) { return full; } } catch { /* keep looking */ }
		}
	}
	return undefined;
}

function qokaNodeBinDir(): string | undefined {
	const dir = isWin ? QOKA_NODE_DIR : path.join(QOKA_NODE_DIR, 'bin');
	try { return fs.existsSync(dir) ? dir : undefined; } catch { return undefined; }
}

/** Child env: the isolated Qoka config dirs (so the sub-agent shares the chat's login) plus the
 *  portable Node on PATH (so an npm-installed codex finds `node` for its shebang). `codexHome`
 *  overrides CODEX_HOME so a Codex sub-agent can run against a per-loop config listing only the
 *  curated work servers (see setupCodexHome). */
function childEnv(codexHome?: string): NodeJS.ProcessEnv {
	const nodeBin = qokaNodeBinDir();
	const pathParts = [nodeBin, ...providerDirs(), process.env.PATH].filter(Boolean) as string[];
	return {
		...process.env,
		PATH: pathParts.join(path.delimiter),
		CLAUDE_CONFIG_DIR: QOKA_CLAUDE_CONFIG_DIR,
		CODEX_HOME: codexHome ?? QOKA_CODEX_HOME,
	};
}

/**
 * Build a per-loop CODEX_HOME so a Codex sub-agent sees ONLY the curated work servers (via Codex's
 * Streamable-HTTP /mcp transport), never the global config that also has the loop-control server
 * (no recursion). Writes a minimal config.toml + copies the real auth.json so the login is shared.
 * Returns the home dir, or undefined if it could not be created (the sub-agent then falls back to
 * the global CODEX_HOME). Codex has no per-invocation --mcp-config, so this env swap is the way in.
 */
export function setupCodexHome(dir: string, servers: Record<string, { port: number }>): string | undefined {
	try {
		fs.mkdirSync(dir, { recursive: true });
		try { fs.copyFileSync(path.join(QOKA_CODEX_HOME, 'auth.json'), path.join(dir, 'auth.json')); } catch { /* login may be elsewhere */ }
		let toml = '';
		for (const [name, s] of Object.entries(servers)) {
			toml += `[mcp_servers.${name}]\nurl = "http://127.0.0.1:${s.port}/mcp"\n\n`;
		}
		fs.writeFileSync(path.join(dir, 'config.toml'), toml);
		return dir;
	} catch {
		return undefined;
	}
}

/** Claude --mcp-config file: point the sub-agent at the given MCP servers (run_code etc.). */
export function writeMcpConfig(configPath: string, servers: Record<string, { url: string }>): void {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	const mcpServers: Record<string, unknown> = {};
	for (const [name, s] of Object.entries(servers)) {
		mcpServers[name] = { type: 'sse', url: s.url };
	}
	fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));
}

export interface AgentRunResult {
	output: string;
	exitCode: number | null;
	stderr: string;
	/** Auth/quota/CLI-down - the engine pauses instead of counting a failure. */
	envError?: boolean;
	error?: string;
	/** The literal RAW run_code source the sub-agent executed this turn (clean code, ready to save
	 *  as a source file) - undefined when the stream did not yield it (e.g. Codex). */
	code?: string;
	/** Language of `code` (python/node/...), for choosing the saved file's extension. */
	codeLanguage?: string;
	/** Total tokens this turn (input + output), from the stream-json result usage. */
	tokens?: number;
}

const ENV_ERROR_RE = /(not logged in|please log ?in|authentication|unauthorized|invalid api key|quota|rate.?limit|429|credit balance)/i;

/**
 * Parse Claude's `--output-format stream-json` NDJSON into: the final narration text, the RAW
 * run_code SOURCE the sub-agent executed (clean code, ready to save as a .py/.js/.sh file), the
 * language of that source, and the turn's total token usage. Non-run_code tool calls are noted in
 * the text (not the code). Best-effort and never throws - a malformed line is skipped.
 */
export function parseClaudeStream(stdout: string): { text: string; code: string; language: string; tokens: number } {
	const texts: string[] = [];
	const codeParts: string[] = [];
	const otherTools: string[] = [];
	let language = '';
	let tokens = 0;
	for (const raw of stdout.split('\n')) {
		const line = raw.trim();
		if (!line) { continue; }
		let obj: Record<string, unknown>;
		try { obj = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
		const msg = (obj.message ?? obj) as Record<string, unknown>;
		const content = msg?.content;
		if (Array.isArray(content)) {
			for (const b of content as Array<Record<string, unknown>>) {
				if (b?.type === 'text' && typeof b.text === 'string') {
					texts.push(b.text);
				} else if (b?.type === 'tool_use') {
					const name = String(b.name ?? 'tool');
					const input = (b.input ?? {}) as Record<string, unknown>;
					if (/run_code/i.test(name) && typeof input.code === 'string') {
						if (!language && typeof input.language === 'string') { language = input.language; }
						codeParts.push(input.code);
					} else {
						otherTools.push(name.replace(/^mcp__/, ''));
					}
				}
			}
		}
		const usage = (msg?.usage ?? obj?.usage) as Record<string, unknown> | undefined;
		if (usage) {
			const it = Number(usage.input_tokens ?? 0) || 0;
			const ot = Number(usage.output_tokens ?? 0) || 0;
			tokens = Math.max(tokens, it + ot);
		}
		if (obj?.type === 'result' && typeof obj.result === 'string' && obj.result.trim()) {
			texts.push(obj.result);
		}
	}
	if (otherTools.length) { texts.push(`\n[tools used: ${[...new Set(otherTools)].join(', ')}]`); }
	const sep = language === 'python' ? '\n\n# --- next run_code call ---\n\n' : '\n\n// --- next run_code call ---\n\n';
	return { text: texts.join('\n').trim(), code: codeParts.join(sep), language, tokens };
}

/**
 * Run one sub-agent turn. Feeds `prompt` on stdin, wires run_code via --mcp-config (Claude),
 * runs autonomously (skips the interactive tool-permission prompt), and returns the transcript.
 * A missing CLI or an auth/quota signature is reported as envError so the loop pauses.
 */
export function runAgent(
	provider: Provider,
	prompt: string,
	opts: { cwd: string; mcpConfigPath?: string; codexHome?: string; timeoutMs?: number },
): Promise<AgentRunResult> {
	const bin = resolveProviderBin(provider);
	if (!bin) {
		return Promise.resolve({ output: '', exitCode: null, stderr: '', envError: true, error: `${provider} CLI not found under ~/.qoka` });
	}
	const args = provider === 'claude'
		? ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
			...(opts.mcpConfigPath ? ['--mcp-config', opts.mcpConfigPath, '--strict-mcp-config'] : [])]
		: ['exec', '--skip-git-repo-check', '-'];
	const timeoutMs = opts.timeoutMs ?? 10 * 60_000;

	return new Promise((resolve) => {
		const child = spawn(bin, args, { cwd: opts.cwd, env: childEnv(opts.codexHome), stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let done = false;
		const finish = (r: AgentRunResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
		const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ output: stdout, exitCode: null, stderr, error: `timed out after ${timeoutMs}ms` }); }, timeoutMs);
		child.stdout.on('data', d => { stdout += d.toString(); });
		child.stderr.on('data', d => { stderr += d.toString(); });
		child.on('error', err => finish({ output: '', exitCode: null, stderr, envError: true, error: err.message }));
		child.on('close', code => {
			const envError = code !== 0 && ENV_ERROR_RE.test(stderr);
			if (provider === 'claude') {
				// Parse the stream-json for the narration text, the executed code, and token usage.
				// Fall back to the raw stdout if parsing yielded nothing (unexpected format).
				const parsed = parseClaudeStream(stdout);
				finish({ output: parsed.text || stdout, exitCode: code, stderr, envError, code: parsed.code || undefined, codeLanguage: parsed.language || undefined, tokens: parsed.tokens || undefined });
			} else {
				finish({ output: stdout, exitCode: code, stderr, envError });
			}
		});
		child.stdin.on('error', () => { /* CLI exited before reading stdin */ });
		child.stdin.write(prompt);
		child.stdin.end();
	});
}
