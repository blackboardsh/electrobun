import electobunEventEmmitter from "./events/eventEmitter";
import { BrowserWindow } from "./core/BrowserWindow";
import { BrowserView } from "./core/BrowserView";
import { Tray } from "./core/Tray";
import * as ApplicationMenu from "./core/ApplicationMenu";
import * as ContextMenu from "./core/ContextMenu";
import { Updater } from "./core/Updater";
import * as Utils from "./core/Utils";
import { type RPCSchema, createRPC } from "rpc-anywhere";
import type ElectrobunEvent from "./events/event";
import * as PATHS from "./core/Paths";
import * as Socket from "./core/Socket";
import type { ElectrobunConfig } from "./ElectrobunConfig";

// Named Exports
export {
  type RPCSchema,
  type ElectrobunEvent,
  type ElectrobunConfig,
  createRPC,
  BrowserWindow,
  BrowserView,
  Tray,
  Updater,
  Utils,
  ApplicationMenu,
  ContextMenu,
  PATHS,
  Socket,
};

// Default Export
const Electrobun = {
  BrowserWindow,
  BrowserView,
  Tray,
  Updater,
  Utils,
  ApplicationMenu,
  ContextMenu,
  events: electobunEventEmmitter,
  PATHS,
  Socket,
};

// Electrobun
export default Electrobun;
