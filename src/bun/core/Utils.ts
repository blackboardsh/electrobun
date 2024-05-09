import { zigRPC } from "../proc/zig";

// TODO: move this to a more appropriate namespace
export const moveToTrash = (path: string) => {
  return zigRPC.request.moveToTrash({ path });
};
