/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { IUntypedEditorInput } from '../../../common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';

/** Synthetic scheme so a manuscript revision opens in the review pane (a tab
 *  separate from the Paper Writer wizard), backed by the paper directory. */
export const ARIA_MANUSCRIPT_REVIEW_SCHEME = 'aria-manuscript-review';

/**
 * Editor input for reviewing a staged manuscript revision. `folderResource` is
 * the paper directory (`<workspace>/paper/<id>/`); the pane reads manuscript.md
 * (current) and manuscript.proposed.md (proposed) to render the diff.
 */
export class AriaManuscriptReviewInput extends EditorInput {

	static readonly ID = 'aria.paperWriter.reviewInput';
	static readonly EDITOR_ID = 'aria.paperWriter.reviewPane';

	private readonly _resource: URI;

	constructor(readonly folderResource: URI) {
		super();
		this._resource = URI.from({ scheme: ARIA_MANUSCRIPT_REVIEW_SCHEME, path: folderResource.path, query: folderResource.scheme });
	}

	override get typeId(): string {
		return AriaManuscriptReviewInput.ID;
	}

	override get editorId(): string | undefined {
		return AriaManuscriptReviewInput.EDITOR_ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return localize('aria.manuscriptReview.name', "Review: {0}", basename(this.folderResource) || 'manuscript');
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof AriaManuscriptReviewInput && isEqual(other.folderResource, this.folderResource);
	}
}
