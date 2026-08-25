/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared app key for the Qoka server's gated endpoints (X-Qoka-Key header).
 *
 * The value is EMPTY in source (this is a public repo - never commit the key).
 * The release build injects the real key here before `tsc`, e.g. in CI:
 *
 *   printf "export const QOKA_API_KEY = '%s';\n" "$QOKA_API_KEY" \
 *     > extensions/aria-methods-search/src/qokaKey.ts
 *
 * A dev build leaves it empty; server calls then 403 until a key is provided.
 * This replaces the per-user login JWT: the key only keeps the shared gemma4
 * endpoints off the open internet - it carries no user identity.
 */
export const QOKA_API_KEY = '';
