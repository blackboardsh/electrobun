export type CarrotPermission =
  | "bun"
  | "windows"
  | "tray"
  | "notifications"
  | "storage";

export type CarrotMode = "window" | "background";

export type CarrotManifest = {
  id: string;
  name: string;
  version: string;
  description: string;
  mode: CarrotMode;
  permissions: CarrotPermission[];
  view: {
    url: string;
    hidden?: boolean;
    title: string;
    width: number;
    height: number;
  };
  worker: {
    relativePath: string;
  };
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
    permissions: CarrotPermission[];
  };
};

export type HostActionMessage = {
  type: "action";
  action:
    | "notify"
    | "set-tray"
    | "set-tray-menu"
    | "remove-tray"
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
        permissions: CarrotPermission[];
        mode: CarrotMode;
      };
    };
  };
};
