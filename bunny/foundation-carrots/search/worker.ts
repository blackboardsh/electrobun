import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Carrots } from "electrobun/bun";

type InvocationSource = {
  carrotId?: string;
  windowId?: string | null;
};

type SearchTarget = {
  projectId: string;
  path: string;
};

type SearchRequestParams = {
  query?: string;
  targets?: SearchTarget[];
  __source?: InvocationSource;
};

type CancelSearchParams = {
  __source?: InvocationSource;
};

type FindFirstNestedGitRepoParams = {
  searchPath?: string;
  timeoutMs?: number;
};

type SearchOwner = {
  carrotId: string;
  windowId?: string | null;
  key: string;
};

type FindAllResult = {
  path: string;
  line: number;
  column: number;
  match: string;
};

type SearchSession<T> = {
  owner: SearchOwner;
  processes: Subprocess[];
  resultBatches: Map<string, T[]>;
  batchTimeout: ReturnType<typeof setTimeout> | null;
  totalResultCount: number;
};

const FD_BINARY_NAME = process.platform === "win32" ? "fd.exe" : "fd";
const RG_BINARY_NAME = process.platform === "win32" ? "rg.exe" : "rg";
const SEARCH_BATCH_FLUSH_MS = 100;
const MAX_FIND_ALL_RESULTS = 1_000;
const MAX_FIND_FILES_RESULTS = 500;
const workerDir = dirname(fileURLToPath(import.meta.url));
const FD_BINARY_PATH = join(workerDir, FD_BINARY_NAME);
const RG_BINARY_PATH = join(workerDir, RG_BINARY_NAME);

const findAllSessions = new Map<string, SearchSession<FindAllResult>>();
const findFilesSessions = new Map<string, SearchSession<string>>();

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

function extractSource(params: { __source?: InvocationSource } | null | undefined): SearchOwner {
  const carrotId = params?.__source?.carrotId;
  if (!carrotId) {
    throw new Error("Search requests require a source carrot id");
  }

  const windowId = params?.__source?.windowId ?? null;
  return {
    carrotId,
    windowId,
    key: `${carrotId}::${windowId ?? "__global__"}`,
  };
}

function clearBatchTimeout<T>(session: SearchSession<T>) {
  if (!session.batchTimeout) {
    return;
  }
  clearTimeout(session.batchTimeout);
  session.batchTimeout = null;
}

function stopProcesses(processes: Subprocess[]) {
  for (const process of processes) {
    try {
      process.kill();
    } catch {
      // Ignore shutdown failures for already-exited child processes.
    }
  }
}

function cancelSession<T>(sessions: Map<string, SearchSession<T>>, key: string) {
  const session = sessions.get(key);
  if (!session) {
    return false;
  }

  clearBatchTimeout(session);
  stopProcesses(session.processes);
  sessions.delete(key);
  return true;
}

function cancelAllSessions() {
  for (const key of Array.from(findAllSessions.keys())) {
    cancelSession(findAllSessions, key);
  }
  for (const key of Array.from(findFilesSessions.keys())) {
    cancelSession(findFilesSessions, key);
  }
}

function createSearchSession<T>(owner: SearchOwner) {
  return {
    owner,
    processes: [],
    resultBatches: new Map<string, T[]>(),
    batchTimeout: null,
    totalResultCount: 0,
  } satisfies SearchSession<T>;
}

function readProcessLines(process: Subprocess, onLine: (line: string) => void) {
  const reader = process.stdout.getReader();
  let stdoutBuffer = "";

  async function readStream() {
    try {
      const { done, value } = await reader.read();
      if (value) {
        stdoutBuffer += new TextDecoder().decode(value);
        const lines = stdoutBuffer.split("\n");
        for (let index = 0; index < lines.length - 1; index += 1) {
          if (lines[index]) {
            onLine(lines[index]!);
          }
        }
        stdoutBuffer = lines[lines.length - 1] || "";
      }

      if (!done) {
        void readStream();
        return;
      }

      if (stdoutBuffer.length > 0) {
        onLine(stdoutBuffer);
      }
    } catch {
      // Ignore reader shutdown after process cancellation.
    }
  }

  void readStream();
}

function emitFindAllResults(owner: SearchOwner, query: string, projectId: string, results: FindAllResult[]) {
  if (results.length === 0) {
    return;
  }

  Carrots.emit(owner.carrotId, "search-find-all-results", {
    windowId: owner.windowId ?? null,
    query,
    projectId,
    results,
  });
}

