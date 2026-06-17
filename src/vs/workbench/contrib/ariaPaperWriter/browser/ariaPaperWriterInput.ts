/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { IUntypedEditorInput } from '../../../common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';

/** Synthetic scheme so the paper opens in our custom pane, not as a folder. The
 *  real paper directory (`<workspace>/paper/<id>/`) is `folderResource`. */
export const ARIA_PAPER_SCHEME = 'aria-paper';

/**
 * Editor input for a paper project. Identified by a synthetic `aria-paper:` URI
 * but backed by the real project directory (meta.json / manuscript.md /
 * citations.csl.json live inside `folderResource`).
 */
export class AriaPaperWriterInput extends EditorInput {

	static readonly ID = 'aria.paperWriter.editorInput';
	static readonly EDITOR_ID = 'aria.paperWriter.editorPane';

	private readonly _resource: URI;
	private _name: string;

	constructor(readonly folderResource: URI) {
		super();
		this._resource = URI.from({ scheme: ARIA_PAPER_SCHEME, path: folderResource.path, query: folderResource.scheme });
		this._name = basename(folderResource) || localize('aria.paperWriter.untitled', "Paper");
	}

	override get typeId(): string {
		return AriaPaperWriterInput.ID;
	}

	override get editorId(): string | undefined {
		return AriaPaperWriterInput.EDITOR_ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return this._name;
	}

	/** Update the tab title (called by the pane once it reads the paper's title). */
	setName(name: string): void {
		if (name && name !== this._name) {
			this._name = name;
			this._onDidChangeLabel.fire();
		}
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof AriaPaperWriterInput && isEqual(other.folderResource, this.folderResource);
	}
}
