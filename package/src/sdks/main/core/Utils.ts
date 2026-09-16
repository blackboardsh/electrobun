import { ffi, native } from "../proc/native";
import { electrobunEventEmitter } from "../events/eventEmitter";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { OS, type SupportedOS } from "../../../shared/platform";
import { decodeDialogPaths } from "../../../shared/dialog-paths";
import { isBuildEnvironment } from "../../../shared/naming";

export const moveToTrash = (path: string) => {
	return ffi.request.moveToTrash({ path });
};

export const showItemInFolder = (path: string) => {
	return ffi.request.showItemInFolder({ path });
};

/**
 * Open a URL in the default browser or appropriate application.
 * Works with http/https URLs, mailto: links, custom URL schemes, etc.
 *
 * @param url - The URL to open (e.g., "https://example.com", "mailto:test@example.com")
 * @returns true if the URL was opened successfully, false otherwise
 *
 * @example
 * // Open a website
 * openExternal("https://example.com");
 *
 * // Open an email
 * openExternal("mailto:support@example.com?subject=Help");
 *
 * // Open a custom URL scheme
 * openExternal("slack://open");
 */
export const openExternal = (url: string): boolean => {
	return ffi.request.openExternal({ url });
};

/**
 * Open a file or folder with the default application.
 * For files, opens with the associated application (e.g., .pdf with PDF reader).
 * For folders, opens in the file manager.
 *
 * @param path - The absolute path to the file or folder
 * @returns true if the path was opened successfully, false otherwise
 *
 * @example
 * // Open a document with default app
 * openPath("/Users/me/Documents/report.pdf");
 *
 * // Open a folder in file manager
 * openPath("/Users/me/Downloads");
 */
export const openPath = (path: string): boolean => {
	return ffi.request.openPath({ path });
};

export const setDockIconVisible = (visible: boolean): void => {
	ffi.request.setDockIconVisible({ visible });
};

export const isDockIconVisible = (): boolean => {
	return ffi.request.isDockIconVisible();
};

export type NotificationOptions = {
	/**
	 * The title of the notification (required)
	 */
	title: string;
	/**
	 * The main body text of the notification
	 */
	body?: string;
	/**
	 * A subtitle displayed below the title (macOS only, shown as additional line on other platforms)
	 */
	subtitle?: string;
	/**
	 * If true, the notification will not play a sound
	 */
	silent?: boolean;
};

/**
 * Show a native desktop notification.
 *
 * @param options - Notification options
 * @param options.title - The title of the notification (required)
 * @param options.body - The main body text
 * @param options.subtitle - A subtitle (macOS shows this between title and body)
 * @param options.silent - If true, no sound will be played
 *
 * @example
 * // Simple notification
 * showNotification({ title: "Download Complete" });
 *
 * // Notification with body
 * showNotification({
 *   title: "New Message",
 *   body: "You have a new message from John"
 * });
 *
 * // Full notification
 * showNotification({
 *   title: "Reminder",
 *   subtitle: "Calendar Event",
 *   body: "Team meeting in 15 minutes",
 *   silent: false
 * });
 *
 * // Silent notification
 * showNotification({
 *   title: "Sync Complete",
 *   body: "All files have been synchronized",
 *   silent: true
 * });
 */
export const showNotification = (options: NotificationOptions): void => {
	const { title, body, subtitle, silent } = options;
	ffi.request.showNotification({ title, body, subtitle, silent });
};

let isQuitting = false;
const quitApprovalBrand = Symbol("ElectrobunQuitApproval");

export interface QuitApproval {
	readonly [quitApprovalBrand]: true;
}

let activeQuitApproval: QuitApproval | null = null;

