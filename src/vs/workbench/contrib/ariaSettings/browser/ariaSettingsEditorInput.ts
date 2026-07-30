/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { IUntypedEditorInput } from '../../../common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';

/** Synthetic scheme for the Settings editor's identity URI, so opening it uses our
 *  centered, max-width pane rather than a text editor (same trick as the Overview
 *  editor). There is one Settings page for the whole app. */
export const ARIA_SETTINGS_SCHEME = 'aria-settings';

/**
 * Editor input for the consolidated Settings page (Providers, Connections, Autopipe,
 * Skills). A single instance identifies the page; opening it renders the stacked,
 * centered settings sections in the editor area.
 */
export class AriaSettingsEditorInput extends EditorInput {

	static readonly ID = 'aria.settings.editorInput';
	static readonly EDITOR_ID = 'aria.settings.editorPane';

	private readonly _resource = URI.from({ scheme: ARIA_SETTINGS_SCHEME, path: '/settings' });

	override get typeId(): string {
		return AriaSettingsEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return AriaSettingsEditorInput.EDITOR_ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return localize('aria.settings.tabName', "Settings");
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof AriaSettingsEditorInput;
	}
}
