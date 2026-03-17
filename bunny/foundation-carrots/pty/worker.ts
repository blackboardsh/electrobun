import { Carrots } from "electrobun/bun";
import { TerminalManager, type TerminalMessage } from "./terminalManager";

type InvocationSource = {
  carrotId?: string;
  windowId?: string | null;
};

type CreateTerminalParams = {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  __source?: InvocationSource;
};

type TerminalActionParams = {
  terminalId?: string;
  __source?: InvocationSource;
};

type WriteTerminalParams = TerminalActionParams & {
  data?: string;
};

type ResizeTerminalParams = TerminalActionParams & {
  cols?: number;
  rows?: number;
};

type HeartbeatTerminalsParams = {
  terminalIds?: unknown;
  __source?: InvocationSource;
};

type WorkerRuntimeContext = {
  context?: {
    config?: {
      ptyHeartbeatTimeoutMs?: unknown;
      ptyHeartbeatSweepMs?: unknown;
    };
  };
};

type TerminalOwner = {
  carrotId: string;
  windowId?: string | null;
  lastHeartbeatAt: number;
};

const DEFAULT_TERMINAL_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TERMINAL_HEARTBEAT_SWEEP_MS = 30 * 1000;

function parseDurationMs(
  value: unknown,
  fallback: number,
  minimum: number,
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, parsed);
}

let terminalHeartbeatTimeoutMs = parseDurationMs(
  process.env.BUNNY_PTY_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_TERMINAL_HEARTBEAT_TIMEOUT_MS,
  1_000,
);
let terminalHeartbeatSweepMs = parseDurationMs(
  process.env.BUNNY_PTY_HEARTBEAT_SWEEP_MS,
  DEFAULT_TERMINAL_HEARTBEAT_SWEEP_MS,
  250,
);

const terminalOwners = new Map<string, TerminalOwner>();

function post(message: unknown) {
  self.postMessage(message);
}

function log(message: string) {
  post({
    type: "action",
    action: "log",
    payload: { message },
  });
}

function extractSource(params: { __source?: InvocationSource } | null | undefined) {
  const carrotId = params?.__source?.carrotId;
  if (!carrotId) {
    throw new Error("PTY requests require a source carrot id");
  }

  return {
    carrotId,
    windowId: params?.__source?.windowId ?? null,
  };
}

function emitToOwner(message: TerminalMessage) {
  const owner = terminalOwners.get(message.terminalId);
  if (!owner) {
    log(`dropping terminal event for unknown owner: ${message.terminalId}`);
    return;
  }

  if (message.type === "terminalOutput") {
    Carrots.emit(owner.carrotId, "pty-terminal-output", {
      terminalId: message.terminalId,
      data: message.data,
      windowId: owner.windowId ?? null,
    });
    return;
  }

  if (message.type === "terminalExit") {
    Carrots.emit(owner.carrotId, "pty-terminal-exit", {
      terminalId: message.terminalId,
      exitCode: message.exitCode,
      signal: message.signal ?? 0,
      windowId: owner.windowId ?? null,
    });
    log(`terminal exited ${message.terminalId} for ${owner.carrotId}`);
    terminalOwners.delete(message.terminalId);
  }
}

function refreshTerminalLease(terminalId: string) {
  const owner = terminalOwners.get(terminalId);
  if (!owner) {
    return false;
  }

  owner.lastHeartbeatAt = Date.now();
  return true;
}

function refreshTerminalLeases(terminalIds: string[]) {
  let refreshedCount = 0;
  for (const terminalId of terminalIds) {
    if (refreshTerminalLease(terminalId)) {
      refreshedCount += 1;
    }
  }
  return refreshedCount;
}

function sweepTerminalLeases() {
  const now = Date.now();
  let killedCount = 0;

  for (const [terminalId, owner] of terminalOwners.entries()) {
    if (now - owner.lastHeartbeatAt <= terminalHeartbeatTimeoutMs) {
      continue;
    }

    log(`heartbeat timeout kill ${terminalId} for ${owner.carrotId}`);
    if (terminalManager.killTerminal(terminalId)) {
      killedCount += 1;
    }
  }

  return killedCount;
}

