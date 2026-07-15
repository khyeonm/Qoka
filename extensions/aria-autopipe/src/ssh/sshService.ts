/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Client, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import { SshProfile } from '../common/types';

/**
 * SSH access via the pure-JS `ssh2` library - NO external `ssh`/`sshpass`
 * process and no dependency on the system OpenSSH. This mirrors how the
 * reference autopipe backend works (its Rust `ssh2` crate over libssh2): the
 * library performs the TCP connection and password/key authentication itself,
 * so it behaves identically on Windows, macOS and Linux with nothing to
 * install. It also sidesteps the Electron-vs-system libssl ABI clash that made
 * shelling out to `ssh` fragile.
 *
 * Each call opens a short-lived connection (connect → exec → disconnect),
 * matching the previous spawn-per-command model; a persistent pool can be
 * layered on later if latency matters.
 */
export interface SshResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface RunOptions {
	timeoutMs?: number;
	stdin?: string;
}

const DEFAULT_TIMEOUT_MS = 20000;

export class SshService {

	async run(profile: SshProfile, command: string, opts: RunOptions = {}): Promise<SshResult> {
		const { stdout, stderr, exitCode } = await this.execRaw(profile, command, opts);
		return { stdout: stripSuccessPrefix(stdout.toString('utf8')), stderr, exitCode };
	}

	async testConnection(profile: SshProfile): Promise<{ ok: boolean; message: string }> {
		try {
			const { stdout, stderr, exitCode } = await this.run(profile, 'echo aria-ssh-ok', { timeoutMs: 15000 });
			if (exitCode === 0 && stdout.includes('aria-ssh-ok')) {
				return { ok: true, message: 'Connected.' };
			}
			return { ok: false, message: `Exit ${exitCode}: ${stderr.trim() || stdout.trim()}` };
		} catch (err) {
			return { ok: false, message: (err as Error).message };
		}
	}

	/** Quick reachability probe used while the built-in VM is booting. */
	async canConnect(profile: SshProfile, timeoutMs = 5000): Promise<boolean> {
		try {
			const { exitCode } = await this.run(profile, 'true', { timeoutMs });
			return exitCode === 0;
		} catch {
			return false;
		}
	}

	async readFile(profile: SshProfile, remotePath: string): Promise<Buffer> {
		// Binary-safe read: the SSH channel is 8-bit clean, so we collect the
		// exec stdout as raw Buffers (no decode) and callers handling binary
		// files (BAM, images, PDFs) get the exact bytes.
		const { stdout, stderr, exitCode } = await this.execRaw(profile, `cat -- ${shellQuote(remotePath)}`, {});
		if (exitCode !== 0) {
			throw new Error(`read_file failed (exit ${exitCode}): ${stderr.trim()}`);
		}
		// Same spurious `{"success":true}` banner some remotes prepend to command
		// output (see stripSuccessPrefix) - on a BINARY read it corrupts the file
		// (e.g. a PNG gets 16 junk bytes before its \x89PNG magic → "error loading
		// image"). Strip the exact literal from the buffer head; a real binary file
		// never starts with those bytes, so this is safe.
		return stripSuccessPrefixBytes(stdout);
	}

	async writeFile(profile: SshProfile, remotePath: string, content: string): Promise<void> {
		// autopipe-app routes writes through base64 to dodge any shell
		// interpretation of binary/control characters in `content`. The
		// equivalent: `echo '<b64>' | base64 -d > '<path>'`.
		const parent = remotePath.replace(/\/+[^/]*$/, '');
		const encoded = Buffer.from(content, 'utf8').toString('base64');
		const cmd = `mkdir -p ${shellQuote(parent)} && echo '${encoded}' | base64 -d > ${shellQuote(remotePath)}`;
		const { stderr, exitCode } = await this.run(profile, cmd);
		if (exitCode !== 0) {
			throw new Error(`write_file failed (exit ${exitCode}): ${stderr.trim()}`);
		}
	}

	/**
	 * Download a remote file by base64-encoding it on the server and
	 * decoding locally. Matches autopipe-app's `ssh_download_base64`:
	 * picks up arbitrary binary contents (BAM, images, ...) safely
	 * through SSH's text channel. Writes to `localPath` and returns the
	 * decoded byte count.
	 */
	async downloadBase64(profile: SshProfile, remotePath: string, localPath: string): Promise<number> {
		const cmd = `base64 ${shellQuote(remotePath)}`;
		const { stdout, stderr, exitCode } = await this.run(profile, cmd);
		if (exitCode !== 0) {
			throw new Error(`Remote base64 failed: ${stderr.trim() || stdout.trim()}`);
		}
		const clean = stdout.replace(/\s+/g, '');
		const bytes = Buffer.from(clean, 'base64');
		fs.mkdirSync(path.dirname(localPath), { recursive: true });
		fs.writeFileSync(localPath, bytes);
		return bytes.length;
	}