/** Ask before-quit handlers once, without starting native shutdown yet. */
export const requestQuitApproval = (): QuitApproval | null => {
	if (isQuitting || activeQuitApproval) return null;

	const approval = Object.freeze({
		[quitApprovalBrand]: true as const,
	});
	activeQuitApproval = approval;

	let beforeQuitEvent: ReturnType<
		typeof electrobunEventEmitter.events.app.beforeQuit
	>;
	try {
		beforeQuitEvent = electrobunEventEmitter.events.app.beforeQuit({});
		electrobunEventEmitter.emitEvent(beforeQuitEvent);
	} catch (error) {
		activeQuitApproval = null;
		throw error;
	}

	if (
		beforeQuitEvent.responseWasSet &&
		beforeQuitEvent.response?.allow === false
	) {
		activeQuitApproval = null;
		return null;
	}

	return approval;
};

/** Release a reserved approval when arming a post-exit action fails. */
export const cancelQuitApproval = (approval: QuitApproval): void => {
	if (activeQuitApproval === approval) activeQuitApproval = null;
};

/** Begin shutdown using a previously-approved request without a second veto. */
export const quitAfterApproval = (
	approval: QuitApproval,
	code = 0,
): void => {
	if (activeQuitApproval !== approval) {
		throw new Error("Invalid or expired quit approval");
	}
	activeQuitApproval = null;
	isQuitting = true;
	try {
		if (native) {
			ffi.request.quitGracefully({ code, timeoutMs: 5000 });
		} else {
			process.exit(code);
		}
	} catch (error) {
		isQuitting = false;
		throw error;
	}
};

export const quit = (code = 0): boolean => {
	const approval = requestQuitApproval();
	if (!approval) return false;
	quitAfterApproval(approval, code);
	return true;
};

// Override process.exit so that calling it triggers proper native cleanup
const _originalProcessExit = process.exit;
process.exit = ((code?: number) => {
	if (native) {
		if (isQuitting) {
			ffi.request.quitGracefully({ code: code ?? 0, timeoutMs: 0 });
			return;
		}
		quit(code ?? 0);
	} else {
		_originalProcessExit(code ?? 0);
	}
}) as typeof process.exit;

export const openFileDialog = async (
	opts: {
		startingFolder?: string;
		allowedFileTypes?: string;
		canChooseFiles?: boolean;
		canChooseDirectory?: boolean;
		allowsMultipleSelection?: boolean;
	} = {},
): Promise<string[]> => {
	const optsWithDefault = {
		...{
			startingFolder: "~/",
			allowedFileTypes: "*",
			canChooseFiles: true,
			canChooseDirectory: true,
			allowsMultipleSelection: true,
		},
		...opts,
	};

	const result = await ffi.request.openFileDialog({
		startingFolder: optsWithDefault.startingFolder,
		allowedFileTypes: optsWithDefault.allowedFileTypes,
		canChooseFiles: optsWithDefault.canChooseFiles,
		canChooseDirectory: optsWithDefault.canChooseDirectory,
		allowsMultipleSelection: optsWithDefault.allowsMultipleSelection,
	});

	return decodeDialogPaths(result);
};

export type MessageBoxOptions = {
	type?: "info" | "warning" | "error" | "question";
	title?: string;
	message?: string;
	detail?: string;
	buttons?: string[];
	defaultId?: number;
	cancelId?: number;
};

export type MessageBoxResponse = {
	response: number; // Index of the clicked button
};

/**
 * Shows a message box dialog and returns which button was clicked.
 * Similar to Electron's dialog.showMessageBox()
 *
 * @param opts - Options for the message box
 * @param opts.type - The type of dialog: "info", "warning", "error", or "question"
 * @param opts.title - The title of the dialog window
 * @param opts.message - The main message to display
 * @param opts.detail - Additional detail text (displayed smaller on some platforms)
 * @param opts.buttons - Array of button labels (e.g., ["OK", "Cancel"])
 * @param opts.defaultId - Index of the default button (focused on open)
 * @param opts.cancelId - Index of the button to trigger on Escape key or dialog close
 * @returns Promise resolving to an object with `response` (0-based button index clicked)
 *
 * @example
 * const { response } = await showMessageBox({
 *   type: "question",
 *   title: "Confirm",
 *   message: "Are you sure you want to delete this file?",
 *   buttons: ["Delete", "Cancel"],
 *   defaultId: 1,
 *   cancelId: 1
 * });
 * if (response === 0) {
 *   // User clicked Delete
 * }
 */
