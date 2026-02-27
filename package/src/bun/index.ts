import electobunEventEmmitter from "./events/eventEmitter";
import { BrowserWindow, type WindowOptionsType } from "./core/BrowserWindow";
import { BrowserView, type BrowserViewOptions } from "./core/BrowserView";
import { GpuWindow, type GpuWindowOptionsType } from "./core/GpuWindow";
import { WGPUView, type WGPUViewOptions } from "./core/WGPUView";
import { Tray, type TrayOptions } from "./core/Tray";
import * as ApplicationMenu from "./core/ApplicationMenu";
import * as ContextMenu from "./core/ContextMenu";
import {
	Updater,
	type UpdateStatusType,
	type UpdateStatusEntry,
	type UpdateStatusDetails,
} from "./core/Updater";
import * as Utils from "./core/Utils";
import type {
	MessageBoxOptions,
	MessageBoxResponse,
	NotificationOptions,
} from "./core/Utils";
import {
	type RPCSchema,
	type ElectrobunRPCSchema,
	createRPC,
	defineElectrobunRPC,
} from "../shared/rpc.js";
import type ElectrobunEvent from "./events/event";
import * as PATHS from "./core/Paths";
import * as Socket from "./core/Socket";
import WGPU from "./webGPU";
import type { ElectrobunConfig } from "./ElectrobunConfig";
import { GlobalShortcut, Screen, Session, WGPUBridge } from "./proc/native";
import type {
	Display,
	Rectangle,
	Point,
	Cookie,
	CookieFilter,
	StorageType,
	MenuItemConfig,
	ApplicationMenuItemConfig,
} from "./proc/native";
import { BuildConfig, type BuildConfigType } from "./core/BuildConfig";

// Named Exports
export {
	type RPCSchema,
	type ElectrobunRPCSchema,
	type ElectrobunEvent,
	type ElectrobunConfig,
	type BuildConfigType,
	type WindowOptionsType,
	type BrowserViewOptions,
	type GpuWindowOptionsType,
	type WGPUViewOptions,
	type TrayOptions,
	type MessageBoxOptions,
	type MessageBoxResponse,
	type NotificationOptions,
	type MenuItemConfig,
	type ApplicationMenuItemConfig,
	type Display,
	type Rectangle,
	type Point,
	type Cookie,
	type CookieFilter,
	type StorageType,
	type UpdateStatusType,
	type UpdateStatusEntry,
	type UpdateStatusDetails,
	createRPC,
	defineElectrobunRPC,
	BrowserWindow,
	BrowserView,
	GpuWindow,
	WGPUView,
	Tray,
	Updater,
	Utils,
	ApplicationMenu,
	ContextMenu,
	PATHS,
	Socket,
	WGPU,
	GlobalShortcut,
	Screen,
	Session,
	WGPUBridge,
	BuildConfig,
};

// Default Export
const Electrobun = {
	BrowserWindow,
	BrowserView,
	GpuWindow,
	WGPUView,
	Tray,
	Updater,
	Utils,
	ApplicationMenu,
	ContextMenu,
	GlobalShortcut,
	Screen,
	Session,
	WGPUBridge,
	BuildConfig,
	events: electobunEventEmmitter,
	PATHS,
	Socket,
	WGPU,
};

// Electrobun
export default Electrobun;