const terminalManager = new TerminalManager(emitToOwner);
let heartbeatSweepTimer: ReturnType<typeof setInterval> | null = null;

function restartHeartbeatSweepTimer() {
  if (heartbeatSweepTimer) {
    clearInterval(heartbeatSweepTimer);
  }
  heartbeatSweepTimer = setInterval(sweepTerminalLeases, terminalHeartbeatSweepMs);
}

function initializeRuntimeContext(message?: WorkerRuntimeContext) {
  terminalHeartbeatTimeoutMs = parseDurationMs(
    message?.context?.config?.ptyHeartbeatTimeoutMs,
    terminalHeartbeatTimeoutMs,
    1_000,
  );
  terminalHeartbeatSweepMs = parseDurationMs(
    message?.context?.config?.ptyHeartbeatSweepMs,
    terminalHeartbeatSweepMs,
    250,
  );
  restartHeartbeatSweepTimer();
}

initializeRuntimeContext();

async function handleRequest(method: string, params: unknown) {
  switch (method) {
    case "createTerminal": {
      const request = (params ?? {}) as CreateTerminalParams;
      const source = extractSource(request);
      const terminalId = terminalManager.createTerminal(
        String(request.cwd || process.cwd()),
        typeof request.shell === "string" ? request.shell : undefined,
        Number(request.cols || 80),
        Number(request.rows || 24),
      );
      terminalOwners.set(terminalId, {
        ...source,
        lastHeartbeatAt: Date.now(),
      });
      log(`created terminal ${terminalId} for ${source.carrotId}`);
      return terminalId;
    }
    case "writeToTerminal": {
      const request = (params ?? {}) as WriteTerminalParams;
      refreshTerminalLease(String(request.terminalId || ""));
      return terminalManager.writeToTerminal(
        String(request.terminalId || ""),
        String(request.data || ""),
      );
    }
    case "resizeTerminal": {
      const request = (params ?? {}) as ResizeTerminalParams;
      refreshTerminalLease(String(request.terminalId || ""));
      return terminalManager.resizeTerminal(
        String(request.terminalId || ""),
        Number(request.cols || 80),
        Number(request.rows || 24),
      );
    }
    case "killTerminal": {
      const request = (params ?? {}) as TerminalActionParams;
      const terminalId = String(request.terminalId || "");
      log(`kill terminal ${terminalId}`);
      terminalOwners.delete(terminalId);
      return terminalManager.killTerminal(terminalId);
    }
    case "getTerminalCwd": {
      const request = (params ?? {}) as TerminalActionParams;
      refreshTerminalLease(String(request.terminalId || ""));
      return terminalManager.getTerminalCwd(String(request.terminalId || ""));
    }
    case "heartbeatTerminals": {
      const request = (params ?? {}) as HeartbeatTerminalsParams;
      const terminalIds = Array.isArray(request.terminalIds)
        ? request.terminalIds.map((terminalId) => String(terminalId || "")).filter(Boolean)
        : [];
      return {
        refreshedCount: refreshTerminalLeases(terminalIds),
      };
    }
    case "sweepExpiredTerminals":
      return {
        killedCount: sweepTerminalLeases(),
      };
    default:
      return undefined;
  }
}

self.addEventListener("message", async (event) => {
  const message = event.data as
    | {
        type?: string;
        requestId?: number;
        method?: string;
        params?: unknown;
      }
    | undefined;

  if (message?.type === "init") {
    initializeRuntimeContext(message as WorkerRuntimeContext);
    return;
  }

  if (!message || message.type !== "request" || typeof message.requestId !== "number") {
    return;
  }

  try {
    const payload = await handleRequest(String(message.method || ""), message.params);
    if (payload === undefined) {
      post({
        type: "response",
        requestId: message.requestId,
        success: false,
        error: `Unknown method: ${String(message.method || "")}`,
      });
      return;
    }

    post({
      type: "response",
      requestId: message.requestId,
      success: true,
      payload,
    });
  } catch (error) {
    post({
      type: "response",
      requestId: message.requestId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

process.on("exit", () => {
  if (heartbeatSweepTimer) {
    clearInterval(heartbeatSweepTimer);
  }
  terminalManager.cleanup();
});

self.postMessage({ type: "ready" });