export const showMessageBox = async (
	opts: MessageBoxOptions = {},
): Promise<MessageBoxResponse> => {
	const {
		type = "info",
		title = "",
		message = "",
		detail = "",
		buttons = ["OK"],
		defaultId = 0,
		cancelId = -1,
	} = opts;

	const response = ffi.request.showMessageBox({
		type,
		title,
		message,
		detail,
		buttons,
		defaultId,
		cancelId,
	});

	return { response };
};

// ============================================================================
// Clipboard API
// ============================================================================

/**
 * Read text from the system clipboard.
 * @returns The clipboard text, or null if no text is available
 */
export const clipboardReadText = (): string | null => {
	return ffi.request.clipboardReadText();
};

/**
 * Write text to the system clipboard.
 * @param text - The text to write to the clipboard
 */
export const clipboardWriteText = (text: string): void => {
	ffi.request.clipboardWriteText({ text });
};

// Screen Recording permission (macOS). Both calls are struct-free, so they
// go straight to CoreGraphics; on other platforms they report granted.
const coreGraphics = (() => {
	if (OS !== "macos") return null;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { dlopen, FFIType } = require("bun:ffi");
		return dlopen(
			"/System/Library/Frameworks/CoreGraphics.framework/Versions/A/CoreGraphics",
			{
				CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool },
				CGRequestScreenCaptureAccess: { args: [], returns: FFIType.bool },
			},
		);
	} catch {
		return null;
	}
})();

export const screenCapture = {
	/** Whether the app currently has Screen Recording permission. */
	hasAccess(): boolean {
		if (OS !== "macos") return true;
		return coreGraphics
			? Boolean(coreGraphics.symbols.CGPreflightScreenCaptureAccess())
			: false;
	},
	/**
	 * Ask macOS for Screen Recording permission. Shows the system prompt the
	 * first time; afterwards the user must grant it in System Settings →
	 * Privacy & Security → Screen Recording (and relaunch the app).
	 */
	requestAccess(): boolean {
		if (OS !== "macos") return true;
		return coreGraphics
			? Boolean(coreGraphics.symbols.CGRequestScreenCaptureAccess())
			: false;
	},
	/** Open the Screen Recording pane of System Settings (macOS). */
	openSettings(): void {
		if (OS !== "macos") return;
		Bun.spawn([
			"open",
			"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
		]);
	},
};

/**
 * Read image from the system clipboard as PNG data.
 * @returns PNG image data as Uint8Array, or null if no image is available
 */
export const clipboardReadImage = (): Uint8Array | null => {
	return ffi.request.clipboardReadImage();
};

/**
 * Write PNG image data to the system clipboard.
 * @param pngData - PNG image data as Uint8Array
 */
export const clipboardWriteImage = (pngData: Uint8Array): void => {
	ffi.request.clipboardWriteImage({ pngData });
};

/**
 * Clear the system clipboard.
 */
export const clipboardClear = (): void => {
	ffi.request.clipboardClear();
};

/**
 * Get the available formats in the clipboard.
 * @returns Array of format names (e.g., ["text", "image", "files", "html"])
 */
export const clipboardAvailableFormats = (): string[] => {
	return ffi.request.clipboardAvailableFormats();
};

// ============================================================================
// Paths API — cross-platform OS directories and app-scoped directories
// ============================================================================

const home = homedir();

function getLinuxXdgUserDirs(): Record<string, string> {
	try {
		const content = readFileSync(
			join(home, ".config", "user-dirs.dirs"),
			"utf-8",
		);
		const dirs: Record<string, string> = {};
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
			const eqIdx = trimmed.indexOf("=");
			const key = trimmed.slice(0, eqIdx);
			let value = trimmed.slice(eqIdx + 1);
			// Strip surrounding quotes
			if (value.startsWith('"') && value.endsWith('"')) {
				value = value.slice(1, -1);
			}
			// Substitute $HOME
			value = value.replace(/\$HOME/g, home);
			dirs[key] = value;
		}
		return dirs;
	} catch {
		return {};
	}
}

