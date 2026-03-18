import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "bun";

type BiomeStatus = {
  installed: boolean;
  version: string;
};

const BIOME_PACKAGE_DIR = join(import.meta.dir, "@biomejs", "biome");
const BIOME_PACKAGE_JSON_PATH = join(BIOME_PACKAGE_DIR, "package.json");

function post(message: unknown) {
  self.postMessage(message);
}

function readBiomeVersion() {
  if (!existsSync(BIOME_PACKAGE_JSON_PATH)) {
    return "";
  }

  try {
    return String(JSON.parse(readFileSync(BIOME_PACKAGE_JSON_PATH, "utf8"))?.version || "");
  } catch {
    return "";
  }
}

function resolveBiomeEntrypoint() {
  const candidates = [
    join(BIOME_PACKAGE_DIR, "bin", "biome"),
    join(BIOME_PACKAGE_DIR, "bin", "biome.js"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Missing bundled biome entrypoint in ${BIOME_PACKAGE_DIR}`);
}

async function runBiome(args: string[], cwd = "/") {
  const entrypoint = resolveBiomeEntrypoint();
  const proc = spawn([process.execPath, entrypoint, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // @ts-ignore Bun-specific custom binary flag
    allowUnsafeCustomBinary: true,
  });

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    stdout: stdoutText,
    stderr: stderrText,
    exitCode: Number(exitCode || 0),
  };
}

async function formatFile(path: string) {
  const result = await runBiome(["format", "--write", path], dirname(path));
  return {
    success: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function getBiomeStatus(): BiomeStatus {
  return {
    installed: existsSync(BIOME_PACKAGE_JSON_PATH),
    version: readBiomeVersion(),
  };
}

async function handleRequest(method: string, params: any) {
  switch (method) {
    case "formatFile":
      return formatFile(String(params?.path || ""));
    case "getBiomeStatus":
      return getBiomeStatus();
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
