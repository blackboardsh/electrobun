import { spawn } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Carrots } from "electrobun/bun";

type InvocationSource = {
  carrotId?: string;
  windowId?: string | null;
};

type TsServerClientMetadata = {
  workspaceId: string;
  windowId: string;
  editorId: string;
};

type TsServerRequestParams = {
  command?: string;
  args?: any;
  metadata?: TsServerClientMetadata;
  __source?: InvocationSource;
};

type TsServerOwner = {
  carrotId: string;
  windowId?: string | null;
};

type ParsedTsServerMessage = {
  type?: string;
  event?: string;
  command?: string;
  request_seq?: number;
  body?: any;
  success?: boolean;
  [key: string]: any;
};

type TsServerSession = {
  owner: TsServerOwner;
  proc: any;
  nextSeq: number;
  buffer: Buffer;
  expectedContentLength: number | null;
  requestMetadataBySeq: Map<number, TsServerClientMetadata>;
  fileMetadataByPath: Map<string, TsServerClientMetadata>;
  editorMetadataById: Map<string, TsServerClientMetadata>;
  editorOpenFilesById: Map<string, Set<string>>;
  lastMetadata: TsServerClientMetadata | null;
};

type TypeScriptStatus = {
  installed: boolean;
  version: string;
};

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");
const FALLBACK_HEADER_SEPARATOR = Buffer.from("\n\n");
const TYPESCRIPT_PACKAGE_DIR = join(import.meta.dir, "typescript");
const TSSERVER_PATH = join(TYPESCRIPT_PACKAGE_DIR, "lib", "tsserver.js");

const sessions = new Map<string, TsServerSession>();

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

function extractSource(params: { __source?: InvocationSource } | null | undefined): TsServerOwner {
  const carrotId = params?.__source?.carrotId;
  if (!carrotId) {
    throw new Error("tsserver requests require a source carrot id");
  }

  return {
    carrotId,
    windowId: params?.__source?.windowId ?? null,
  };
}

function getSessionKey(owner: TsServerOwner) {
  return owner.carrotId;
}

function readTypescriptVersion() {
  const packageJsonPath = join(TYPESCRIPT_PACKAGE_DIR, "package.json");
  if (!existsSync(packageJsonPath)) {
    return "";
  }

  try {
    return String(JSON.parse(readFileSync(packageJsonPath, "utf8"))?.version || "");
  } catch {
    return "";
  }
}

function readTypeScriptStatus(): TypeScriptStatus {
  return {
    installed: existsSync(TSSERVER_PATH),
    version: readTypescriptVersion(),
  };
}

function getEditorKey(metadata: TsServerClientMetadata) {
  return `${metadata.windowId}:${metadata.editorId}`;
}

function rememberEditorMetadata(session: TsServerSession, metadata: TsServerClientMetadata) {
  session.editorMetadataById.set(getEditorKey(metadata), metadata);
}

function trackEditorOpenFile(
  session: TsServerSession,
  metadata: TsServerClientMetadata,
  filePath: string,
) {
  const editorKey = getEditorKey(metadata);
  const trackedFiles = session.editorOpenFilesById.get(editorKey) ?? new Set<string>();
  trackedFiles.add(filePath);
  session.editorOpenFilesById.set(editorKey, trackedFiles);
  session.fileMetadataByPath.set(filePath, metadata);
  rememberEditorMetadata(session, metadata);
}

function untrackEditorOpenFile(
  session: TsServerSession,
  metadata: TsServerClientMetadata,
  filePath: string,
) {
  const editorKey = getEditorKey(metadata);
  const trackedFiles = session.editorOpenFilesById.get(editorKey);
  if (trackedFiles) {
    trackedFiles.delete(filePath);
    if (trackedFiles.size === 0) {
      session.editorOpenFilesById.delete(editorKey);
      session.editorMetadataById.delete(editorKey);
    }
  }

  if (session.fileMetadataByPath.get(filePath)?.editorId === metadata.editorId) {
    session.fileMetadataByPath.delete(filePath);
  }
}

function emitTsServerMessage(
  session: TsServerSession,
  metadata: TsServerClientMetadata | null,
  message: ParsedTsServerMessage,
) {
  if (!metadata) {
    return;
  }

  Carrots.emit(session.owner.carrotId, "tsserver-message", {
    windowId: metadata.windowId || session.owner.windowId || null,
    message,
    metadata,
  });
}

