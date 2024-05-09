import electobunEventEmmitter from "./events/eventEmitter";
import { BrowserWindow } from "./core/BrowserWindow";
import { BrowserView } from "./core/BrowserView";
import { Updater } from "./core/Updater";
import * as Utils from "./core/Utils";
import { type RPCSchema, createRPC } from "rpc-anywhere";

// Named Exports
export {
  type RPCSchema,
  createRPC,
  BrowserWindow,
  BrowserView,
  Updater,
  Utils,
};

// Default Export
const Electrobun = {
  BrowserWindow,
  BrowserView,
  Updater,
  Utils,
  events: electobunEventEmmitter,
};

// Electrobun
export default Electrobun;
