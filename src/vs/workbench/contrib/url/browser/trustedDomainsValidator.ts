/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas, matchesScheme } from '../../../../base/common/network.js';
import Severity from '../../../../base/common/severity.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService, OpenOptions } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITrustedDomainService } from './trustedDomainService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

export class OpenerValidatorContributions implements IWorkbenchContribution {

	constructor(
		@IOpenerService private readonly _openerService: IOpenerService,
		@IStorageService private readonly _storageService: IStorageService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IProductService private readonly _productService: IProductService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IEditorService private readonly _editorService: IEditorService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IWorkspaceTrustManagementService private readonly _workspaceTrustService: IWorkspaceTrustManagementService,
		@ITrustedDomainService private readonly _trustedDomainService: ITrustedDomainService,
	) {
		this._openerService.registerValidator({ shouldOpen: (uri, options) => this.validateLink(uri, options) });
	}

	async validateLink(resource: URI | string, openOptions?: OpenOptions): Promise<boolean> {
		if (!matchesScheme(resource, Schemas.http) && !matchesScheme(resource, Schemas.https)) {
			return true;
		}

		if (openOptions?.fromWorkspace && this._workspaceTrustService.isWorkspaceTrusted() && !this._configurationService.getValue('workbench.trustedDomains.promptInTrustedWorkspace')) {
			return true;
		}

		let resourceUri: URI;
		if (typeof resource === 'string') {
			resourceUri = URI.parse(resource);
		} else {
			resourceUri = resource;
		}

		if (this._trustedDomainService.isValid(resourceUri)) {
			return true;
		} else {

			// Qoka: show only the plain question — the raw URL line is intentionally
			// omitted (no `detail`) so the dialog stays clean.
			const { result } = await this._dialogService.prompt<boolean>({
				type: Severity.Info,
				message: localize(
					'openExternalLinkAt',
					'Do you want {0} to open the external website?',
					this._productService.nameShort
				),
				buttons: [
					{
						label: localize({ key: 'open', comment: ['&& denotes a mnemonic'] }, '&&Open'),
						run: () => true
					}
				],
				cancelButton: {
					run: () => false
				}
			});

			return result;
		}
	}
}