function updateFileTracking(
  session: TsServerSession,
  command: string,
  args: any,
  metadata: TsServerClientMetadata,
) {
  if (command === "open" && typeof args?.file === "string") {
    trackEditorOpenFile(session, metadata, args.file);
    return;
  }

  if (command === "close" && typeof args?.file === "string") {
    untrackEditorOpenFile(session, metadata, args.file);
    return;
  }

  if (command === "change" && typeof args?.file === "string") {
    trackEditorOpenFile(session, metadata, args.file);
    return;
  }

  if (command !== "updateOpen" || !args || typeof args !== "object") {
    return;
  }

  if (Array.isArray(args.closedFiles)) {
    for (const file of args.closedFiles) {
      if (typeof file === "string") {
        untrackEditorOpenFile(session, metadata, file);
      }
    }
  }

  if (Array.isArray(args.openFiles)) {
    for (const file of args.openFiles) {
      if (typeof file === "string") {
        trackEditorOpenFile(session, metadata, file);
      }
    }
  }
}

function metadataForMessage(
  session: TsServerSession,
  message: ParsedTsServerMessage,
) {
  if (message.type === "response") {
    const requestSeq = Number(message.request_seq || 0);
    if (requestSeq) {
      const metadata = session.requestMetadataBySeq.get(requestSeq) || session.lastMetadata;
      session.requestMetadataBySeq.delete(requestSeq);
      return metadata;
    }
  }

  const requestSeq = Number(message?.body?.request_seq || 0);
  if (requestSeq) {
    return session.requestMetadataBySeq.get(requestSeq) || session.lastMetadata;
  }

  const filePath = typeof message?.body?.file === "string" ? message.body.file : "";
  if (filePath) {
    return session.fileMetadataByPath.get(filePath) || session.lastMetadata;
  }

  return session.lastMetadata;
}

function parseContentLength(header: string) {
  const match = header.match(/Content-Length:\s*(\d+)/i);
  return match ? Number(match[1]) : NaN;
}

function tryParseBufferedMessages(session: TsServerSession) {
  while (true) {
    if (session.expectedContentLength == null) {
      let separatorIndex = session.buffer.indexOf(HEADER_SEPARATOR);
      let separatorLength = HEADER_SEPARATOR.length;

      if (separatorIndex === -1) {
        separatorIndex = session.buffer.indexOf(FALLBACK_HEADER_SEPARATOR);
        separatorLength = FALLBACK_HEADER_SEPARATOR.length;
      }

      if (separatorIndex === -1) {
        return;
      }

      const header = session.buffer.slice(0, separatorIndex).toString("utf8");
      const contentLength = parseContentLength(header);
      session.buffer = session.buffer.slice(separatorIndex + separatorLength);

      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        session.buffer = Buffer.alloc(0);
        session.expectedContentLength = null;
        return;
      }

      session.expectedContentLength = contentLength;
    }

    if (session.buffer.length < session.expectedContentLength) {
      return;
    }

    const bodyBuffer = session.buffer.slice(0, session.expectedContentLength);
    session.buffer = session.buffer.slice(session.expectedContentLength);
    session.expectedContentLength = null;

    try {
      const parsedMessage = JSON.parse(bodyBuffer.toString("utf8")) as ParsedTsServerMessage;
      emitTsServerMessage(session, metadataForMessage(session, parsedMessage), parsedMessage);
    } catch {
      // Ignore malformed messages from tsserver rather than poisoning the stream.
    }
  }
}

function createSession(owner: TsServerOwner) {
  if (!existsSync(TSSERVER_PATH)) {
    throw new Error(`Missing bundled tsserver at ${TSSERVER_PATH}`);
  }

  const proc = spawn([process.execPath, TSSERVER_PATH, "--bun"], {
    cwd: "/",
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // @ts-ignore Bun-specific custom binary flag
    allowUnsafeCustomBinary: true,
  });

  const session: TsServerSession = {
    owner,
    proc,
    nextSeq: 1,
    buffer: Buffer.alloc(0),
    expectedContentLength: null,
    requestMetadataBySeq: new Map(),
    fileMetadataByPath: new Map(),
    editorMetadataById: new Map(),
    editorOpenFilesById: new Map(),
    lastMetadata: null,
  };

  const readStream = (
    stream: ReadableStream<Uint8Array>,
    onChunk: (chunk: Uint8Array) => void,
  ) => {
    const reader = stream.getReader();

    async function readNext() {
      try {
        const { done, value } = await reader.read();
        if (value) {
          onChunk(value);
        }
        if (!done) {
          void readNext();
        }
      } catch {
        // Ignore reader shutdown after process termination.
      }
    }

    void readNext();
  };

  readStream(proc.stdout, (chunk) => {
    session.buffer = Buffer.concat([session.buffer, Buffer.from(chunk)]);
    tryParseBufferedMessages(session);
  });

  readStream(proc.stderr, (chunk) => {
    const text = Buffer.from(chunk).toString("utf8").trim();
    if (text) {
      log(`tsserver stderr: ${text}`);
    }
  });

  proc.exited.then((code: number) => {
    sessions.delete(getSessionKey(owner));
    if (code && code !== 0) {
      log(`tsserver exited with code ${code}`);
    }
  });

  sessions.set(getSessionKey(owner), session);
  return session;
}