	async listFiles(profile: SshProfile, remotePath: string): Promise<string[]> {
		// `ls -1A` lists one entry per line, including dotfiles but excluding
		// `.` / `..`. The empty-output case is a valid empty directory.
		const cmd = `ls -1A -- ${shellQuote(remotePath)}`;
		const { stdout, stderr, exitCode } = await this.run(profile, cmd);
		if (exitCode !== 0) {
			throw new Error(`list_files failed (exit ${exitCode}): ${stderr.trim()}`);
		}
		return stdout.split('\n').filter(line => line.length > 0);
	}

	/** Core: open a connection, run one command, collect raw output, disconnect. */
	private execRaw(profile: SshProfile, command: string, opts: RunOptions): Promise<{ stdout: Buffer; stderr: string; exitCode: number }> {
		return new Promise((resolve, reject) => {
			let cfg: ConnectConfig;
			try {
				cfg = connectConfig(profile, opts.timeoutMs);
			} catch (e) {
				reject(e);
				return;
			}

			const conn = new Client();
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const finish = (err?: Error, val?: { stdout: Buffer; stderr: string; exitCode: number }): void => {
				if (settled) { return; }
				settled = true;
				if (timer) { clearTimeout(timer); }
				try { conn.end(); } catch { /* ignore */ }
				if (err) { reject(err); } else { resolve(val!); }
			};

			if (opts.timeoutMs && opts.timeoutMs > 0) {
				timer = setTimeout(() => finish(new Error(`ssh command timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
			}

			conn.on('ready', () => {
				conn.exec(command, (err, stream) => {
					if (err) { finish(err); return; }
					const out: Buffer[] = [];
					let errText = '';
					stream.on('close', (code: number | null) => {
						finish(undefined, { stdout: Buffer.concat(out), stderr: errText, exitCode: code ?? 0 });
					}).on('data', (d: Buffer) => { out.push(d); });
					stream.stderr.on('data', (d: Buffer) => { errText += d.toString('utf8'); });
					if (opts.stdin !== undefined) { stream.end(opts.stdin); }
				});
			});
			conn.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));

			try {
				conn.connect(cfg);
			} catch (e) {
				finish(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}
}

/** Translate an Aria SshProfile into ssh2's connection config. Throws with a
 *  clear message when required auth material is missing. */
function connectConfig(profile: SshProfile, timeoutMs?: number): ConnectConfig {
	const cfg: ConnectConfig = {
		host: profile.host,
		port: profile.port,
		username: profile.username,
		readyTimeout: timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
		keepaliveInterval: 30000,
	};
	switch (profile.auth.type) {
		case 'password':
			if (!profile.auth.password) { throw new Error('Password auth selected but no password supplied.'); }
			cfg.password = profile.auth.password;
			break;
		case 'key':
			if (!profile.auth.key_path) { throw new Error('Key auth selected but no key file supplied.'); }
			cfg.privateKey = fs.readFileSync(profile.auth.key_path);
			break;
		case 'agent':
			// Fall back to the OS SSH agent (Pageant on Windows).
			cfg.agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? 'pageant' : undefined);
			break;
	}
	return cfg;
}

/**
 * Some remote environments prepend a spurious `{"success":true}` banner to the
 * FIRST line of command output (a known autopipe-server quirk - roCrate's
 * `cleanContent` strips it too). Left in, it corrupts the first entry of every
 * command: e.g. `list_files` returns `{"success":true}data.fq` as a filename,
 * which then gets used to create a garbage-named file. Strip the exact known
 * banner at the SSH boundary so every tool sees clean output. Only the precise
 * literal is removed, so genuine JSON output that merely starts with `{` is left
 * untouched.
 */
function stripSuccessPrefix(s: string): string {
	for (const prefix of ['{"success":true}', '{"success": true}', '{"success" : true}']) {
		if (s.startsWith(prefix)) {
			return s.slice(prefix.length);
		}
	}
	return s;
}

/** Buffer (binary) variant of stripSuccessPrefix - removes the banner from the
 *  head of a raw file read so binary payloads (images, PDFs, BAM) stay intact. */
function stripSuccessPrefixBytes(buf: Buffer): Buffer {
	for (const prefix of ['{"success":true}', '{"success": true}', '{"success" : true}']) {
		const p = Buffer.from(prefix, 'ascii');
		if (buf.length >= p.length && buf.subarray(0, p.length).equals(p)) {
			return buf.subarray(p.length);
		}
	}
	return buf;
}

/**
 * Quote `s` so it survives unquoted use inside a remote `sh -c` invocation.
 * We wrap in single quotes and escape any embedded single quote by closing,
 * inserting an escaped quote, and reopening.
 */
function shellQuote(s: string): string {
	if (/^[A-Za-z0-9_./@:+,=-]+$/.test(s)) {
		return s;
	}
	return `'${s.replace(/'/g, "'\\''")}'`;
}
