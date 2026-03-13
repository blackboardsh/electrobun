import {
  type CachedFileType,
  type PreviewFileTreeType,
} from "../../shared/types/types";
import { dirname } from "./pathUtils";

export const parentNodePath = (node: CachedFileType | PreviewFileTreeType) => {
  // Note: this is used while editing a node. can think of node.name as being
  // the input value renaming the file/folder. the path is also kept up to date
  // if it's empty then treat the whole node.path as the parent path
  if (node.name) {
    return dirname(node.path);
  }
  return node.path;
};
