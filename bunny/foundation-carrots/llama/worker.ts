import { spawn } from "bun";
import { dirname, join, basename } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { app } from "electrobun/bun";

const LLAMA_BINARY_NAME = process.platform === "win32" ? "llama-cli.exe" : "llama-cli";
const MIN_MODEL_BYTES = 100 * 1024 * 1024;
const LLAMA_TIMEOUT_MS = 45_000;
const DEFAULT_DOWNLOAD_BASE_URL_TEMPLATE =
  "https://huggingface.co/{user}/{repo}/resolve/main/{filePath}";

type LlamaCompletionOptions = {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  repeat_penalty?: number;
  stop?: string[];
};

type DownloadStatus = {
  status: "downloading" | "completed" | "failed";
  progress: number;
  fileName: string;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
};

type WorkerRuntimeContext = {
  context?: {
    config?: {
      llamaBinaryPath?: unknown;
      llamaModelsDir?: unknown;
      llamaMinModelBytes?: unknown;
      llamaTimeoutMs?: unknown;
      llamaDownloadBaseUrlTemplate?: unknown;
    };
  };
};

const activeProcesses = new Map<number, ReturnType<typeof spawn>>();
const modelDownloads = new Map<string, DownloadStatus>();
let llamaBinaryPathOverride: string | null = null;
let modelsDirOverride: string | null = null;
let minModelBytes = parsePositiveNumber(
  process.env.BUNNY_LLAMA_MIN_MODEL_BYTES,
  MIN_MODEL_BYTES,
  1,
);
let llamaTimeoutMs = parsePositiveNumber(
  process.env.BUNNY_LLAMA_TIMEOUT_MS,
  LLAMA_TIMEOUT_MS,
  1_000,
);
let downloadBaseUrlTemplate =
  process.env.BUNNY_LLAMA_DOWNLOAD_BASE_URL_TEMPLATE || DEFAULT_DOWNLOAD_BASE_URL_TEMPLATE;

function post(message: unknown) {
  self.postMessage(message);
}

function parsePositiveNumber(value: unknown, fallback: number, minimum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, parsed);
}

function initializeRuntimeContext(message: WorkerRuntimeContext) {
  const config = message.context?.config;
  if (!config) {
    return;
  }

  if (typeof config.llamaBinaryPath === "string" && config.llamaBinaryPath.length > 0) {
    llamaBinaryPathOverride = config.llamaBinaryPath;
  }

  if (typeof config.llamaModelsDir === "string" && config.llamaModelsDir.length > 0) {
    modelsDirOverride = config.llamaModelsDir;
  }

  minModelBytes = parsePositiveNumber(config.llamaMinModelBytes, minModelBytes, 1);
  llamaTimeoutMs = parsePositiveNumber(config.llamaTimeoutMs, llamaTimeoutMs, 1_000);

  if (
    typeof config.llamaDownloadBaseUrlTemplate === "string" &&
    config.llamaDownloadBaseUrlTemplate.length > 0
  ) {
    downloadBaseUrlTemplate = config.llamaDownloadBaseUrlTemplate;
  }
}

function getModelsDir() {
  const modelsDir =
    modelsDirOverride || join(dirname(app.statePath || join(import.meta.dir, "state.json")), "models");
  if (!existsSync(modelsDir)) {
    mkdirSync(modelsDir, { recursive: true });
  }
  return modelsDir;
}

function getLlamaCliPath() {
  const binaryPath = llamaBinaryPathOverride || join(import.meta.dir, LLAMA_BINARY_NAME);
  if (!existsSync(binaryPath)) {
    throw new Error(`Missing bundled llama-cli at ${binaryPath}`);
  }
  return binaryPath;
}

function resolveDownloadUrl(user: string, repo: string, filePath: string) {
  return downloadBaseUrlTemplate
    .replaceAll("{user}", user)
    .replaceAll("{repo}", repo)
    .replaceAll("{filePath}", filePath)
    .replaceAll("{fileName}", basename(filePath));
}

function killActiveCompletions() {
  for (const proc of activeProcesses.values()) {
    try {
      proc.kill();
    } catch {
      // Ignore already-dead processes.
    }
  }
  activeProcesses.clear();
}

