/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as envManager from './envManager';
import * as skillManifest from './skillManifest';
import * as skillsManager from './skillsManager';
import * as uvChecker from './uvChecker';

/**
 * Shared service container for the Skills extension. The pattern mirrors
 * aria-autopipe's services.ts - one place to grab dependencies from so
 * panels and command handlers don't have to import each module
 * individually.
 *
 * Unlike aria-autopipe where the services are stateful classes, the
 * Skills modules are stateless function namespaces (no per-instance
 * config). The container just exposes them under stable names so future
 * test wiring can swap in mocks via setSkillsServices().
 */

export interface SkillsServices {
	env: typeof envManager;
	manifest: typeof skillManifest;
	skills: typeof skillsManager;
	uv: typeof uvChecker;
}

let _services: SkillsServices | undefined;

export function setSkillsServices(s: SkillsServices): void {
	_services = s;
}

export function skillsServices(): SkillsServices {
	if (!_services) {
		throw new Error('SkillsServices not initialised - extension.activate() did not run');
	}
	return _services;
}

/** Default wiring used by extension.activate() - real modules, no mocks. */
export function buildDefaultServices(): SkillsServices {
	return {
		env: envManager,
		manifest: skillManifest,
		skills: skillsManager,
		uv: uvChecker,
	};
}
