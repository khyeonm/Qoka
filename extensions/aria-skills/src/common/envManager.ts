/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Reads and writes the user's ~/.env file. Stays deliberately small and
 * synchronous-feeling so callers don't have to thread state — the file is
 * tiny (a few KB at most), so a fresh read every call is fine and avoids
 * stale-cache bugs when external editors or other skills touch the file.
 *
 * Security:
 *   - Values never enter logs or chat context. The caller controls the
 *     surface where they're shown.
 *   - Writes are atomic via tmpfile + rename so a crash mid-write can't
 *     leave a half-written .env.
 *   - File mode is set to 0600 on every write — only the user can read it.
 */

const ENV_PATH = path.join(os.homedir(), '.env');
const ENV_TMP_PATH = `${ENV_PATH}.tmp`;

/**
 * Parse the contents of ~/.env into a plain key-value map. Lines that are
 * blank or start with `#` are skipped. Quotes around values are
 * intentionally preserved as-is — `KEY="value"` becomes `KEY -> "value"` so
 * round-tripping doesn't drop the quotes the user typed.
 */
export function readEnv(): Record<string, string> {
	if (!fs.existsSync(ENV_PATH)) {
		return {};
	}
	const raw = fs.readFileSync(ENV_PATH, 'utf8');
	const out: Record<string, string> = {};
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		const eq = trimmed.indexOf('=');
		if (eq <= 0) {
			continue;
		}
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (key) {
			out[key] = value;
		}
	}
	return out;
}

/**
 * Apply a set of updates to ~/.env. Existing variables not in `updates`
 * are preserved; existing variables present in `updates` are overwritten;
 * a value of `''` blanks the variable but keeps its line so the user can
 * see it's known-but-unset.
 *
 * To remove a variable entirely (line and all), pass it via `removeKeys`.
 */
export function writeEnv(
	updates: Record<string, string>,
	removeKeys: string[] = [],
): void {
	const current = readEnv();
	for (const key of removeKeys) {
		delete current[key];
	}
	for (const [key, value] of Object.entries(updates)) {
		current[key] = value;
	}

	// Serialize in stable order (alphabetical) so diffs stay reviewable.
	const keys = Object.keys(current).sort();
	const body = keys.map(k => `${k}=${current[k]}`).join('\n');
	const final = body.length > 0 ? body + '\n' : '';

	// Atomic write — tmpfile + rename so a crash can't leave a half-written
	// .env. fs.renameSync is atomic on POSIX when source and dest are on
	// the same filesystem (and the home directory always is).
	fs.writeFileSync(ENV_TMP_PATH, final, { mode: 0o600 });
	fs.renameSync(ENV_TMP_PATH, ENV_PATH);
}

/**
 * Convenience: return only the variables matching a set of names. Returns
 * an empty string for any name not present, so the UI can render a
 * placeholder slot instead of throwing.
 */
export function readEnvKeys(names: string[]): Record<string, string> {
	const all = readEnv();
	const out: Record<string, string> = {};
	for (const name of names) {
		out[name] = all[name] ?? '';
	}
	return out;
}

/** Did the user ever create a ~/.env at all? */
export function envExists(): boolean {
	return fs.existsSync(ENV_PATH);
}

/** Absolute path to the env file, for tooling that needs to surface it. */
export function envPath(): string {
	return ENV_PATH;
}

/**
 * Make sure ~/.env exists. Created empty with mode 0600 if missing. We
 * call this on extension activate so the "Open ~/.env" button in the
 * Skills tab always opens something, even before the user saves a
 * single key — opening "no such file" was the most common confusion.
 */
export function ensureEnvFile(): void {
	if (fs.existsSync(ENV_PATH)) {
		return;
	}
	fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
	fs.writeFileSync(ENV_PATH, '', { mode: 0o600 });
}
