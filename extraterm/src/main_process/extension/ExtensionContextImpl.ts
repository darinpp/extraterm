/*
 * Copyright 2018 Simon Edwards <simon@simonzone.com>
 *
 * This source code is licensed under the MIT license which is detailed in the LICENSE.txt file.
 */
import * as ExtensionApi from '@extraterm/extraterm-extension-api';
import * as _ from 'lodash';

import { getLogger } from "extraterm-logging";
import { ExtensionMetadata } from "../../ExtensionMetadata";
import { ExtensionContext } from "@extraterm/extraterm-extension-api";
import { log } from "extraterm-logging";
import { ApplicationImpl } from "./ApplicationImpl";
import { BackendImpl } from "./BackendImpl";
import { InternalBackend, MainInternalExtensionContext } from './ExtensionManagerTypes';


export class ExtensionContextImpl implements MainInternalExtensionContext {

  application: ApplicationImpl = null;

  get commands(): never {
    this.logger.warn("'ExtensionContext.commands' is only available from a window process, not the main process.");
    throw Error("'ExtensionContext.commands' is only available from a window process, not the main process.");
  }

  logger: ExtensionApi.Logger = null;
  isBackendProcess = true;
  backend: ExtensionApi.Backend = null;
  _internalBackend: InternalBackend;
  extensionPath: string = null;

  constructor(public __extensionMetadata: ExtensionMetadata) {
    this.logger = getLogger("[Main]" + this.__extensionMetadata.name);
    this.extensionPath = this.__extensionMetadata.path;
    this.application = new ApplicationImpl();
    this._internalBackend = new BackendImpl(this.__extensionMetadata);
    this.backend = this._internalBackend;
  }

  get window(): never {
    this.logger.warn("'ExtensionContext.window' is only available from a window process, not the main process.");
    throw Error("'ExtensionContext.window' is only available from a window process, not the main process.");
  }

  get aceModule(): never {
    this.logger.warn("'ExtensionContext.aceModule' is only available from a window process, not the main process.");
    throw Error("'ExtensionContext.aceModule' is only available from a window process, not the main process.");
  }
}
