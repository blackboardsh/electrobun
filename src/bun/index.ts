import electobunEventEmmitter from "./events/eventEmitter";
import { BrowserWindow } from "./core/BrowserWindow";
import { BrowserView } from "./core/BrowserView";
import { Tray } from "./core/Tray";
import * as ApplicationMenu from "./core/ApplicationMenu";
import { Updater } from "./core/Updater";
import * as Utils from "./core/Utils";
import { type RPCSchema, createRPC } from "rpc-anywhere";

// Named Exports
export {
  type RPCSchema,
  createRPC,
  BrowserWindow,
  BrowserView,
  Tray,
  Updater,
  Utils,
  ApplicationMenu,
};

// Default Export
const Electrobun = {
  BrowserWindow,
  BrowserView,
  Tray,
  Updater,
  Utils,
  ApplicationMenu,
  events: electobunEventEmmitter,
};

// Electrobun
export default Electrobun;