function emitFindFileResults(owner: SearchOwner, query: string, projectId: string, results: string[]) {
  if (results.length === 0) {
    return;
  }

  Carrots.emit(owner.carrotId, "search-find-files-results", {
    windowId: owner.windowId ?? null,
    query,
    projectId,
    results,
  });
}

function flushFindAllBatches(session: SearchSession<FindAllResult>, query: string) {
  clearBatchTimeout(session);
  for (const [projectId, results] of session.resultBatches.entries()) {
    if (results.length === 0) {
      continue;
    }
    emitFindAllResults(session.owner, query, projectId, [...results]);
    results.length = 0;
  }
}

function scheduleFindAllFlush(session: SearchSession<FindAllResult>, query: string) {
  clearBatchTimeout(session);
  session.batchTimeout = setTimeout(() => {
    flushFindAllBatches(session, query);
  }, SEARCH_BATCH_FLUSH_MS);
}

function flushFindFileBatches(session: SearchSession<string>, query: string) {
  clearBatchTimeout(session);
  for (const [projectId, results] of session.resultBatches.entries()) {
    if (results.length === 0) {
      continue;
    }
    emitFindFileResults(session.owner, query, projectId, [...results]);
    results.length = 0;
  }
}

function scheduleFindFileFlush(session: SearchSession<string>, query: string) {
  clearBatchTimeout(session);
  session.batchTimeout = setTimeout(() => {
    flushFindFileBatches(session, query);
  }, SEARCH_BATCH_FLUSH_MS);
}

