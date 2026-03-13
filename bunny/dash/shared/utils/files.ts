export const makeFileNameSafe = (s: string) => {
  return s.replace(/[^a-z0-9\._]/gi, "-").toLowerCase();
};

export const isPathSafe = (absolutePath: string) => {
  // eg: /Users/yoav/colab/projectfolder
  // eg: /Users/yoav/code/projectfolder
  // todo (yoav): add more checks for system folders and handle leading slash
  if (absolutePath.split("/").length >= 4) {
    return true;
  }

  return false;
};
