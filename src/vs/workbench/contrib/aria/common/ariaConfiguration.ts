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

export const ARIA_AI_PROVIDER_SETTING = 'aria.aiProvider';

/** Which AI assistant Aria's ✨/chat buttons prefer when several are installed. */
export type AriaAiProvider = 'auto' | 'claude' | 'codex';

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
		},
		[ARIA_AI_PROVIDER_SETTING]: {
			type: 'string',
			enum: ['auto', 'claude', 'codex'],
			enumDescriptions: [
				localize('aria.aiProvider.auto', "Use whichever AI assistant is installed (prefers Claude Code when several are present)."),
				localize('aria.aiProvider.claude', "Prefer Claude Code."),
				localize('aria.aiProvider.codex', "Prefer Codex."),
			],
			default: 'auto',
			scope: ConfigurationScope.APPLICATION,
			description: localize('aria.aiProvider.description', "Which AI assistant Aria opens for its ✨ buttons when more than one is installed. Aria registers its tools with every installed assistant regardless of this setting."),
		}
	}
});