function createRgProcess(path: string, query: string) {
  if (!existsSync(RG_BINARY_PATH)) {
    throw new Error(`Missing bundled rg binary at ${RG_BINARY_PATH}`);
  }

  return Bun.spawn(
    [
      RG_BINARY_PATH,
      "--line-number",
      "--column",
      "--no-heading",
      "--color=never",
      "--case-sensitive",
      "--max-count=500",
      query,
      path,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function createFindFilesProcess(path: string, query: string) {
  const fuzzyPattern = query.split("").join(".*");

  if (existsSync(FD_BINARY_PATH)) {
    return Bun.spawn(
      [
        FD_BINARY_PATH,
        "--type",
        "f",
        "--hidden",
        "--exclude",
        ".git",
        "--full-path",
        fuzzyPattern,
        path,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  }

  return Bun.spawn(
    [
      "find",
      path,
      "-type",
      "f",
      "-not",
      "-path",
      "*/.git/*",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/build/*",
      "-not",
      "-path",
      "*/dist/*",
      "-iregex",
      `.*${fuzzyPattern}.*`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function startFindAllSearch(owner: SearchOwner, query: string, targets: SearchTarget[]) {
  cancelSession(findAllSessions, owner.key);

  const session = createSearchSession<FindAllResult>(owner);
  findAllSessions.set(owner.key, session);

  for (const target of targets) {
    const process = createRgProcess(target.path, query);
    session.processes.push(process);
    session.resultBatches.set(target.projectId, []);

    readProcessLines(process, (line) => {
      if (findAllSessions.get(owner.key) !== session) {
        return;
      }

      if (session.totalResultCount >= MAX_FIND_ALL_RESULTS) {
        cancelSession(findAllSessions, owner.key);
        return;
      }

      const parts = line.split(":");
      if (parts.length < 4) {
        return;
      }

      const result = {
        path: parts[0]!,
        line: Number(parts[1] || 0),
        column: Number(parts[2] || 0),
        match: parts.slice(3).join(":"),
      } satisfies FindAllResult;

      const batch = session.resultBatches.get(target.projectId);
      if (!batch) {
        return;
      }

      batch.push(result);
      session.totalResultCount += 1;

      if (batch.length === 1 && !session.batchTimeout) {
        emitFindAllResults(session.owner, query, target.projectId, [...batch]);
        batch.length = 0;
        return;
      }

      if (batch.length >= 50) {
        emitFindAllResults(session.owner, query, target.projectId, [...batch]);
        batch.length = 0;
        return;
      }

      scheduleFindAllFlush(session, query);
    });
  }
}

function startFindFileSearch(owner: SearchOwner, query: string, targets: SearchTarget[]) {
  cancelSession(findFilesSessions, owner.key);

  const session = createSearchSession<string>(owner);
  findFilesSessions.set(owner.key, session);

  for (const target of targets) {
    const process = createFindFilesProcess(target.path, query);
    session.processes.push(process);
    session.resultBatches.set(target.projectId, []);

    readProcessLines(process, (line) => {
      if (findFilesSessions.get(owner.key) !== session) {
        return;
      }

      if (session.totalResultCount >= MAX_FIND_FILES_RESULTS) {
        cancelSession(findFilesSessions, owner.key);
        return;
      }

      const batch = session.resultBatches.get(target.projectId);
      if (!batch) {
        return;
      }

      batch.push(line);
      session.totalResultCount += 1;

      if (batch.length === 1 && !session.batchTimeout) {
        emitFindFileResults(session.owner, query, target.projectId, [...batch]);
        batch.length = 0;
        return;
      }

      if (batch.length >= 25) {
        emitFindFileResults(session.owner, query, target.projectId, [...batch]);
        batch.length = 0;
        return;
      }

      scheduleFindFileFlush(session, query);
    });
  }
}

async function findFirstNestedGitRepo(searchPath: string, timeoutMs = 5_000) {
  if (existsSync(FD_BINARY_PATH)) {
    const process = Bun.spawn(
      [
        FD_BINARY_PATH,
        "--type",
        "d",
        "--hidden",
        "--max-results",
        "1",
        "^.git$",
        searchPath,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const resultPromise = new Response(process.stdout).text();
    const timeoutPromise = new Promise<string>((resolve) => {
      setTimeout(() => {
        try {
          process.kill();
        } catch {
          // Ignore timeout cleanup failures.
        }
        resolve("TIMEOUT");
      }, timeoutMs);
    });

    const output = await Promise.race([resultPromise, timeoutPromise]);
    if (!process.killed) {
      await process.exited;
    }
    if (output === "TIMEOUT") {
      return null;
    }
    const result = String(output || "").trim().split("\n")[0];
    return result || null;
  }

  const process = Bun.spawn(
    [
      "find",
      searchPath,
      "-type",
      "d",
      "-name",
      ".git",
      "-print",
      "-quit",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = await new Response(process.stdout).text();
  return output.trim().split("\n")[0] || null;
}

async function handleRequest(method: string, params: unknown) {
  switch (method) {
    case "findAllInWorkspace": {
      const request = (params ?? {}) as SearchRequestParams;
      const owner = extractSource(request);
      const query = String(request.query || "").trim();
      const targets = Array.isArray(request.targets)
        ? request.targets
            .filter(
              (target): target is SearchTarget =>
                Boolean(target && typeof target.projectId === "string" && typeof target.path === "string"),
            )
            .map((target) => ({
              projectId: target.projectId,
              path: target.path,
            }))
        : [];

      cancelSession(findAllSessions, owner.key);
      if (!query || targets.length === 0) {
        return [];
      }

      startFindAllSearch(owner, query, targets);
      return [];
    }
    case "findFilesInWorkspace": {
      const request = (params ?? {}) as SearchRequestParams;
      const owner = extractSource(request);
      const query = String(request.query || "").trim();
      const targets = Array.isArray(request.targets)
        ? request.targets
            .filter(
              (target): target is SearchTarget =>
                Boolean(target && typeof target.projectId === "string" && typeof target.path === "string"),
            )
            .map((target) => ({
              projectId: target.projectId,
              path: target.path,
            }))
        : [];

      cancelSession(findFilesSessions, owner.key);
      if (!query || targets.length === 0) {
        return [];
      }

      startFindFileSearch(owner, query, targets);
      return [];
    }
    case "cancelFindAll": {
      const owner = extractSource((params ?? {}) as CancelSearchParams);
      return cancelSession(findAllSessions, owner.key);
    }
    case "cancelFileSearch": {
      const owner = extractSource((params ?? {}) as CancelSearchParams);
      return cancelSession(findFilesSessions, owner.key);
    }
    case "findFirstNestedGitRepo": {
      const request = (params ?? {}) as FindFirstNestedGitRepoParams;
      return findFirstNestedGitRepo(
        String(request.searchPath || ""),
        Number(request.timeoutMs || 5_000),
      );
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
  cancelAllSessions();
});

self.postMessage({ type: "ready" });
