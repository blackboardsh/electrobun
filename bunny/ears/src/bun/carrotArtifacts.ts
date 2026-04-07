import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { CarrotInstallSource } from "../carrot-runtime/types";

type ArtifactUpdateInfo = {
  version?: string;
  hash?: string;
  platform?: string;
  arch?: string;
  tarball?: string;
  baseUrl?: string;
};

export type PreparedArtifactPayload = {
  payloadDir: string;
  source: CarrotInstallSource;
  currentHash: string | null;
  cleanup: () => void;
};

function looksLikeUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function getRuntimeBinary(name: string) {
  const executableDir = dirname(process.execPath);
  const suffix = process.platform === "win32" ? ".exe" : "";
  return join(executableDir, `${name}${suffix}`);
}

function resolveBinary(candidates: string[]) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) {
        return candidate;
      }
      continue;
    }

    const resolved = Bun.which(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function runCommandOrThrow(args: string[], label: string) {
  const result = Bun.spawnSync(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode === 0) {
    return;
  }

  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  const detail = [stdout, stderr].filter(Boolean).join("\n");
  throw new Error(`${label} failed${detail ? `\n${detail}` : ""}`);
}

function buildZstdArgs(
  binaryPath: string,
  mode: "compress" | "decompress",
  inputPath: string,
  outputPath: string,
) {
  const binaryName = basename(binaryPath).toLowerCase();
  if (binaryName.includes("zig-zstd")) {
    return [binaryPath, mode, "-i", inputPath, "-o", outputPath, "--no-timing"];
  }

  return mode === "compress"
    ? [binaryPath, "-f", inputPath, "-o", outputPath]
    : [binaryPath, "-d", "-f", inputPath, "-o", outputPath];
}

function findPreparedPayloadDir(rootDir: string): string {
  const manifestPath = join(rootDir, "carrot.json");
  if (existsSync(manifestPath)) {
    return rootDir;
  }

  const childDirectories = readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(rootDir, entry.name));

  const directMatches = childDirectories.filter((childDir) =>
    existsSync(join(childDir, "carrot.json")),
  );

  if (directMatches.length === 1) {
    return directMatches[0];
  }

  if (childDirectories.length === 1) {
    return findPreparedPayloadDir(childDirectories[0]);
  }

  throw new Error(`Artifact does not contain a prepared carrot payload: ${rootDir}`);
}

async function readUpdateInfoAsync(location: string) {
  if (looksLikeUrl(location)) {
    const response = await fetch(location);
    if (!response.ok) {
      throw new Error(`Failed to fetch artifact update.json (${response.status})`);
    }
    return (await response.json()) as ArtifactUpdateInfo;
  }

  if (!isFile(location)) {
    throw new Error(`Artifact update.json not found: ${location}`);
  }

  return JSON.parse(await Bun.file(location).text()) as ArtifactUpdateInfo;
}

function resolveLocalTarballFromUpdate(updateLocation: string, info: ArtifactUpdateInfo) {
  const baseDir = dirname(updateLocation);

  if (info.tarball) {
    const tarballPath = resolve(baseDir, info.tarball);
    if (!existsSync(tarballPath)) {
      throw new Error(`Artifact tarball not found: ${tarballPath}`);
    }
    return { tarballLocation: tarballPath, baseUrl: baseDir };
  }

  if (info.hash) {
    const hashTarball = join(baseDir, `${info.hash}.tar.zst`);
    if (existsSync(hashTarball)) {
      return { tarballLocation: hashTarball, baseUrl: baseDir };
    }
  }

  const tarballs = readdirSync(baseDir)
    .filter((entry) => entry.endsWith(".tar.zst"))
    .map((entry) => join(baseDir, entry));

  if (tarballs.length === 1) {
    return { tarballLocation: tarballs[0], baseUrl: baseDir };
  }

  throw new Error(
    `Unable to resolve artifact tarball from ${basename(updateLocation)}. Add "tarball" to update.json or keep exactly one .tar.zst beside it.`,
  );
}

