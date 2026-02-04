import { ffi, native } from "../proc/native";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { OS } from "../../shared/platform";

// TODO: move this to a more appropriate namespace
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

export const quit = () => {
	if (isQuitting) return;
	isQuitting = true;
	native.symbols.killApp();
	process.exit();
};

// Override process.exit so that calling it triggers proper native cleanup
const originalProcessExit = process.exit;
process.exit = ((code?: number) => {
	if (isQuitting) {
		originalProcessExit(code);
		return;
	}
	quit();
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

	// todo: extend the timeout for this one (this version of rpc-anywhere doesn't seem to be able to set custom timeouts per request)
	// we really want it to be infinity since the open file dialog blocks everything anyway.
	// todo: there's the timeout between bun and zig, and the timeout between browser and bun since user likely requests
	// from a browser context
	const result = await ffi.request.openFileDialog({
		startingFolder: optsWithDefault.startingFolder,
		allowedFileTypes: optsWithDefault.allowedFileTypes,
		canChooseFiles: optsWithDefault.canChooseFiles,
		canChooseDirectory: optsWithDefault.canChooseDirectory,
		allowsMultipleSelection: optsWithDefault.allowsMultipleSelection,
	});

	const filePaths = result.split(",");

	// todo: it's nested like this due to zig union types. needs a zig refactor and revisit
	return filePaths;
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

let _versionInfo: { identifier: string; channel: string } | undefined;
function getVersionInfo(): { identifier: string; channel: string } {
	if (_versionInfo) return _versionInfo;
	try {
		const resourcesDir = "Resources";
		const raw = readFileSync(join("..", resourcesDir, "version.json"), "utf-8");
		const parsed = JSON.parse(raw);
		_versionInfo = { identifier: parsed.identifier, channel: parsed.channel };
		return _versionInfo;
	} catch (error) {
		console.error("Failed to read version.json", error);
		throw error;
	}
}

function getAppDataDir(): string {
	switch (OS) {
		case "macos":
			return join(home, "Library", "Application Support");
		case "win":
			return process.env["LOCALAPPDATA"] || join(home, "AppData", "Local");
		case "linux":
			return process.env["XDG_DATA_HOME"] || join(home, ".local", "share");
	}
}

function getCacheDir(): string {
	switch (OS) {
		case "macos":
			return join(home, "Library", "Caches");
		case "win":
			return process.env["LOCALAPPDATA"] || join(home, "AppData", "Local");
		case "linux":
			return process.env["XDG_CACHE_HOME"] || join(home, ".cache");
	}
}

function getLogsDir(): string {
	switch (OS) {
		case "macos":
			return join(home, "Library", "Logs");
		case "win":
			return process.env["LOCALAPPDATA"] || join(home, "AppData", "Local");
		case "linux":
			return process.env["XDG_STATE_HOME"] || join(home, ".local", "state");
	}
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
		const { identifier, channel } = getVersionInfo();
		return join(getAppDataDir(), identifier, channel);
	},
	get userCache(): string {
		const { identifier, channel } = getVersionInfo();
		return join(getCacheDir(), identifier, channel);
	},
	get userLogs(): string {
		const { identifier, channel } = getVersionInfo();
		return join(getLogsDir(), identifier, channel);
	},
};
