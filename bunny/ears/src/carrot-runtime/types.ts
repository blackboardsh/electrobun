export type HostPermission = "windows" | "tray" | "notifications" | "storage";
export type BunPermission =
  | "read"
  | "write"
  | "env"
  | "run"
  | "ffi"
  | "addons"
  | "worker";
export type CarrotIsolation = "shared-worker" | "isolated-process";

export type LegacyCarrotPermission =
  | "bun"
  | "bun:fs"
  | "bun:env"
  | "bun:child_process"
  | "bun:ffi"
  | "bun:addons"
  | HostPermission;

export type CarrotPermissionGrant = {
  host?: Partial<Record<HostPermission, boolean>>;
  bun?: Partial<Record<BunPermission, boolean>>;
  isolation?: CarrotIsolation;
};

export type CarrotPermissionTag =
  | `host:${HostPermission}`
  | `bun:${BunPermission}`
  | `isolation:${CarrotIsolation}`;

export type CarrotPermissionConsentRequest = {
  requestId: string;
  carrotId: string;
  carrotName: string;
  version: string;
  sourceKind: "prototype" | "local" | "artifact";
  sourceLabel: string;
  message: string;
  confirmLabel: string;
  requestedPermissions: CarrotPermissionTag[];
  changedPermissions: CarrotPermissionTag[];
  hostPermissions: HostPermission[];
  bunPermissions: BunPermission[];
  isolation: CarrotIsolation;
};

export type CarrotMode = "window" | "background";

export type CarrotDependencyMap = Record<string, string>;

export type CarrotRemoteUI = {
  name: string;
  // Path within the carrot's currentDir to the entry HTML file.
  // e.g. "lens/index.html" or "remote-ui/dash/index.html"
  path: string;
};

export type CarrotManifest = {
  id: string;
  name: string;
  version: string;
  description: string;
  mode: CarrotMode;
  dependencies?: CarrotDependencyMap;
  permissions: CarrotPermissionGrant;
  view: {
    relativePath: string;
    hidden?: boolean;
    title: string;
    width: number;
    height: number;
    titleBarStyle?: "hidden" | "hiddenInset" | "default";
    transparent?: boolean;
  };
  worker: {
    relativePath: string;
  };
  // Remote UIs declared by the carrot — exposed for browser loading via Hop.
  // Map of remote UI ID → { name (label), path (within currentDir) }.
  remoteUIs?: Record<string, CarrotRemoteUI>;
};

export type CarrotInstallSource =
  | {
      kind: "prototype";
      prototypeId: string;
      bundledViewFolder: string;
    }
  | {
      kind: "local";
      path: string;
    }
  | {
      kind: "artifact";
      location: string;
      updateLocation?: string | null;
      tarballLocation?: string | null;
      currentHash?: string | null;
      baseUrl?: string | null;
    };

export type CarrotInstallStatus = "installed" | "broken";

export type CarrotInstallRecord = {
  id: string;
  name: string;
  version: string;
  currentHash: string | null;
  installedAt: number;
  updatedAt: number;
  permissionsGranted: CarrotPermissionGrant;
  devMode?: boolean;
  lastBuildAt?: number | null;
  lastBuildError?: string | null;
  status: CarrotInstallStatus;
  source: CarrotInstallSource;
};

export type CarrotRegistry = {
  version: 1;
  carrots: Record<string, CarrotInstallRecord>;
};

export type WorkerRequestMessage = {
  type: "request";
  requestId: number;
  method: string;
  params?: unknown;
  windowId?: string;
};

export type WorkerEventMessage = {
  type: "event";
  name: string;
  payload?: unknown;
};

export type WorkerInitMessage = {
  type: "init";
  manifest: CarrotManifest;
  context: {
    statePath: string;
    logsPath: string;
    permissions: CarrotPermissionTag[];
    grantedPermissions: CarrotPermissionGrant;
    config?: Record<string, unknown>;
  };
};

export type HostActionMessage = {
  type: "action";
  action:
    | "notify"
    | "window-create"
    | "window-set-title"
    | "window-set-frame"
    | "window-set-always-on-top"
    | "show-context-menu"
    | "set-application-menu"
    | "clear-application-menu"
    | "set-tray"
    | "set-tray-menu"
    | "remove-tray"
    | "focus-window"
    | "close-window"
    | "open-bunny-window"
    | "open-manager"
    | "stop-carrot"
    | "emit-view"
    | "emit-carrot-event"
    | "log";
  payload?: unknown;
};

