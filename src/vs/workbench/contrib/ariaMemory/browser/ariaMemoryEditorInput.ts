/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { IUntypedEditorInput } from '../../../common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';

/** Synthetic scheme for the Memory editor's identity URI, so opening it uses our
 *  centered pane rather than a text editor (same trick as the Settings editor). */
export const ARIA_MEMORY_SCHEME = 'aria-memory';

/**
 * Editor input for the Memory page. A single instance identifies the page; opening
 * it renders the two stacked memory sections (this project / global) in the editor
 * area.
 */
export class AriaMemoryEditorInput extends EditorInput {

	static readonly ID = 'aria.memory.editorInput';
	static readonly EDITOR_ID = 'aria.memory.editorPane';

	private readonly _resource = URI.from({ scheme: ARIA_MEMORY_SCHEME, path: '/memory' });

	override get typeId(): string {
		return AriaMemoryEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return AriaMemoryEditorInput.EDITOR_ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return localize('aria.memory.tabName', "Memory");
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof AriaMemoryEditorInput;
	}
}
