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

	/**
	 * Stream a single remote file to `localPath` over SFTP. Unlike
	 * `downloadBase64` (which slurps the whole file into memory, base64-encoded),
	 * this pipes `sftp.createReadStream(remotePath)` straight into
	 * `fs.createWriteStream(localPath)` so multi-GB genomic outputs (BAM/CRAM/
	 * FASTQ) copy with a constant, small memory footprint. Creates the local
	 * parent directory as needed and resolves with the byte count.
	 *
	 * Works identically for the built-in VM (127.0.0.1) and remote SSH hosts -
	 * both are just SshProfiles, and ssh2's SFTP subsystem rides the same
	 * connection.
	 */
	/**
	 * Download MANY files over ONE SSH connection, WITHOUT SFTP.
	 *
	 * Two problems forced this shape. Opening a connection per file (the original
	 * approach) fires several full authentications within seconds, which servers
	 * that rate-limit rapid logins refuse - reported as "All configured
	 * authentication methods failed" on the copy even though the run that just
	 * preceded it worked. And SFTP is not always available at all: a server can
	 * omit `Subsystem sftp` or block it with Match/ForceCommand while exec works
	 * fine, so a copy built on SFTP fails there permanently.
	 *
	 * So: one login, then one `base64 <file>` exec per file over that same
	 * connection - the transport autopipe used before SFTP was introduced, and the
	 * same trick autopipe-app's Rust `ssh_download_base64` uses. Output is decoded
	 * incrementally as it streams, so memory stays flat regardless of file size.
	 *
	 * Per-file failures are collected rather than aborting the batch; a failure in
	 * the connect/auth phase is retried, since nothing has transferred yet.
	 */
	async downloadFilesBase64(
		profile: SshProfile,
		files: Array<{ remote: string; local: string; expectedBytes?: number }>,
	): Promise<{ copied: number; errors: Array<{ remote: string; message: string }> }> {
		if (files.length === 0) {
			return { copied: 0, errors: [] };
		}
		const MAX_ATTEMPTS = 3;
		let lastErr: Error | undefined;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			try {
				return await this.downloadFilesBase64Once(profile, files);
			} catch (e) {
				const err = e instanceof Error ? e : new Error(String(e));
				lastErr = err;
				if ((err as Error & { preReady?: boolean }).preReady !== true || attempt === MAX_ATTEMPTS) {
					throw err;
				}
				await new Promise(r => setTimeout(r, 500 * attempt));
			}
		}
		throw lastErr ?? new Error('download failed');
	}

	private downloadFilesBase64Once(
		profile: SshProfile,
		files: Array<{ remote: string; local: string; expectedBytes?: number }>,
	): Promise<{ copied: number; errors: Array<{ remote: string; message: string }> }> {
		return new Promise((resolve, reject) => {
			let cfg: ConnectConfig;
			try {
				cfg = connectConfig(profile);
			} catch (e) {
				reject(e);
				return;
			}

			const conn = new Client();
			let readyReached = false;
			let settled = false;
			const fail = (err: Error): void => {
				if (settled) { return; }
				settled = true;
				if (!readyReached) { (err as Error & { preReady?: boolean }).preReady = true; }
				try { conn.end(); } catch { /* ignore */ }
				reject(err);
			};
			const done = (result: { copied: number; errors: Array<{ remote: string; message: string }> }): void => {
				if (settled) { return; }
				settled = true;
				try { conn.end(); } catch { /* ignore */ }
				resolve(result);
			};

			conn.on('ready', () => {
				readyReached = true;
				void (async () => {
					const errors: Array<{ remote: string; message: string }> = [];
					let copied = 0;
					for (const file of files) {
						try {
							await this.base64FileToDisk(conn, file.remote, file.local, file.expectedBytes);
							copied++;
						} catch (e) {
							errors.push({ remote: file.remote, message: (e as Error).message });
						}
					}
					done({ copied, errors });
				})();
			});
			conn.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))));

			// Same keyboard-interactive fallback as every other connect site.
			if (profile.auth.type === 'password' && profile.auth.password) {
				const kbPw = profile.auth.password;
				conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, respond) => {
					respond(prompts.map(() => kbPw));
				});
			}

			try {
				conn.connect(cfg);
			} catch (e) {
				fail(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	/**
	 * Run `base64 <remote>` on an ALREADY-OPEN connection and decode the stream
	 * straight to disk. Decoding incrementally (rather than buffering the whole
	 * encoded blob) keeps memory flat, which matters because base64 inflates the
	 * payload by ~33%.
	 */
	private base64FileToDisk(conn: Client, remotePath: string, localPath: string, expectedBytes?: number): Promise<void> {
		return new Promise((resolve, reject) => {
			try {
				fs.mkdirSync(path.dirname(localPath), { recursive: true });
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
				return;
			}
			// `base64 < file` rather than `base64 -- file`: reading stdin is universal,
			// while the `--` end-of-options separator is not accepted by every base64
			// implementation. A missing/unreadable file still exits non-zero.
			conn.exec(`base64 < ${shellQuote(remotePath)}`, (err, stream) => {
				if (err) { reject(err); return; }
				const out = fs.createWriteStream(localPath);
				let leftover = '';
				let stderr = '';
				let settled = false;
				// Head of the stream, held back until we can tell whether the remote
				// prefixed the spurious `{"success":true}` banner (see
				// stripSuccessPrefix). Letting it through would be silent corruption,
				// not a visible error: Buffer.from(_, 'base64') DISCARDS the invalid
				// characters and keeps the valid ones ("success"/"true" are all valid
				// base64), which shifts the 4-character decode alignment and turns the
				// whole file into garbage while still reporting success.
				let head = '';
				let headDone = false;
				let stall: NodeJS.Timeout | undefined;
				// Decoded byte count, checked against the size the remote reported. This
				// is the safety net base64 needs and SFTP did not: Buffer.from(_,'base64')
				// silently DISCARDS characters it cannot parse, so anything polluting the
				// stream shifts the 4-character alignment and yields a plausible-looking
				// but entirely wrong file, with no error anywhere. A byte count that does
				// not match turns that into a visible failure.
				let written = 0;
				const finish = (e?: Error): void => {
					if (settled) { return; }
					settled = true;
					if (stall) { clearTimeout(stall); }
					if (e) {
						// A partial file is worse than none: the caller would report it
						// as copied and the user would open a truncated result.
						try { out.destroy(); } catch { /* already closed */ }
						try { fs.unlinkSync(localPath); } catch { /* nothing to remove */ }
						reject(e);
					} else {
						resolve();
					}
				};
				// A download the user explicitly approved must never hang silently: if
				// no bytes arrive for this long, give up and say so. Inactivity (not
				// total duration) is the right measure - a slow but progressing
				// transfer of a large file is fine, a stalled one is not.
				const armStall = () => {
					if (stall) { clearTimeout(stall); }
					stall = setTimeout(() => {
						try { stream.close(); } catch { /* already gone */ }
						finish(new Error(`the download stalled - no data for ${STALL_TIMEOUT_MS / 1000}s`));
					}, STALL_TIMEOUT_MS);
				};
				armStall();
				// Without this, a local write failure (disk full, no permission) emits an
				// unhandled 'error' on the stream and takes down the extension host.
				out.on('error', (e: Error) => finish(e));
				/** Feed whitespace-stripped base64 text through the incremental decoder. */
				const consume = (text: string): void => {
					const chunk = leftover + text;
					const usable = chunk.length - (chunk.length % 4);
					leftover = chunk.slice(usable);
					if (usable > 0) {
						const decoded = Buffer.from(chunk.slice(0, usable), 'base64');
						written += decoded.length;
						// Respect backpressure, otherwise a fast remote fills memory with
						// queued writes - the very thing streaming was meant to avoid.
						if (!out.write(decoded)) {
							stream.pause();
							out.once('drain', () => stream.resume());
						}
					}
				};
				/** Drop the banner once enough of the head has arrived to recognise it.
				 *  Whitespace is already gone, so all three spacing variants of the
				 *  literal have collapsed to the same string. */
				const takeHead = (): void => {
					headDone = true;
					const body = head.startsWith(SUCCESS_BANNER) ? head.slice(SUCCESS_BANNER.length) : head;
					head = '';
					consume(body);
				};
				stream.on('data', (d: Buffer) => {
					armStall();
					const text = d.toString('ascii').replace(/\s+/g, '');
					if (!headDone) {
						head += text;
						// Wait until the head is long enough to compare against the banner;
						// it can straddle several chunks.
						if (head.length < SUCCESS_BANNER.length) { return; }
						takeHead();
						return;
					}
					consume(text);
				});
				stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
				stream.on('error', (e: Error) => finish(e));
				stream.on('close', (code: number | null) => {
					if (stall) { clearTimeout(stall); }
					// A file smaller than the banner never reached takeHead.
					if (!headDone) { takeHead(); }
					if (leftover) {
						const tail = Buffer.from(leftover, 'base64');
						written += tail.length;
						out.write(tail);
					}
					// ssh2 passes null when the channel closes without an exit-status
					// message; treat that as success exactly like execRaw does. Reading
					// it as a failure would delete every file we just downloaded.
					const exitCode = code ?? 0;
					out.end(() => {
						if (exitCode !== 0) {
							finish(new Error(stderr.trim() || `base64 exited with ${exitCode}`));
						} else if (expectedBytes !== undefined && written !== expectedBytes) {
							finish(new Error(`the copy is corrupt: got ${written} bytes, the server reports ${expectedBytes}`));
						} else {
							finish();
						}
					});
				});
			});
		});
	}

	downloadFileSftp(profile: SshProfile, remotePath: string, localPath: string): Promise<number> {
		return new Promise((resolve, reject) => {
			let cfg: ConnectConfig;
			try {
				cfg = connectConfig(profile);
			} catch (e) {
				reject(e);
				return;
			}

			const conn = new Client();
			let settled = false;
			const finish = (err?: Error, val?: number): void => {
				if (settled) { return; }
				settled = true;
				try { conn.end(); } catch { /* ignore */ }
				if (err) { reject(err); } else { resolve(val ?? 0); }
			};

			conn.on('ready', () => {
				conn.sftp((err, sftp) => {
					if (err) { finish(err); return; }
					try {
						fs.mkdirSync(path.dirname(localPath), { recursive: true });
					} catch (e) {
						finish(e instanceof Error ? e : new Error(String(e)));
						return;
					}
					const readStream = sftp.createReadStream(remotePath);
					const writeStream = fs.createWriteStream(localPath);
					let bytes = 0;
					readStream.on('data', (d: string | Buffer) => { bytes += typeof d === 'string' ? Buffer.byteLength(d) : d.length; });
					readStream.on('error', (e: Error) => finish(e));
					writeStream.on('error', (e: Error) => finish(e));
					writeStream.on('close', () => finish(undefined, bytes));
					readStream.pipe(writeStream);
				});
			});
			conn.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));

			// keyboard-interactive fallback for password auth (PAM-only servers
			// that don't offer the `password` method). Answer every prompt with
			// the profile password, mirroring the OpenSSH client's behaviour.
			if (profile.auth.type === 'password' && profile.auth.password) {
				const kbPw = profile.auth.password;
				conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, respond) => {
					respond(prompts.map(() => kbPw));
				});
			}

			try {
				conn.connect(cfg);
			} catch (e) {
				finish(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	/**
	 * Stream a single LOCAL file up to `remotePath` over SFTP - the upload mirror
	 * of `downloadFileSftp`. Pipes `fs.createReadStream(localPath)` into
	 * `sftp.createWriteStream(remotePath)` so large local inputs (BAM/CRAM/FASTQ)
	 * upload with a constant, small memory footprint. The remote PARENT directory
	 * must already exist (create it with `mkdir -p` as the SSH user first, so it is
	 * NOT root-owned). Resolves with the byte count. Works for the built-in VM and
	 * remote hosts alike.
	 */
	uploadFileSftp(profile: SshProfile, localPath: string, remotePath: string): Promise<number> {
		return new Promise((resolve, reject) => {
			let cfg: ConnectConfig;
			try {
				cfg = connectConfig(profile);
			} catch (e) {
				reject(e);
				return;
			}

			const conn = new Client();
			let settled = false;
			const finish = (err?: Error, val?: number): void => {
				if (settled) { return; }
				settled = true;
				try { conn.end(); } catch { /* ignore */ }
				if (err) { reject(err); } else { resolve(val ?? 0); }
			};

			conn.on('ready', () => {
				conn.sftp((err, sftp) => {
					if (err) { finish(err); return; }
					let bytes = 0;
					const readStream = fs.createReadStream(localPath);
					const writeStream = sftp.createWriteStream(remotePath);
					readStream.on('data', (d: string | Buffer) => { bytes += typeof d === 'string' ? Buffer.byteLength(d) : d.length; });
					readStream.on('error', (e: Error) => finish(e));
					writeStream.on('error', (e: Error) => finish(e));
					writeStream.on('close', () => finish(undefined, bytes));
					readStream.pipe(writeStream);
				});
			});
			conn.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));

			// keyboard-interactive fallback for password auth (PAM-only servers
			// that don't offer the `password` method). Answer every prompt with
			// the profile password, mirroring the OpenSSH client's behaviour.
			if (profile.auth.type === 'password' && profile.auth.password) {
				const kbPw = profile.auth.password;
				conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, respond) => {
					respond(prompts.map(() => kbPw));
				});
			}

			try {
				conn.connect(cfg);
			} catch (e) {
				finish(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	/**
	 * Upload a local file by streaming it over the exec channel. No SFTP.
	 *
	 * SFTP is OPTIONAL on a server - sshd can omit `Subsystem sftp` or block it
	 * with Match/ForceCommand - while command execution always works, because
	 * running the user's code is the whole point of the connection. On a server
	 * that refuses SFTP, every upload paid for a doomed connection first; that was
	 * the repeated "SFTP failed" during upload. Downloads are exec-only for the
	 * same reason, so both directions now agree and there is one path to keep
	 * working rather than two.
	 */
	uploadFile(profile: SshProfile, localPath: string, remotePath: string): Promise<number> {
		return this.uploadFileExec(profile, localPath, remotePath);
	}

	/**
	 * Stream a local file to `remotePath` through `cat` on the exec channel. The
	 * SSH exec channel carries raw bytes (no PTY, so no newline translation), which
	 * is the same property that lets `readFile` pull binaries down with `cat`.
	 *
	 * Writes to a `.qoka-part` temp name and renames on success, so a failed or
	 * interrupted upload can never leave a truncated file sitting at the real path
	 * where a pipeline would happily consume it as input.
	 */
	uploadFileExec(profile: SshProfile, localPath: string, remotePath: string): Promise<number> {
		return new Promise((resolve, reject) => {
			let cfg: ConnectConfig;
			let size = 0;
			try {
				cfg = connectConfig(profile);
				size = fs.statSync(localPath).size;
			} catch (e) {
				reject(e);
				return;
			}

			const conn = new Client();
			let settled = false;
			let stall: NodeJS.Timeout | undefined;
			const finish = (err?: Error, val?: number): void => {
				if (settled) { return; }
				settled = true;
				if (stall) { clearTimeout(stall); }
				try { conn.end(); } catch { /* ignore */ }
				if (err) { reject(err); } else { resolve(val ?? 0); }
			};

			conn.on('ready', () => {
				const part = `${remotePath}.qoka-part`;
				// `cat` into a temp file, then rename. On any failure remove the temp so
				// the server is not littered with half-written inputs.
				const cmd = `cat > ${shellQuote(part)} && mv -f ${shellQuote(part)} ${shellQuote(remotePath)} || { rm -f ${shellQuote(part)}; exit 1; }`;
				conn.exec(cmd, (err, stream) => {
					if (err) { finish(err); return; }
					let stderr = '';
					let bytes = 0;
					const armStall = () => {
						if (stall) { clearTimeout(stall); }
						stall = setTimeout(() => {
							try { stream.close(); } catch { /* already gone */ }
							finish(new Error(`the upload stalled - no progress for ${STALL_TIMEOUT_MS / 1000}s`));
						}, STALL_TIMEOUT_MS);
					};
					armStall();
					const readStream = fs.createReadStream(localPath);
					readStream.on('data', (d: string | Buffer) => {
						bytes += typeof d === 'string' ? Buffer.byteLength(d) : d.length;
						armStall();
					});
					readStream.on('error', (e: Error) => finish(e));
					stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
					stream.on('error', (e: Error) => finish(e));
					stream.on('close', (code: number | null) => {
						const exitCode = code ?? 0;
						if (exitCode !== 0) {
							finish(new Error(stderr.trim() || `remote write failed (exit ${exitCode})`));
							return;
						}
						if (bytes !== size) {
							finish(new Error(`upload was truncated: sent ${bytes} of ${size} bytes`));
							return;
						}
						finish(undefined, bytes);
					});
					readStream.pipe(stream);
				});
			});
			conn.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));

			// Same keyboard-interactive fallback as every other connect site.
			if (profile.auth.type === 'password' && profile.auth.password) {
				const kbPw = profile.auth.password;
				conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, respond) => {
					respond(prompts.map(() => kbPw));
				});
			}

			try {
				conn.connect(cfg);
			} catch (e) {
				finish(e instanceof Error ? e : new Error(String(e)));
			}
		});
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
	/**
	 * Run one command, retrying ONLY when the failure happened before the session
	 * was established (connect/handshake/auth). A single run_code opens several
	 * short-lived connections back to back, and servers that rate-limit or lock out
	 * rapid logins start refusing them - the symptom is "All configured
	 * authentication methods failed" on the 2nd+ connection while a lone probe still
	 * succeeds. Retrying a pre-ready failure is safe: the command never ran, so
	 * nothing can execute twice. Anything that fails AFTER the session is up is
	 * surfaced immediately.
	 */
	private async execRaw(profile: SshProfile, command: string, opts: RunOptions): Promise<{ stdout: Buffer; stderr: string; exitCode: number }> {
		const MAX_ATTEMPTS = 3;
		let lastErr: Error | undefined;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			try {
				return await this.execOnce(profile, command, opts);
			} catch (e) {
				const err = e instanceof Error ? e : new Error(String(e));
				lastErr = err;
				const preReady = (err as Error & { preReady?: boolean }).preReady === true;
				if (!preReady || attempt === MAX_ATTEMPTS) {
					throw err;
				}
				// Back off a little so a rate limiter has time to relax.
				await new Promise(r => setTimeout(r, 500 * attempt));
			}
		}
		throw lastErr ?? new Error('ssh exec failed');
	}

	private execOnce(profile: SshProfile, command: string, opts: RunOptions): Promise<{ stdout: Buffer; stderr: string; exitCode: number }> {
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

			let readyReached = false;
			conn.on('ready', () => {
				readyReached = true;
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
			conn.on('error', (err) => {
				const e = err instanceof Error ? err : new Error(String(err));
				// Tag connect/handshake/auth failures so execRaw can safely retry them.
				if (!readyReached) {
					(e as Error & { preReady?: boolean }).preReady = true;
				}
				finish(e);
			});

			// keyboard-interactive fallback for password auth (PAM-only servers
			// that don't offer the `password` method). Answer every prompt with
			// the profile password, mirroring the OpenSSH client's behaviour.
			if (profile.auth.type === 'password' && profile.auth.password) {
				const kbPw = profile.auth.password;
				conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, respond) => {
					respond(prompts.map(() => kbPw));
				});
			}

			try {
				conn.connect(cfg);
			} catch (e) {
				finish(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}
}

/** The spurious banner some remotes prepend to command output, with whitespace
 *  already removed so every spacing variant matches the same literal. */
const SUCCESS_BANNER = '{"success":true}';

/** Give up on a download that has received no bytes for this long. */
const STALL_TIMEOUT_MS = 120_000;

/** Translate an Qoka SshProfile into ssh2's connection config. Throws with a
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
			// Also allow keyboard-interactive: many PAM-based sshd only offer
			// `keyboard-interactive`, not the `password` method, so a correct
			// password still fails with "All configured authentication methods
			// failed". The OpenSSH client falls back automatically; ssh2 needs
			// tryKeyboard + a handler (added in execRaw) that replies with the
			// same password.
			cfg.tryKeyboard = true;
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
