/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { IUntypedEditorInput } from '../../../common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { isEqual } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';

/** Synthetic scheme for the Project Overview editor's identity URI, so opening it
 *  uses our full-width pane rather than a text editor (same trick as the note and
 *  roadmap wizard editors). The overview data lives at `<folder>/.aria/overview.json`. */
export const ARIA_OVERVIEW_SCHEME = 'aria-overview';

/**
 * Editor input for the Project Overview. There is exactly one overview per
 * project folder, so the input is identified by the folder it belongs to. Opening
 * it renders the full-width overview pane (Title + Content + Roadmap + To-do)
 * across the editor area, instead of a narrow sidebar list.
 */
export class AriaProjectOverviewEditorInput extends EditorInput {

	static readonly ID = 'aria.overview.editorInput';
	static readonly EDITOR_ID = 'aria.overview.editorPane';

	private readonly _resource: URI;

	constructor(readonly folderResource: URI) {
		super();
		this._resource = URI.from({ scheme: ARIA_OVERVIEW_SCHEME, path: folderResource.path });
	}

	override get typeId(): string {
		return AriaProjectOverviewEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return AriaProjectOverviewEditorInput.EDITOR_ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return localize('aria.overview.tabName', "Project Overview");
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof AriaProjectOverviewEditorInput && isEqual(other.folderResource, this.folderResource);
	}
}
