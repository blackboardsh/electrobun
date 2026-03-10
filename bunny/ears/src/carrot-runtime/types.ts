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

export type CarrotMode = "window" | "background";

export type CarrotManifest = {
  id: string;
  name: string;
  version: string;
  description: string;
  mode: CarrotMode;
  permissions: CarrotPermissionGrant;
  view: {
    relativePath: string;
    hidden?: boolean;
    title: string;
    width: number;
    height: number;
  };
  worker: {
    relativePath: string;
  };
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
      baseUrl: string;
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
  };
};

export type HostActionMessage = {
  type: "action";
  action:
    | "notify"
    | "set-tray"
    | "set-tray-menu"
    | "remove-tray"
    | "stop-carrot"
    | "emit-view"
    | "log";
  payload?: unknown;
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
