import type { CarrotPermissionGrant } from "../carrot-runtime/types";
import { hasBunPermission } from "../carrot-runtime/types";

export function toBunWorkerPermissions(
  permissions: CarrotPermissionGrant,
): Bun.WorkerPermissions {
  return {
    read: hasBunPermission(permissions, "read"),
    write: hasBunPermission(permissions, "write"),
    env: hasBunPermission(permissions, "env"),
    run: hasBunPermission(permissions, "run"),
    ffi: hasBunPermission(permissions, "ffi"),
    addons: hasBunPermission(permissions, "addons"),
    worker: hasBunPermission(permissions, "worker"),
  };
}
