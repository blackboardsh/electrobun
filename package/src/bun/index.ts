import electobunEventEmmitter from "./events/eventEmitter";
import { BrowserWindow } from "./core/BrowserWindow";
import { BrowserView } from "./core/BrowserView";
import { Tray } from "./core/Tray";
import * as ApplicationMenu from "./core/ApplicationMenu";
import * as ContextMenu from "./core/ContextMenu";
import { Updater } from "./core/Updater";
import * as Utils from "./core/Utils";
import type { MessageBoxOptions, MessageBoxResponse } from "./core/Utils";
import { type RPCSchema, createRPC } from "rpc-anywhere";
import type ElectrobunEvent from "./events/event";
import * as PATHS from "./core/Paths";
import * as Socket from "./core/Socket";
import type { ElectrobunConfig } from "./ElectrobunConfig";
import { GlobalShortcut, Screen, Session } from "./proc/native";
import type { Display, Rectangle, Point, Cookie, CookieFilter, StorageType } from "./proc/native";
import { BuildConfig, type BuildConfigType } from "./core/BuildConfig";

// Named Exports
export {
  type RPCSchema,
  type ElectrobunEvent,
  type ElectrobunConfig,
  type BuildConfigType,
  type MessageBoxOptions,
  type MessageBoxResponse,
  type Display,
  type Rectangle,
  type Point,
  type Cookie,
  type CookieFilter,
  type StorageType,
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
  GlobalShortcut,
  Screen,
  Session,
  BuildConfig,
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
  GlobalShortcut,
  Screen,
  Session,
  BuildConfig,
  events: electobunEventEmmitter,
  PATHS,
  Socket,
};

// Electrobun
export default Electrobun;