let _xdgUserDirs: Record<string, string> | undefined;
function xdgUserDir(key: string, fallbackName: string): string {
	if (OS !== "linux") return "";
	if (!_xdgUserDirs) _xdgUserDirs = getLinuxXdgUserDirs();
	return _xdgUserDirs[key] || join(home, fallbackName);
}

interface RuntimeVersionInfo {
	identifier: string;
	channel: string;
	version?: string;
	hash?: string;
	name?: string;
	displayName?: string;
}

let _versionInfo: RuntimeVersionInfo | undefined;
function getVersionInfo(): RuntimeVersionInfo {
	if (_versionInfo) return _versionInfo;
	try {
		const resourcesDir = "Resources";
		const raw = readFileSync(join("..", resourcesDir, "version.json"), "utf-8");
		const parsed = JSON.parse(raw);
		_versionInfo = {
			identifier: parsed.identifier,
			channel: parsed.channel,
			version: parsed.version,
			hash: parsed.hash,
			name: parsed.name,
			displayName: parsed.displayName,
		};
		return _versionInfo;
	} catch (error) {
		console.error("Failed to read version.json", error);
		_versionInfo = { identifier: "", channel: "" };
		return _versionInfo;
	}
}

function safeManagedRootName(value: unknown, platform: SupportedOS): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 256 ||
		value === "." ||
		value === ".."
	) {
		return false;
	}
	return platform === "win"
		? !/[\u0000-\u001f"%*/:<>?\\|]/.test(value) && !/[ .]$/.test(value)
		: !/[\u0000-\u001f\u007f/\\]/.test(value);
}

function isRegularManagedFile(path: string): boolean {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	return Boolean(stat?.isFile() && !stat.isSymbolicLink());
}

/** Resolve the physical v1/v2 root leaf used by app-scoped data paths. */
export function resolveInstalledRootNameForPaths(
	info: RuntimeVersionInfo,
	platform: SupportedOS,
	executablePath: string,
	appDataRoot: string,
	regularFileProbe: (path: string) => boolean = isRegularManagedFile,
): string {
	if (
		!safeManagedRootName(info.identifier, platform) ||
		!safeManagedRootName(info.channel, platform) ||
		!isBuildEnvironment(info.channel)
	) {
		return "";
	}
	const pathApi = platform === "win" ? win32 : posix;
	const identifierRoot = pathApi.resolve(pathApi.join(appDataRoot, info.identifier));
	if (platform !== "macos") {
		const derivedRoot = pathApi.resolve(
			pathApi.dirname(executablePath),
			"..",
			"..",
		);
		const derivedParent = pathApi.resolve(pathApi.dirname(derivedRoot));
		const parentMatches =
			platform === "win"
				? derivedParent.toLowerCase() === identifierRoot.toLowerCase()
				: derivedParent === identifierRoot;
		const derivedName = pathApi.basename(derivedRoot);
		if (parentMatches && safeManagedRootName(derivedName, platform)) {
			return derivedName;
		}
		return info.channel;
	}

	const candidateNames: string[] = [info.channel];
	if (safeManagedRootName(info.name, "macos")) candidateNames.push(info.name);
	if (safeManagedRootName(info.displayName, "macos")) {
		candidateNames.push(
			info.channel === "stable"
				? info.displayName
				: `${info.displayName}-${info.channel}`,
		);
	}
	const candidates = [...new Set(candidateNames)].filter((name) =>
		safeManagedRootName(name, "macos"),
	);
	if (typeof info.hash === "string" && /^[a-z0-9]{1,13}$/.test(info.hash)) {
		const retainedRoot = candidates.find((name) =>
			regularFileProbe(
				pathApi.join(identifierRoot, name, "self-extraction", `${info.hash}.tar`),
			),
		);
		if (retainedRoot) return retainedRoot;
	}
	const manifestRoot = candidates.find((name) =>
		regularFileProbe(pathApi.join(identifierRoot, name, ".electrobun-uninstall.json")),
	);
	return manifestRoot ?? info.channel;
}

