import { ffi, native } from "../proc/native";

// TODO: move this to a more appropriate namespace
export const moveToTrash = (path: string) => {
  return ffi.request.moveToTrash({ path });
};

export const showItemInFolder = (path: string) => {
  return ffi.request.showItemInFolder({ path });
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
  } = {}
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
  opts: MessageBoxOptions = {}
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