function resolveRemoteTarballFromUpdate(updateLocation: string, info: ArtifactUpdateInfo) {
  const baseUrl = info.baseUrl ?? new URL(".", updateLocation).href;

  if (info.tarball) {
    return {
      tarballLocation: new URL(info.tarball, baseUrl).href,
      baseUrl,
    };
  }

  if (info.hash) {
    return {
      tarballLocation: new URL(`${info.hash}.tar.zst`, baseUrl).href,
      baseUrl,
    };
  }

  throw new Error(`Remote artifact update.json must provide "tarball" or "hash".`);
}

async function downloadArtifact(url: string, tempRoot: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download artifact (${response.status}): ${url}`);
  }

  const destination = join(tempRoot, basename(new URL(url).pathname || "artifact.tar.zst"));
  await Bun.write(destination, await response.arrayBuffer());
  return destination;
}

function extractTarballToPayloadDir(archivePath: string, tempRoot: string) {
  const zstdBinary = resolveBinary([
    process.env.BUNNY_EARS_ZSTD_BIN || "",
    getRuntimeBinary("zig-zstd"),
    "zig-zstd",
    "zstd",
  ]);
  if (!zstdBinary) {
    throw new Error(`Unable to locate zig-zstd or zstd for artifact extraction.`);
  }

  const tarBinary = resolveBinary([process.env.BUNNY_EARS_TAR_BIN || "", "tar", "bsdtar"]);
  if (!tarBinary) {
    throw new Error(`Unable to locate tar for artifact extraction.`);
  }

  const tarPath = join(tempRoot, "artifact.tar");
  const extractDir = join(tempRoot, "extract");
  mkdirSync(extractDir, { recursive: true });

  runCommandOrThrow(
    buildZstdArgs(zstdBinary, "decompress", archivePath, tarPath),
    "Artifact zstd decompression",
  );
  runCommandOrThrow([tarBinary, "-xf", tarPath, "-C", extractDir], "Artifact tar extraction");

  return findPreparedPayloadDir(extractDir);
}

export function looksLikePreparedArtifactDirectory(path: string) {
  return isDirectory(path) && existsSync(join(path, "carrot.json"));
}

export async function prepareArtifactPayloadFromPath(
  inputPath: string,
  tempRootBase: string,
): Promise<PreparedArtifactPayload> {
  const tempRoot = mkdtempSync(join(tempRootBase, ".artifact-"));

  try {
    if (!looksLikeUrl(inputPath) && isDirectory(inputPath)) {
      const normalizedPath = resolve(inputPath);
      const payloadDir = findPreparedPayloadDir(normalizedPath);
      return {
        payloadDir,
        currentHash: null,
        source: {
          kind: "artifact",
          location: normalizedPath,
        },
        cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
      };
    }

    // Strip query string and fragment when sniffing the file extension —
    // URLs may include cache-busting query strings like `?t=12345`.
    const lowerPath = inputPath.toLowerCase().split("?")[0]!.split("#")[0]!;
    if (lowerPath.endsWith(".tar.zst")) {
      const archivePath = looksLikeUrl(inputPath)
        ? await downloadArtifact(inputPath, tempRoot)
        : resolve(inputPath);
      const payloadDir = extractTarballToPayloadDir(archivePath, tempRoot);
      return {
        payloadDir,
        currentHash: null,
        source: {
          kind: "artifact",
          location: inputPath,
          tarballLocation: inputPath,
        },
        cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
      };
    }

    if (lowerPath.endsWith(".json")) {
      const info = await readUpdateInfoAsync(inputPath);
      const resolved = looksLikeUrl(inputPath)
        ? resolveRemoteTarballFromUpdate(inputPath, info)
        : resolveLocalTarballFromUpdate(resolve(inputPath), info);
      const archivePath = looksLikeUrl(resolved.tarballLocation)
        ? await downloadArtifact(resolved.tarballLocation, tempRoot)
        : resolved.tarballLocation;
      const payloadDir = extractTarballToPayloadDir(archivePath, tempRoot);
      return {
        payloadDir,
        currentHash: info.hash ?? null,
        source: {
          kind: "artifact",
          location: inputPath,
          updateLocation: inputPath,
          tarballLocation: resolved.tarballLocation,
          currentHash: info.hash ?? null,
          baseUrl: resolved.baseUrl ?? null,
        },
        cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
      };
    }

    throw new Error(
      `Unsupported artifact selection: ${inputPath}. Choose a prepared folder, .tar.zst, or update.json.`,
    );
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}