export type HostRequestMessage = {
  type: "host-request";
  requestId: number;
  method:
    | "open-file-dialog"
    | "open-path"
    | "show-item-in-folder"
    | "clipboard-write-text"
    | "window-get-frame"
    | "invoke-carrot"
    | "screen-get-primary-display"
    | "screen-get-cursor-screen-point";
  params?: unknown;
};

export type HostResponseMessage = {
  type: "host-response";
  requestId: number;
  success: boolean;
  payload?: unknown;
  error?: string;
};

export type WorkerResponseMessage = {
  type: "response";
  requestId: number;
  success: boolean;
  payload?: unknown;
  error?: string;
};

export type WorkerReadyMessage = {
  type: "ready";
};

export type CarrotWorkerMessage =
  | WorkerRequestMessage
  | WorkerEventMessage
  | WorkerInitMessage
  | HostActionMessage
  | HostRequestMessage
  | HostResponseMessage
  | WorkerResponseMessage
  | WorkerReadyMessage;

export type CarrotViewRPC = {
  bun: {
    requests: {
      invoke: {
        params: { method: string; params?: unknown };
        response: unknown;
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      runtimeEvent: { name: string; payload?: unknown };
      carrotBoot: {
        id: string;
        name: string;
        permissions: CarrotPermissionTag[];
        grantedPermissions: CarrotPermissionGrant;
        mode: CarrotMode;
      };
    };
  };
};

export function normalizeCarrotPermissions(
  input?: CarrotPermissionGrant | LegacyCarrotPermission[] | null,
): CarrotPermissionGrant {
  const normalized: CarrotPermissionGrant = {
    host: {},
    bun: {},
    isolation: "shared-worker",
  };

  if (!input) {
    return normalized;
  }

  if (Array.isArray(input)) {
    for (const permission of input) {
      switch (permission) {
        case "bun":
          break;
        case "bun:fs":
          normalized.bun!.read = true;
          normalized.bun!.write = true;
          break;
        case "bun:env":
          normalized.bun!.env = true;
          break;
        case "bun:child_process":
          normalized.bun!.run = true;
          break;
        case "bun:ffi":
          normalized.bun!.ffi = true;
          break;
        case "bun:addons":
          normalized.bun!.addons = true;
          break;
        case "windows":
        case "tray":
        case "notifications":
        case "storage":
          normalized.host![permission] = true;
          break;
      }
    }

    return normalized;
  }

  if (input.host) {
    normalized.host = { ...normalized.host, ...input.host };
  }

  if (input.bun) {
    normalized.bun = { ...normalized.bun, ...input.bun };
  }

  if (input.isolation) {
    normalized.isolation = input.isolation;
  }

  return normalized;
}

export function flattenCarrotPermissions(
  input?: CarrotPermissionGrant | LegacyCarrotPermission[] | null,
): CarrotPermissionTag[] {
  const permissions = normalizeCarrotPermissions(input);
  const tags: CarrotPermissionTag[] = [];

  for (const key of ["windows", "tray", "notifications", "storage"] as const) {
    if (permissions.host?.[key]) {
      tags.push(`host:${key}`);
    }
  }

  for (const key of ["read", "write", "env", "run", "ffi", "addons", "worker"] as const) {
    if (permissions.bun?.[key]) {
      tags.push(`bun:${key}`);
    }
  }

  tags.push(`isolation:${permissions.isolation ?? "shared-worker"}`);
  return tags;
}

export function mergeCarrotPermissions(
  defaults?: CarrotPermissionGrant | LegacyCarrotPermission[] | null,
  overrides?: CarrotPermissionGrant | LegacyCarrotPermission[] | null,
): CarrotPermissionGrant {
  const base = normalizeCarrotPermissions(defaults);
  const extra = normalizeCarrotPermissions(overrides);

  return {
    host: {
      ...base.host,
      ...extra.host,
    },
    bun: {
      ...base.bun,
      ...extra.bun,
    },
    isolation: extra.isolation ?? base.isolation ?? "shared-worker",
  };
}

export function hasHostPermission(
  input: CarrotPermissionGrant | LegacyCarrotPermission[] | null | undefined,
  permission: HostPermission,
) {
  return normalizeCarrotPermissions(input).host?.[permission] === true;
}

export function hasBunPermission(
  input: CarrotPermissionGrant | LegacyCarrotPermission[] | null | undefined,
  permission: BunPermission,
) {
  return normalizeCarrotPermissions(input).bun?.[permission] === true;
}
