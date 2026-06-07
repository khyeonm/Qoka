/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { localize } from '../../../../nls.js';

export const ARIA_MODE_SETTING = 'aria.mode';

export type AriaMode = '' | 'easy' | 'advanced';

export const AriaModeContextKey = new RawContextKey<AriaMode>('aria.mode', '');

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'aria',
	order: 5,
	title: localize('ariaConfigurationTitle', "Aria"),
	type: 'object',
	properties: {
		[ARIA_MODE_SETTING]: {
			type: 'string',
			enum: ['', 'easy', 'advanced'],
			enumDescriptions: [
				localize('aria.mode.unset', "Not yet selected — Aria will show the mode picker on next start."),
				localize('aria.mode.easy', "Simplified UI focused on research workflows."),
				localize('aria.mode.advanced', "Full IDE with all VS Code features."),
			],
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('aria.mode.description', "Aria interface mode."),
		}
	}
});
