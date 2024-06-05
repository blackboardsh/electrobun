import { zigRPC } from "../proc/zig";

// TODO: move this to a more appropriate namespace
export const moveToTrash = (path: string) => {
  return zigRPC.request.moveToTrash({ path });
};

export const showItemInFolder = (path: string) => {
  return zigRPC.request.showItemInFolder({ path });
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

  const result = await zigRPC.request.openFileDialog({
    startingFolder: optsWithDefault.startingFolder,
    allowedFileTypes: optsWithDefault.allowedFileTypes,
    canChooseFiles: optsWithDefault.canChooseFiles,
    canChooseDirectory: optsWithDefault.canChooseDirectory,
    allowsMultipleSelection: optsWithDefault.allowsMultipleSelection,
  });

  const filePaths = result.openFileDialogResponse.split(",");

  // todo: it's nested like this due to zig union types. needs a zig refactor and revisit
  return filePaths;
};
