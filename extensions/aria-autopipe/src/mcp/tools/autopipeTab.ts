/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Autopipe sidebar tab was merged into the Settings tab, so there is no longer a
 * separate Autopipe view to reveal while a pipeline builds/writes/runs (pipeline
 * output surfaces as editor tabs and in `analysis/` on its own). This is kept as a
 * no-op so the pipeline build/write/run tools that call it are unchanged.
 */
export function ensureAutopipeTabOpen(): void {
	/* no-op - Autopipe is retired into the Settings tab */
}
