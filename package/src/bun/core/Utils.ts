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
