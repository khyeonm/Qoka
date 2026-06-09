/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigService } from '../config/configService';
import { SshService } from '../ssh/sshService';
import { HubApiClient } from '../hub/apiClient';
import { GitHubAuthService } from '../github/oauthService';
import { PluginService } from '../plugins/pluginService';

/**
 * Single shared container so tool handlers don't have to pass services
 * around individually. `extension.ts` builds it during `activate()` and
 * publishes the instance via `setServices()`; handlers fetch it via
 * `services()`.
 *
 * Keeping the lookup synchronous (no async lazy init) means the lifecycle
 * is fully in extension.ts's hands — handlers either get the live services
 * or fail fast.
 */
export interface AriaServices {
	config: ConfigService;
	ssh: SshService;
	hub: HubApiClient;
	github: GitHubAuthService;
	plugins: PluginService;
}

let _services: AriaServices | undefined;

export function setServices(s: AriaServices): void {
	_services = s;
}

export function services(): AriaServices {
	if (!_services) {
		throw new Error('AriaServices not initialised — extension.activate() did not run');
	}
	return _services;
}