function resolveModelPath(model: string) {
  const modelsDir = getModelsDir();
  const candidates = [
    join(modelsDir, model),
    join(modelsDir, model.endsWith(".gguf") ? model : `${model}.gguf`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function llamaCompletion(params: {
  model?: string;
  prompt?: string;
  options?: LlamaCompletionOptions;
}) {
  killActiveCompletions();

  const modelName = String(params.model || "");
  const prompt = String(params.prompt || "");
  const modelPath = resolveModelPath(modelName);
  if (!modelPath) {
    return {
      ok: false,
      error: `Model not found: ${modelName}`,
    };
  }

  const args = [
    "--model",
    modelPath,
    "--prompt",
    prompt,
    "--temperature",
    String(params.options?.temperature || 0.7),
    "--n-predict",
    String(params.options?.max_tokens || 48),
    "--top-p",
    String(params.options?.top_p || 0.95),
    "--repeat-penalty",
    String(params.options?.repeat_penalty || 1.1),
    "--quiet",
  ];

  const proc = spawn([getLlamaCliPath(), ...args], {
    stdout: "pipe",
    stderr: "ignore",
    // @ts-ignore Bun-specific custom binary flag
    allowUnsafeCustomBinary: true,
  });

  const requestId = Date.now() + Math.random();
  activeProcesses.set(requestId, proc);

  try {
    await Promise.race([
      proc.exited,
      new Promise((_, reject) =>
        setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // Ignore kill failures.
          }
          reject(new Error("llama-cli completion timeout"));
        }, llamaTimeoutMs),
      ),
    ]);

    activeProcesses.delete(requestId);

    if (proc.exitCode !== 0) {
      return {
        ok: false,
        error: `llama-cli process failed with exit code ${proc.exitCode}`,
      };
    }

    const stdout = await new Response(proc.stdout).text();
    return {
      ok: true,
      response: stdout.trim(),
    };
  } catch (error) {
    activeProcesses.delete(requestId);
    try {
      proc.kill();
    } catch {
      // Ignore kill failures.
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function llamaListModels() {
  try {
    const modelsDir = getModelsDir();
    const models = readdirSync(modelsDir)
      .filter((file) => file.endsWith(".gguf"))
      .map((file) => {
        const filePath = join(modelsDir, file);
        const stats = statSync(filePath);
        return {
          name: file.replace(/\.gguf$/i, ""),
          path: filePath,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          source: "llama" as const,
        };
      })
      .filter((model) => model.size > minModelBytes)
      .sort((a, b) => b.modified.localeCompare(a.modified));

    return {
      ok: true,
      models,
    };
  } catch (error) {
    return {
      ok: false,
      models: [],
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function llamaInstallModel(params: { modelRef?: string }) {
  const modelRef = String(params.modelRef || "");
  if (!modelRef.startsWith("hf://")) {
    return {
      ok: false,
      error: "Only Hugging Face models (hf://) are supported",
    };
  }

  const hfPath = modelRef.slice(5);
  const pathParts = hfPath.split("/");
  if (pathParts.length < 3) {
    return {
      ok: false,
      error: "Invalid Hugging Face model reference",
    };
  }

  const [user, repo, ...fileParts] = pathParts;
  const fileName = fileParts.join("/");
  const localFileName = basename(fileName);
  const localFilePath = join(getModelsDir(), localFileName);

  if (existsSync(localFilePath)) {
    const stats = statSync(localFilePath);
    if (stats.size > minModelBytes) {
      return { ok: true, message: "Model already downloaded" };
    }
  }

  const downloadUrl = resolveDownloadUrl(user, repo, fileName);
  const downloadId = `${user}-${repo}-${localFileName}`;

  void (async () => {
    modelDownloads.set(downloadId, {
      status: "downloading",
      progress: 0,
      fileName: localFileName,
    });

    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const contentLength = response.headers.get("content-length");
      const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
      const fileStream = Bun.file(localFilePath).writer();
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      let downloadedBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        await fileStream.write(value);
        downloadedBytes += value.byteLength;

        modelDownloads.set(downloadId, {
          status: "downloading",
          progress: totalBytes > 0 ? Math.floor((downloadedBytes / totalBytes) * 100) : 0,
          fileName: localFileName,
          downloadedBytes,
          totalBytes,
        });
      }

      await fileStream.end();

      const stats = statSync(localFilePath);
      if (stats.size <= minModelBytes) {
        unlinkSync(localFilePath);
        throw new Error(`Download failed - file too small (${stats.size} bytes)`);
      }

      modelDownloads.set(downloadId, {
        status: "completed",
        progress: 100,
        fileName: localFileName,
        downloadedBytes: stats.size,
        totalBytes: stats.size,
      });
    } catch (error) {
      if (existsSync(localFilePath)) {
        try {
          unlinkSync(localFilePath);
        } catch {
          // Ignore cleanup failures.
        }
      }

      modelDownloads.set(downloadId, {
        status: "failed",
        progress: 0,
        fileName: localFileName,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  })();

  return {
    ok: true,
    downloading: true,
    downloadId,
  };
}

async function llamaDownloadStatus(params: { downloadId?: string }) {
  if (params.downloadId) {
    return {
      ok: true,
      status: modelDownloads.get(String(params.downloadId || "")),
    };
  }

  const downloads: Record<string, DownloadStatus> = {};
  for (const [downloadId, status] of modelDownloads.entries()) {
    downloads[downloadId] = status;
  }

  return {
    ok: true,
    downloads,
  };
}

async function llamaRemoveModel(params: { modelPath?: string }) {
  const modelPath = String(params.modelPath || "");
  try {
    if (!existsSync(modelPath)) {
      return {
        ok: false,
        error: "Model file not found",
      };
    }

    unlinkSync(modelPath);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to remove model",
    };
  }
}

async function handleRequest(method: string, params: any) {
  switch (method) {
    case "llamaCompletion":
      return llamaCompletion(params ?? {});
    case "llamaListModels":
      return llamaListModels();
    case "llamaInstallModel":
      return llamaInstallModel(params ?? {});
    case "llamaDownloadStatus":
      return llamaDownloadStatus(params ?? {});
    case "llamaRemoveModel":
      return llamaRemoveModel(params ?? {});
    default:
      return undefined;
  }
}

process.on("exit", () => {
  killActiveCompletions();
});

self.onmessage = async (event) => {
  const message = event.data as {
    type?: string;
    requestId?: number;
    method?: string;
    params?: unknown;
  } | undefined;

  if (message?.type === "init") {
    initializeRuntimeContext(message as WorkerRuntimeContext);
    return;
  }

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
