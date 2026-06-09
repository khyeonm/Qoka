/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { SshProfile } from '../common/types';

/**
 * Thin wrapper around the system `ssh` CLI. Aria's extension host runs in
 * Node.js — same pattern aria-vcs uses for `git` (shell out instead of
 * pulling in a Node library). This keeps the extension's runtime
 * dependencies at zero npm packages while still reaching arbitrary SSH
 * hosts.
 *
 * Trade-off: every command spawns a new ssh process. For a future
 * optimisation we can switch to the `ssh2` npm package with a persistent
 * connection pool — autopipe-app's Rust code uses ssh2-rs the same way.
 * For Phase 5 the spawn-per-command model is plenty.
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

export class SshService {

	async run(profile: SshProfile, command: string, opts: RunOptions = {}): Promise<SshResult> {
		return new Promise((resolve, reject) => {
			const args = buildSshArgs(profile);
			args.push(command);

			const env = { ...process.env };
			// Electron pre-loads its own bundled crypto libs and points
			// LD_LIBRARY_PATH / LD_PRELOAD at them. The system `ssh`
			// binary then crashes with "OpenSSL version mismatch" because
			// it was built against a different libssl ABI than Electron's
			// bundled one. Strip those vars so ssh resolves the system
			// libssl normally — same defensive pattern VS Code's built-in
			// git extension uses when shelling out to /usr/bin/git.
			delete env.LD_LIBRARY_PATH;
			delete env.LD_PRELOAD;
			delete env.SNAP;
			delete env.SNAP_REVISION;
			// Tell ssh-askpass that we have no terminal — if the user's
			// key has a passphrase we'd rather get an explicit failure
			// than a hung prompt.
			env.SSH_ASKPASS_REQUIRE = 'never';

			// Password auth uses `sshpass -e ssh …` so the password flows
			// through SSHPASS env var rather than being passed on the
			// command line (visible to `ps`). Falls back to a clear error
			// when sshpass isn't installed.
			let command0 = 'ssh';
			let finalArgs = args;
			if (profile.auth.type === 'password') {
				if (!profile.auth.password) {
					reject(new Error('Password auth selected but no password supplied.'));
					return;
				}
				env.SSHPASS = profile.auth.password;
				command0 = 'sshpass';
				finalArgs = ['-e', 'ssh', ...args];
			}

			const child = spawn(command0, finalArgs, { env });
			let stdout = '';
			let stderr = '';
			let timer: NodeJS.Timeout | undefined;

			if (opts.timeoutMs && opts.timeoutMs > 0) {
				timer = setTimeout(() => {
					try { child.kill('SIGTERM'); } catch { /* ignore */ }
					reject(new Error(`ssh command timed out after ${opts.timeoutMs}ms`));
				}, opts.timeoutMs);
			}

			child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
			child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
			child.on('error', (err) => {
				if (timer) { clearTimeout(timer); }
				reject(err);
			});
			child.on('close', (code) => {
				if (timer) { clearTimeout(timer); }
				resolve({ stdout, stderr, exitCode: code ?? 0 });
			});

			if (opts.stdin !== undefined) {
				child.stdin.write(opts.stdin);
				child.stdin.end();
			} else {
				child.stdin.end();
			}
		});
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

	async readFile(profile: SshProfile, remotePath: string): Promise<Buffer> {
		// Binary-safe read: we collect stdout as raw Buffers (no toString)
		// so callers handling binary files (BAM, images, PDFs) get the
		// exact bytes. The MCP `read_file` handler decodes to UTF-8 itself;
		// the viewer panel uses the raw bytes via base64.
		const args = buildSshArgs(profile);
		args.push(`cat -- ${shellQuote(remotePath)}`);

		const env = { ...process.env };
		delete env.LD_LIBRARY_PATH;
		delete env.LD_PRELOAD;
		delete env.SNAP;
		delete env.SNAP_REVISION;
		env.SSH_ASKPASS_REQUIRE = 'never';

		let command0 = 'ssh';
		let finalArgs = args;
		if (profile.auth.type === 'password') {
			if (!profile.auth.password) {
				throw new Error('Password auth selected but no password supplied.');
			}
			env.SSHPASS = profile.auth.password;
			command0 = 'sshpass';
			finalArgs = ['-e', 'ssh', ...args];
		}

		return new Promise<Buffer>((resolve, reject) => {
			const child = spawn(command0, finalArgs, { env });
			const chunks: Buffer[] = [];
			let stderr = '';
			child.stdout.on('data', (c: Buffer) => { chunks.push(c); });
			child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
			child.on('error', reject);
			child.on('close', (code) => {
				if (code !== 0) {
					reject(new Error(`read_file failed (exit ${code}): ${stderr.trim()}`));
					return;
				}
				resolve(Buffer.concat(chunks));
			});
			child.stdin.end();
		});
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
		const fs = await import('fs');
		const path = await import('path');
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
}

function buildSshArgs(profile: SshProfile): string[] {
	const args: string[] = [
		'-p', String(profile.port),
		'-o', 'StrictHostKeyChecking=accept-new',
		'-o', 'ConnectTimeout=10',
		'-o', 'ServerAliveInterval=30',
	];
	// BatchMode=yes blocks ALL prompts — perfect for key/agent auth
	// (we'd rather fail than hang) but breaks password auth because
	// sshpass needs to answer the password prompt. So switch it off
	// when the profile is password-based.
	if (profile.auth.type !== 'password') {
		args.push('-o', 'BatchMode=yes');
	}
	if (profile.auth.type === 'key' && profile.auth.key_path) {
		args.push('-i', profile.auth.key_path);
	}
	args.push(`${profile.username}@${profile.host}`);
	return args;
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
