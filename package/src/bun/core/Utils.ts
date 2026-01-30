import { ffi, native } from "../proc/native";

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

export const quit = () => {
	// Use native killApp for graceful shutdown
	native.symbols.killApp();
};

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
