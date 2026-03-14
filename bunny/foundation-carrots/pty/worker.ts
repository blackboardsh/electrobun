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

const terminalOwners = new Map<string, { carrotId: string; windowId?: string | null }>();

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

const terminalManager = new TerminalManager(emitToOwner);

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
      terminalOwners.set(terminalId, source);
      log(`created terminal ${terminalId} for ${source.carrotId}`);
      return terminalId;
    }
    case "writeToTerminal": {
      const request = (params ?? {}) as WriteTerminalParams;
      return terminalManager.writeToTerminal(
        String(request.terminalId || ""),
        String(request.data || ""),
      );
    }
    case "resizeTerminal": {
      const request = (params ?? {}) as ResizeTerminalParams;
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
      return terminalManager.getTerminalCwd(String(request.terminalId || ""));
    }
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
  terminalManager.cleanup();
});

self.postMessage({ type: "ready" });