function getInstalledRootName(): string {
	const info = getVersionInfo();
	const launcherRootName = process.env["ELECTROBUN_INSTALL_ROOT_NAME"];
	if (safeManagedRootName(launcherRootName, OS)) return launcherRootName;
	return resolveInstalledRootNameForPaths(
		info,
		OS,
		process.execPath,
		getAppDataDir(),
	);
}

function getAppDataDir(): string {
	switch (OS) {
		case "macos":
			return join(home, "Library", "Application Support");
		case "win":
			return process.env["LOCALAPPDATA"] || join(home, "AppData", "Local");
		case "linux":
			return getLinuxXdgRoot(
				"XDG_DATA_HOME",
				join(home, ".local", "share"),
			);
	}
}

function getCacheDir(): string {
	switch (OS) {
		case "macos":
			return join(home, "Library", "Caches");
		case "win":
			return process.env["LOCALAPPDATA"] || join(home, "AppData", "Local");
		case "linux":
			return getLinuxXdgRoot("XDG_CACHE_HOME", join(home, ".cache"));
	}
}

function getLogsDir(): string {
	switch (OS) {
		case "macos":
			return join(home, "Library", "Logs");
		case "win":
			return process.env["LOCALAPPDATA"] || join(home, "AppData", "Local");
		case "linux":
			return getLinuxXdgRoot(
				"XDG_STATE_HOME",
				join(home, ".local", "state"),
			);
	}
}

function getLinuxXdgRoot(variable: string, fallback: string): string {
	const value = process.env[variable];
	if (!value || !isAbsolute(value)) return fallback;
	const normalized = resolve(value);
	return normalized === "/" ? fallback : normalized;
}

function getConfigDir(): string {
	switch (OS) {
		case "macos":
			return join(home, "Library", "Application Support");
		case "win":
			return process.env["APPDATA"] || join(home, "AppData", "Roaming");
		case "linux":
			return process.env["XDG_CONFIG_HOME"] || join(home, ".config");
	}
}

function getUserDir(
	macName: string,
	winName: string,
	xdgKey: string,
	fallbackName: string,
): string {
	switch (OS) {
		case "macos":
			return join(home, macName);
		case "win": {
			const userProfile = process.env["USERPROFILE"] || home;
			return join(userProfile, winName);
		}
		case "linux":
			return xdgUserDir(xdgKey, fallbackName);
	}
}

export const paths = {
	get home(): string {
		return home;
	},
	get appData(): string {
		return getAppDataDir();
	},
	get config(): string {
		return getConfigDir();
	},
	get cache(): string {
		return getCacheDir();
	},
	get temp(): string {
		return tmpdir();
	},
	get logs(): string {
		return getLogsDir();
	},
	get documents(): string {
		return getUserDir(
			"Documents",
			"Documents",
			"XDG_DOCUMENTS_DIR",
			"Documents",
		);
	},
	get downloads(): string {
		return getUserDir(
			"Downloads",
			"Downloads",
			"XDG_DOWNLOAD_DIR",
			"Downloads",
		);
	},
	get desktop(): string {
		return getUserDir("Desktop", "Desktop", "XDG_DESKTOP_DIR", "Desktop");
	},
	get pictures(): string {
		return getUserDir("Pictures", "Pictures", "XDG_PICTURES_DIR", "Pictures");
	},
	get music(): string {
		return getUserDir("Music", "Music", "XDG_MUSIC_DIR", "Music");
	},
	get videos(): string {
		return getUserDir("Movies", "Videos", "XDG_VIDEOS_DIR", "Videos");
	},
	get userData(): string {
		const { identifier } = getVersionInfo();
		return join(getAppDataDir(), identifier, getInstalledRootName());
	},
	get userCache(): string {
		const { identifier } = getVersionInfo();
		return join(getCacheDir(), identifier, getInstalledRootName());
	},
	get userLogs(): string {
		const { identifier } = getVersionInfo();
		return join(getLogsDir(), identifier, getInstalledRootName());
	},
};
