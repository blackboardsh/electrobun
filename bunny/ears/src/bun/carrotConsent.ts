import type {
  BunPermission,
  CarrotPermissionConsentRequest,
  CarrotPermissionGrant,
  CarrotPermissionTag,
  CarrotIsolation,
  HostPermission,
} from "../carrot-runtime/types";
import {
  flattenCarrotPermissions,
  normalizeCarrotPermissions,
} from "../carrot-runtime/types";
import type { PreparedCarrotInstall } from "./carrotStore";

type PermissionConsentPlan = {
  grantedPermissions: CarrotPermissionGrant;
  request: CarrotPermissionConsentRequest | null;
};

const HOST_PERMISSION_ORDER: HostPermission[] = [
  "windows",
  "tray",
  "notifications",
  "storage",
];
const BUN_PERMISSION_ORDER: BunPermission[] = [
  "read",
  "write",
  "env",
  "run",
  "ffi",
  "addons",
  "worker",
];

function permissionsEqual(
  left?: CarrotPermissionGrant | null,
  right?: CarrotPermissionGrant | null,
) {
  const leftTags = flattenCarrotPermissions(left).sort().join("|");
  const rightTags = flattenCarrotPermissions(right).sort().join("|");
  return leftTags === rightTags;
}

function describeSource(prepared: PreparedCarrotInstall) {
  switch (prepared.source.kind) {
    case "local":
      return prepared.source.path;
    case "artifact":
      return prepared.source.location;
    case "prototype":
      return prepared.source.prototypeId;
  }
}

function orderedHostPermissions(granted: CarrotPermissionGrant) {
  return HOST_PERMISSION_ORDER.filter((permission) => granted.host?.[permission] === true);
}

function orderedBunPermissions(granted: CarrotPermissionGrant) {
  return BUN_PERMISSION_ORDER.filter((permission) => granted.bun?.[permission] === true);
}

function newPermissionTags(
  previous: CarrotPermissionGrant | null,
  requested: CarrotPermissionGrant,
): CarrotPermissionTag[] {
  const requestedTags = flattenCarrotPermissions(requested);
  if (!previous) {
    return requestedTags;
  }

  const previousTags = new Set(flattenCarrotPermissions(previous));
  return requestedTags.filter((tag) => !previousTags.has(tag));
}

export function buildCarrotPermissionConsentRequest(
  prepared: PreparedCarrotInstall,
  requestId: string,
): PermissionConsentPlan {
  const requested = normalizeCarrotPermissions(prepared.manifest.permissions);
  const previous = prepared.previousInstall?.permissionsGranted ?? null;

  if (previous && permissionsEqual(previous, requested)) {
    return {
      grantedPermissions: previous,
      request: null,
    };
  }

  const changedPermissions = newPermissionTags(previous, requested);

  return {
    grantedPermissions: requested,
    request: {
      requestId,
      carrotId: prepared.manifest.id,
      carrotName: prepared.manifest.name,
      version: prepared.manifest.version,
      sourceKind: prepared.source.kind,
      sourceLabel: describeSource(prepared),
      message: previous
        ? changedPermissions.length > 0
          ? `${prepared.manifest.name} is requesting additional permissions before reinstalling.`
          : `${prepared.manifest.name} permissions changed and need approval before reinstalling.`
        : `${prepared.manifest.name} is ready to install with these permissions.`,
      confirmLabel: previous ? "Approve Reinstall" : "Install Carrot",
      requestedPermissions: flattenCarrotPermissions(requested),
      changedPermissions,
      hostPermissions: orderedHostPermissions(requested),
      bunPermissions: orderedBunPermissions(requested),
      isolation: (requested.isolation ?? "shared-worker") as CarrotIsolation,
    },
  };
}

export async function requestCarrotUninstallConsent(name: string) {
  const { Utils } = await import("electrobun/bun");
  const { response } = await Utils.showMessageBox({
    type: "warning",
    title: `Uninstall ${name}?`,
    message: `Remove ${name} from Bunny Ears?`,
    detail: "This removes the installed payload and local runtime state for the Carrot.",
    buttons: ["Uninstall", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });

  return response === 0;
}