function ensureSession(owner: TsServerOwner) {
  return sessions.get(getSessionKey(owner)) || createSession(owner);
}

function writeRequest(session: TsServerSession, command: string, args: any, metadata: TsServerClientMetadata) {
  const seq = session.nextSeq++;
  session.lastMetadata = metadata;
  session.requestMetadataBySeq.set(seq, metadata);
  updateFileTracking(session, command, args, metadata);

  session.proc.stdin.write(
    JSON.stringify({
      seq,
      type: "request",
      command,
      arguments: args,
    }) + "\n",
  );
}

function shutdownSession(session: TsServerSession) {
  try {
    session.proc.kill();
  } catch {
    // Ignore shutdown errors for already-exited child processes.
  }
}

function shutdownSessionIfIdle(session: TsServerSession) {
  if (session.editorOpenFilesById.size > 0) {
    return false;
  }

  sessions.delete(getSessionKey(session.owner));
  shutdownSession(session);
  return true;
}

function closeEditorTrackedFiles(
  session: TsServerSession,
  metadata: TsServerClientMetadata,
) {
  const editorKey = getEditorKey(metadata);
  const trackedFiles = Array.from(session.editorOpenFilesById.get(editorKey) ?? []);
  let closedFiles = 0;

  for (const filePath of trackedFiles) {
    writeRequest(session, "close", { file: filePath }, metadata);
    closedFiles += 1;
  }

  session.editorOpenFilesById.delete(editorKey);
  session.editorMetadataById.delete(editorKey);
  return {
    closedFiles,
    shutdown: shutdownSessionIfIdle(session),
  };
}

function closeWindowTrackedEditors(
  session: TsServerSession,
  windowId: string,
  workspaceId?: string,
) {
  const matchingEditors = Array.from(session.editorMetadataById.values()).filter((metadata) => {
    if (metadata.windowId !== windowId) {
      return false;
    }
    if (workspaceId && metadata.workspaceId !== workspaceId) {
      return false;
    }
    return true;
  });

  let closedEditors = 0;
  let closedFiles = 0;

  for (const metadata of matchingEditors) {
    const result = closeEditorTrackedFiles(session, metadata);
    if (result.closedFiles > 0) {
      closedEditors += 1;
      closedFiles += result.closedFiles;
    }
  }

  return {
    closedEditors,
    closedFiles,
    shutdown: shutdownSessionIfIdle(session),
  };
}

process.on("exit", () => {
  for (const session of sessions.values()) {
    shutdownSession(session);
  }
  sessions.clear();
});

async function handleRequest(method: string, params: unknown) {
  switch (method) {
    case "tsServerRequest": {
      const request = (params ?? {}) as TsServerRequestParams;
      const owner = extractSource(request);
      const metadata = request.metadata;

      if (!metadata?.workspaceId || !metadata?.windowId || !metadata?.editorId) {
        throw new Error("tsserver requests require workspaceId, windowId, and editorId metadata");
      }

      writeRequest(
        ensureSession(owner),
        String(request.command || ""),
        request.args ?? {},
        metadata,
      );
      return true;
    }
    case "getTypeScriptVersion":
      return readTypescriptVersion();
    case "getTypeScriptStatus":
      return readTypeScriptStatus();
    case "closeEditor": {
      const request = (params ?? {}) as TsServerRequestParams;
      const owner = extractSource(request);
      const metadata = request.metadata;

      if (!metadata?.workspaceId || !metadata?.windowId || !metadata?.editorId) {
        throw new Error("closeEditor requires workspaceId, windowId, and editorId metadata");
      }

      const session = sessions.get(getSessionKey(owner));
      if (!session) {
        return { closedFiles: 0, shutdown: false };
      }

      return closeEditorTrackedFiles(session, metadata);
    }
    case "closeWindowEditors": {
      const request = (params ?? {}) as {
        windowId?: string;
        workspaceId?: string;
        __source?: InvocationSource;
      };
      const owner = extractSource(request);
      const windowId = String(request.windowId || owner.windowId || "");
      if (!windowId) {
        throw new Error("closeWindowEditors requires a windowId");
      }

      const session = sessions.get(getSessionKey(owner));
      if (!session) {
        return { closedEditors: 0, closedFiles: 0, shutdown: false };
      }

      return closeWindowTrackedEditors(
        session,
        windowId,
        typeof request.workspaceId === "string" && request.workspaceId.length > 0
          ? request.workspaceId
          : undefined,
      );
    }
    default:
      return undefined;
  }
}

self.onmessage = async (event) => {
  const message = event.data as {
    type?: string;
    requestId?: number;
    method?: string;
    params?: unknown;
  } | undefined;

  if (!message || message.type !== "request") {
    return;
  }

  try {
    const payload = await handleRequest(String(message.method || ""), message.params);
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
};

self.postMessage({ type: "ready" });
