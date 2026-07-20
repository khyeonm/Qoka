/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../common/editor/editorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { Schemas } from '../../../../../base/common/network.js';
import { localize } from '../../../../../nls.js';

/**
 * EditorInput for the Qoka Start Page. Identified by a singleton URI so the
 * workbench treats it as a single editor instance - opening the start page
 * a second time reveals the existing one instead of creating a duplicate.
 */
export class AriaStartPageInput extends EditorInput {

	static readonly ID = 'workbench.editors.aria.startPageInput';
	static readonly RESOURCE = URI.from({ scheme: Schemas.walkThrough, path: 'aria-start' });

	override get typeId(): string {
		return AriaStartPageInput.ID;
	}

	override get resource(): URI {
		return AriaStartPageInput.RESOURCE;
	}

	override getName(): string {
		return localize('aria.startPage.title', "Welcome to Qoka");
	}

	override matches(other: EditorInput): boolean {
		return other instanceof AriaStartPageInput;
	}
}
