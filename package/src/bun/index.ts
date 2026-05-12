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
import { RESOURCES_FOLDER, VIEWS_FOLDER } from "./core/Paths";
import * as Socket from "./core/Socket";
import WGPU from "./webGPU";
import webgpu from "./webgpuAdapter";
import * as three from "three";
import * as babylon from "@babylonjs/core";
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
import { bridge, hasFFI } from "./proc/native";

// Carrot boot state — populated from __bunnyCarrotBootstrap injected by Bunny Ears
let _carrotManifest: Record<string, unknown> | null = null;
let _carrotContext: { currentDir?: string; statePath?: string; logsPath?: string; permissions?: string[]; grantedPermissions?: Record<string, unknown>; authToken?: string | null; channel?: string } | null = null;

const _bootstrap = (globalThis as any).__bunnyCarrotBootstrap as { manifest?: any; context?: any } | undefined;
if (_bootstrap) {
	_carrotManifest = _bootstrap.manifest ?? null;
	_carrotContext = _bootstrap.context ?? null;
}

if (bridge) {
	bridge.on("init", (payload: any) => {
		if (payload?.manifest) _carrotManifest = payload.manifest;
		if (payload?.context) _carrotContext = payload.context;
	});

	// Forward host events to the local event emitter so ApplicationMenu.on(),
	// ContextMenu.on(), etc. work in carrot workers
	for (const eventName of ["application-menu-clicked", "context-menu-clicked"]) {
		bridge.on(eventName, (payload: unknown) => {
			electobunEventEmmitter.emitEvent({ type: eventName, data: payload } as any);
		});
	}

	// Update local auth token when the host notifies of a change (e.g., Farm login)
	bridge.on("auth-token-changed", (payload: unknown) => {
		const token = (payload as any)?.token;
		if (token && _carrotContext) {
			_carrotContext.authToken = token;
		}
	});

	// Clear local auth token on logout
	bridge.on("auth-token-cleared", () => {
		if (_carrotContext) {
			_carrotContext.authToken = null;
		}
	});
}

export const Carrots = {
	async invoke<T = unknown>(
		carrotId: string,
		method: string,
		params?: unknown,
		options?: { windowId?: string },
	): Promise<T> {
		if (!bridge) throw new Error("Carrots.invoke() is only available when running as a carrot inside Bunny Ears");
		return bridge.requestHost<T>("invoke-carrot", { carrotId, method, params, windowId: options?.windowId });
	},
	emit(carrotId: string, name: string, payload?: unknown) {
		if (!bridge) throw new Error("Carrots.emit() is only available when running as a carrot inside Bunny Ears");
		bridge.sendAction("emit-carrot-event", { carrotId, name, payload });
	},
	async list() {
		if (!bridge) throw new Error("Carrots.list() is only available when running as a carrot inside Bunny Ears");
		return bridge.requestHost<Array<{
			id: string; name: string; description: string; version: string;
			mode: string; permissions: string[]; status: string; devMode: boolean;
		}>>("list-carrots");
	},
	async start(carrotId: string) {
		if (!bridge) throw new Error("Carrots.start() is only available when running as a carrot inside Bunny Ears");
		return bridge.requestHost<{ ok: boolean }>("start-carrot", { id: carrotId });
	},
	async stop(carrotId: string) {
		if (!bridge) throw new Error("Carrots.stop() is only available when running as a carrot inside Bunny Ears");
		return bridge.requestHost<{ ok: boolean }>("stop-carrot", { id: carrotId });
	},
};

export const app = {
	on(name: string, handler: (payload: unknown) => void) {
		if (bridge) {
			return bridge.on(name, handler);
		}
		electobunEventEmmitter.on(name, (e: { data: unknown }) => handler(e.data));
		return () => {};
	},
	quit() {
		Utils.quit();
	},
	get isCarrotMode() {
		return !hasFFI;
	},
	get manifest() {
		return _carrotManifest;
	},
	get permissions() {
		return _carrotContext?.permissions ?? [];
	},
	get grantedPermissions() {
		return _carrotContext?.grantedPermissions ?? {};
	},
	get currentDir() {
		return _carrotContext?.currentDir ?? "";
	},
	get statePath() {
		return _carrotContext?.statePath ?? "";
	},
	get logsPath() {
		return _carrotContext?.logsPath ?? "";
	},
	get authToken() {
		return _carrotContext?.authToken ?? null;
	},
	async fetchAuthToken(): Promise<string | null> {
		if (!bridge) return null;
		const result = await bridge.requestHost<{ token: string | null }>("get-auth-token");
		if (result?.token && _carrotContext) {
			_carrotContext.authToken = result.token;
		}
		return result?.token ?? null;
	},
	async setAuthToken(token: string): Promise<void> {
		if (!bridge) return;
		await bridge.requestHost("set-auth-token", { token });
		if (_carrotContext) {
			_carrotContext.authToken = token;
		}
	},
	get channel() {
		return _carrotContext?.channel ?? "";
	},
	openManager() {
		if (bridge) bridge.sendAction("open-manager");
	},
	openBunnyWindow(payload?: { screenX?: number; screenY?: number }) {
		if (bridge) bridge.sendAction("open-bunny-window", payload);
	},
	async getWindowFrame(windowId?: string) {
		if (!bridge) return null;
		return bridge.requestHost<{ x: number; y: number; width: number; height: number } | null>("window-get-frame", { windowId });
	},
};

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
	RESOURCES_FOLDER,
	VIEWS_FOLDER,
	Socket,
	WGPU,
	webgpu,
	three,
	babylon,
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
	RESOURCES_FOLDER,
	VIEWS_FOLDER,
	Socket,
	WGPU,
	webgpu,
	three,
	babylon,
};

// Electrobun
export default Electrobun;
