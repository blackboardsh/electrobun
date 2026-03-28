import { Utils } from "electrobun/bun";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { prepareArtifactPayloadFromPath } from "./carrotArtifacts";
import { buildCarrotSource } from "./carrotBuilder";
import type {
  CarrotInstallRecord,
  CarrotInstallSource,
  CarrotManifest,
  CarrotPermissionGrant,
  CarrotRegistry,
} from "../carrot-runtime/types";
import { flattenCarrotPermissions, normalizeCarrotPermissions } from "../carrot-runtime/types";

const INSTALLED_CARROTS_ROOT =
  process.env.BUNNY_EARS_CARROT_ROOT || join(Utils.paths.userData, "carrots");
const REGISTRY_PATH = join(INSTALLED_CARROTS_ROOT, "registry.json");
const REGISTRY_VERSION = 1;

export type InstalledCarrot = {
  install: CarrotInstallRecord;
  manifest: CarrotManifest;
  rootDir: string;
  currentDir: string;
  stateDir: string;
  extractionDir: string;
  installPath: string;
  bundleWorkerPath: string;
  workerPath: string;
  viewPath: string;
  viewUrl: string;
};

export type PreparedCarrotInstall = {
  preparedDir: string;
  manifest: CarrotManifest;
  previousInstall: CarrotInstallRecord | null;
  source: CarrotInstallSource;
  devMode: boolean;
  lastBuildAt: number | null;
  currentHash: string | null;
  install: (permissionsGranted?: CarrotPermissionGrant) => Promise<InstalledCarrot>;
  cleanup: () => void;
};

type CarrotPaths = {
  rootDir: string;
  currentDir: string;
  stateDir: string;
  extractionDir: string;
  installPath: string;
};

type InstallPreparedCarrotOptions = {
  source: CarrotInstallSource;
  currentHash?: string | null;
  permissionsGranted?: CarrotPermissionGrant;
  previousInstall?: CarrotInstallRecord;
  devMode?: boolean;
  lastBuildAt?: number | null;
};

function ensureStoreRoot() {
  mkdirSync(INSTALLED_CARROTS_ROOT, { recursive: true });
}

export function getInstalledCarrotsRoot() {
  ensureStoreRoot();
  return INSTALLED_CARROTS_ROOT;
}

function getCarrotPaths(id: string): CarrotPaths {
  const rootDir = join(INSTALLED_CARROTS_ROOT, id);
  return {
    rootDir,
    currentDir: join(rootDir, "current"),
    stateDir: join(rootDir, "data"),
    extractionDir: join(rootDir, "self-extraction"),
    installPath: join(rootDir, "install.json"),
  };
}

function normalizeInstallSource(
  source: CarrotInstallSource,
  fallbackHash: string | null,
): CarrotInstallSource {
  if (source.kind === "local") {
    const legacySegment = `${sep}bunny${sep}carrots${sep}`;
    const nextSegment = `${sep}bunny${sep}test-carrots${sep}`;
    if (source.path.includes(legacySegment) && !existsSync(source.path)) {
      const migratedPath = source.path.replace(legacySegment, nextSegment);
      if (migratedPath !== source.path && existsSync(migratedPath)) {
        return {
          kind: "local",
          path: migratedPath,
        };
      }
    }
    return source;
  }

  if (source.kind !== "artifact") {
    return source;
  }

  const legacySource = source as CarrotInstallSource & { baseUrl?: string; location?: string };
  if (!legacySource.location) {
    return {
      kind: "artifact",
      location: legacySource.baseUrl ?? "",
      updateLocation: null,
      tarballLocation: null,
      currentHash: fallbackHash,
      baseUrl: legacySource.baseUrl ?? null,
    };
  }

  return {
    kind: "artifact",
    location: source.location,
    updateLocation: source.updateLocation ?? null,
    tarballLocation: source.tarballLocation ?? null,
    currentHash: source.currentHash ?? fallbackHash,
    baseUrl: source.baseUrl ?? null,
  };
}

function readManifestAt(manifestPath: string): CarrotManifest {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CarrotManifest & {
    permissions?: CarrotManifest["permissions"] | string[];
  };
  return {
    ...manifest,
    permissions: normalizeCarrotPermissions(manifest.permissions),
  };
}

function normalizeInstallRecord(record: CarrotInstallRecord): CarrotInstallRecord {
  return {
    ...record,
    source: normalizeInstallSource(record.source, record.currentHash),
    permissionsGranted: normalizeCarrotPermissions(record.permissionsGranted as any),
    devMode: record.devMode ?? false,
    lastBuildAt: record.lastBuildAt ?? null,
    lastBuildError: record.lastBuildError ?? null,
  };
}

function readInstallRecordAt(installPath: string): CarrotInstallRecord | null {
  if (!existsSync(installPath)) {
    return null;
  }

  try {
    return normalizeInstallRecord(
      JSON.parse(readFileSync(installPath, "utf8")) as CarrotInstallRecord,
    );
  } catch {
    return null;
  }
}

function resolveInside(rootDir: string, relativePath: string) {
  const normalizedRoot = resolve(rootDir);
  const resolvedPath = resolve(rootDir, relativePath);
  if (
    resolvedPath !== normalizedRoot &&
    !resolvedPath.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new Error(`Path escapes carrot root: ${relativePath}`);
  }
  return resolvedPath;
}

function toViewsUrl(relativePath: string) {
  return `views://${relativePath.replace(/^\/+/, "")}`;
}

function writeWorkerBootstrap(
  currentDir: string,
  manifest: CarrotManifest,
  install: CarrotInstallRecord,
  bundleWorkerPath: string,
  stateDir: string,
) {
  const bootstrapDir = join(currentDir, ".bunny");
  const bootstrapPath = join(bootstrapDir, "carrot-bun-entrypoint.mjs");
  const workerRelativePath = bundleWorkerPath
    .slice(currentDir.length + 1)
    .replaceAll(sep, "/");
  const workerImportPath = workerRelativePath.startsWith(".")
    ? workerRelativePath
    : `../${workerRelativePath}`;

  mkdirSync(bootstrapDir, { recursive: true });
  writeFileSync(
    bootstrapPath,
    [
      `globalThis.__bunnyCarrotBootstrap = ${JSON.stringify({
        manifest,
        context: {
          statePath: join(stateDir, "state.json"),
          logsPath: join(stateDir, "logs.txt"),
          permissions: flattenCarrotPermissions(install.permissionsGranted),
          grantedPermissions: install.permissionsGranted,
        },
      })};`,
      `await import(${JSON.stringify(workerImportPath)});`,
      "",
    ].join("\n"),
  );

  return bootstrapPath;
}

function assertPreparedCarrotPayload(sourceDir: string) {
  const manifestPath = join(sourceDir, "carrot.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing carrot.json in ${sourceDir}`);
  }

  const manifest = readManifestAt(manifestPath);
  const workerPath = resolveInside(sourceDir, manifest.worker.relativePath);

  if (!existsSync(workerPath)) {
    throw new Error(`Missing worker for ${manifest.id}: ${workerPath}`);
  }

  if (manifest.view?.relativePath) {
    const viewPath = resolveInside(sourceDir, manifest.view.relativePath);
    if (!existsSync(viewPath)) {
      throw new Error(`Missing view entry for ${manifest.id}: ${viewPath}`);
    }
  }

  return { manifest };
}

function readRegistry(): CarrotRegistry {
  ensureStoreRoot();
  if (!existsSync(REGISTRY_PATH)) {
    return {
      version: REGISTRY_VERSION,
      carrots: {},
    };
  }

  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as CarrotRegistry;
  } catch {
    return {
      version: REGISTRY_VERSION,
      carrots: {},
    };
  }
}

function writeRegistry(registry: CarrotRegistry) {
  ensureStoreRoot();
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

function loadInstalledCarrot(record: CarrotInstallRecord): InstalledCarrot | null {
  const paths = getCarrotPaths(record.id);
  const manifestPath = join(paths.currentDir, "carrot.json");
  if (!existsSync(manifestPath)) {
    return null;
  }

  const manifest = readManifestAt(manifestPath);
  const bundleWorkerPath = resolveInside(paths.currentDir, manifest.worker.relativePath);
  const viewPath = manifest.view?.relativePath
    ? resolveInside(paths.currentDir, manifest.view.relativePath)
    : "";

  if (!existsSync(bundleWorkerPath)) {
    return null;
  }
  if (viewPath && !existsSync(viewPath)) {
    return null;
  }

  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.extractionDir, { recursive: true });
  const workerPath = writeWorkerBootstrap(
    paths.currentDir,
    manifest,
    record,
    bundleWorkerPath,
    paths.stateDir,
  );

  return {
    install: record,
    manifest,
    ...paths,
    bundleWorkerPath,
    workerPath,
    viewPath,
    viewUrl: manifest.view?.relativePath ? toViewsUrl(manifest.view.relativePath) : "",
  };
}

export function getInstalledCarrot(id: string) {
  const record = readInstalledRecord(id);
  return record ? loadInstalledCarrot(record) : null;
}

function readInstalledRecord(id: string) {
  return readInstallRecordAt(getCarrotPaths(id).installPath);
}

function syncRegistryFromInstalledRecords(records: CarrotInstallRecord[]) {
  const registry: CarrotRegistry = {
    version: REGISTRY_VERSION,
    carrots: {},
  };

  for (const record of records) {
    registry.carrots[record.id] = record;
  }

  writeRegistry(registry);
}

function loadAllInstallRecords() {
  const registry = readRegistry();
  const records = new Map<string, CarrotInstallRecord>();

  for (const record of Object.values(registry.carrots)) {
    records.set(record.id, normalizeInstallRecord(record));
  }

  for (const directory of listInstalledCarrotDirectories()) {
    const record = readInstalledRecord(directory);
    if (record) {
      records.set(record.id, record);
    }
  }

  const installedRecords = Array.from(records.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  syncRegistryFromInstalledRecords(installedRecords);
  return installedRecords;
}

function writeInstallRecord(installRecord: CarrotInstallRecord) {
  const normalized = normalizeInstallRecord(installRecord);
  const paths = getCarrotPaths(normalized.id);
  mkdirSync(paths.rootDir, { recursive: true });
  writeFileSync(paths.installPath, JSON.stringify(normalized, null, 2));
  return normalized;
}

function updateInstallRecord(
  id: string,
  updater: (record: CarrotInstallRecord) => CarrotInstallRecord,
) {
  const existing = readInstalledRecord(id);
  if (!existing) {
    return null;
  }

  const updated = writeInstallRecord(updater(existing));
  loadAllInstallRecords();
  return updated;
}

function installPreparedCarrot(
  sourceDir: string,
  options: InstallPreparedCarrotOptions,
) {
  const { manifest } = assertPreparedCarrotPayload(sourceDir);
  const previousInstall = options.previousInstall ?? readInstalledRecord(manifest.id);
  const paths = getCarrotPaths(manifest.id);

  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.extractionDir, { recursive: true });
  const tempRootDir = mkdtempSync(join(paths.rootDir, "incoming-"));
  const tempCurrentDir = join(tempRootDir, "current");

  try {
    cpSync(sourceDir, tempCurrentDir, {
      recursive: true,
      force: true,
    });

    rmSync(paths.currentDir, { recursive: true, force: true });
    renameSync(tempCurrentDir, paths.currentDir);
  } catch (error) {
    rmSync(tempRootDir, { recursive: true, force: true });
    throw error;
  }

  const installRecord = writeInstallRecord({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    currentHash: options.currentHash ?? previousInstall?.currentHash ?? null,
    installedAt: previousInstall?.installedAt ?? Date.now(),
    updatedAt: Date.now(),
    permissionsGranted: normalizeCarrotPermissions(
      options.permissionsGranted ?? manifest.permissions,
    ),
    devMode: options.devMode ?? previousInstall?.devMode ?? false,
    lastBuildAt: options.lastBuildAt ?? previousInstall?.lastBuildAt ?? null,
    lastBuildError: null,
    status: "installed",
    source: options.source,
  });

  loadAllInstallRecords();

  try {
    const installed = loadInstalledCarrot(installRecord);
    if (!installed) {
      throw new Error(`Installed carrot is invalid: ${installRecord.id}`);
    }

    return installed;
  } finally {
    rmSync(tempRootDir, { recursive: true, force: true });
  }
}

function normalizeBuildError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function looksLikeSourceDirectory(path: string) {
  return (
    existsSync(join(path, "carrot.json")) ||
    existsSync(join(path, "web")) ||
    existsSync(join(path, "build.ts")) ||
    existsSync(join(path, "worker.ts"))
  );
}

function resolveWorkspaceDependencyPath(sourceDir: string, dependencyId: string) {
  const dependencyName = dependencyId.split(".").pop() || dependencyId;
  const bunnyRoot = resolve(sourceDir, "..");
  const candidates = [
    resolve(bunnyRoot, dependencyName),
    resolve(bunnyRoot, "foundation-carrots", dependencyName),
    resolve(bunnyRoot, "test-carrots", dependencyName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isDirectory() && looksLikeSourceDirectory(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to resolve workspace dependency ${dependencyId} from ${sourceDir}`,
  );
}

function resolveDependencySourcePath(
  parentSource: CarrotInstallSource,
  dependencyId: string,
  specifier: string,
) {
  if (parentSource.kind !== "local") {
    throw new Error(
      `Dependency ${dependencyId} uses ${specifier}, but only local source installs currently support file/workspace carrot dependencies`,
    );
  }

  if (specifier.startsWith("file:")) {
    return resolve(parentSource.path, specifier.slice("file:".length));
  }

  if (specifier.startsWith("workspace:")) {
    return resolveWorkspaceDependencyPath(parentSource.path, dependencyId);
  }

  throw new Error(
    `Unsupported carrot dependency specifier for ${dependencyId}: ${specifier}. Only file: and workspace: are supported right now.`,
  );
}

async function installDependencyTree(
  manifest: CarrotManifest,
  source: CarrotInstallSource,
  visited: Set<string>,
) {
  const dependencies = manifest.dependencies ?? {};
  for (const [dependencyId, specifier] of Object.entries(dependencies)) {
    if (visited.has(dependencyId)) {
      continue;
    }
    visited.add(dependencyId);

    const dependencySourceDir = resolveDependencySourcePath(source, dependencyId, specifier);
    const preparedDependency = await prepareDevCarrotInstallFromSource(dependencySourceDir);
    try {
      if (preparedDependency.manifest.id !== dependencyId) {
        throw new Error(
          `Dependency ${dependencyId} resolved to ${preparedDependency.manifest.id} at ${dependencySourceDir}`,
        );
      }

      await installDependencyTree(
        preparedDependency.manifest,
        preparedDependency.source,
        visited,
      );

      const existing = readInstalledRecord(dependencyId);
      installPreparedCarrot(preparedDependency.preparedDir, {
        source: preparedDependency.source,
        currentHash: preparedDependency.currentHash ?? existing?.currentHash ?? null,
        previousInstall: existing ?? preparedDependency.previousInstall ?? undefined,
        permissionsGranted: existing?.permissionsGranted,
        devMode: preparedDependency.devMode,
        lastBuildAt: preparedDependency.lastBuildAt,
      });
    } finally {
      preparedDependency.cleanup();
    }
  }
}

function createPreparedInstall(
  preparedDir: string,
  options: {
    source: CarrotInstallSource;
    previousInstall?: CarrotInstallRecord | null;
    currentHash?: string | null;
    devMode?: boolean;
    lastBuildAt?: number | null;
    cleanup?: () => void;
  },
): PreparedCarrotInstall {
  const { manifest } = assertPreparedCarrotPayload(preparedDir);
  const previousInstall = options.previousInstall ?? readInstalledRecord(manifest.id);

  return {
    preparedDir,
    manifest,
    previousInstall: previousInstall ?? null,
    source: options.source,
    devMode: options.devMode ?? false,
    lastBuildAt: options.lastBuildAt ?? null,
    currentHash: options.currentHash ?? previousInstall?.currentHash ?? null,
    install: async (permissionsGranted) => {
      const visited = new Set<string>([manifest.id]);
      await installDependencyTree(manifest, options.source, visited);
      return installPreparedCarrot(preparedDir, {
        source: options.source,
        currentHash: options.currentHash ?? previousInstall?.currentHash ?? null,
        previousInstall: previousInstall ?? undefined,
        permissionsGranted,
        devMode: options.devMode ?? false,
        lastBuildAt: options.lastBuildAt ?? null,
      });
    },
    cleanup: options.cleanup ?? (() => {}),
  };
}

async function buildSourceIntoTemp(sourceDir: string) {
  ensureStoreRoot();
  const tempPayloadDir = mkdtempSync(join(INSTALLED_CARROTS_ROOT, ".build-"));

  try {
    const manifest = await buildCarrotSource(sourceDir, tempPayloadDir);
    return { manifest, tempPayloadDir };
  } catch (error) {
    rmSync(tempPayloadDir, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareDevCarrotInstallFromSource(
  sourceDir: string,
): Promise<PreparedCarrotInstall> {
  const normalizedSourceDir = resolve(sourceDir);
  if (!existsSync(normalizedSourceDir) || !statSync(normalizedSourceDir).isDirectory()) {
    throw new Error(`Carrot source folder not found: ${normalizedSourceDir}`);
  }

  if (!looksLikeSourceDirectory(normalizedSourceDir)) {
    throw new Error(
      `Selected folder does not look like a Carrot source tree: ${normalizedSourceDir}`,
    );
  }

  const { tempPayloadDir } = await buildSourceIntoTemp(normalizedSourceDir);
  return createPreparedInstall(tempPayloadDir, {
    source: {
      kind: "local",
      path: normalizedSourceDir,
    },
    devMode: true,
    lastBuildAt: Date.now(),
    cleanup: () => rmSync(tempPayloadDir, { recursive: true, force: true }),
  });
}

export async function prepareArtifactCarrotInstall(
  selection: string,
): Promise<PreparedCarrotInstall> {
  const normalizedSelection = /^https?:\/\//i.test(selection)
    ? selection
    : resolve(selection);

  if (existsSync(normalizedSelection) && statSync(normalizedSelection).isDirectory()) {
    if (looksLikeSourceDirectory(normalizedSelection)) {
      throw new Error(
        `Selected folder is a Carrot source tree. Use “Install Carrot Source” for ${normalizedSelection}`,
      );
    }
  }

  ensureStoreRoot();
  const prepared = await prepareArtifactPayloadFromPath(
    normalizedSelection,
    INSTALLED_CARROTS_ROOT,
  );

  return createPreparedInstall(prepared.payloadDir, {
    source: prepared.source,
    currentHash: prepared.currentHash,
    devMode: false,
    lastBuildAt: null,
    cleanup: prepared.cleanup,
  });
}

/**
 * Install a carrot from a pre-built artifact directory.
 * The directory must contain carrot.json + worker.js + optional view files.
 * No build step is performed — the artifact is copied directly.
 */
export function installPrebuiltCarrot(
  artifactDir: string,
  permissionsGranted?: CarrotPermissionGrant,
) {
  const { manifest } = assertPreparedCarrotPayload(artifactDir);
  return installPreparedCarrot(artifactDir, {
    source: { kind: "artifact" as const, location: artifactDir },
    permissionsGranted: permissionsGranted ?? manifest.permissions,
    devMode: false,
  });
}

export async function installDevCarrotFromSource(
  sourceDir: string,
  permissionsGranted?: CarrotPermissionGrant,
) {
  const prepared = await prepareDevCarrotInstallFromSource(sourceDir);
  try {
    return await prepared.install(permissionsGranted);
  } finally {
    prepared.cleanup();
  }
}

async function prepareReinstall(record: CarrotInstallRecord) {
  switch (record.source.kind) {
    case "local":
      return prepareDevCarrotInstallFromSource(record.source.path);
    case "artifact": {
      if (record.source.updateLocation) {
        return prepareArtifactCarrotInstall(record.source.updateLocation);
      }
      if (record.source.tarballLocation) {
        return prepareArtifactCarrotInstall(record.source.tarballLocation);
      }
      return prepareArtifactCarrotInstall(record.source.location);
    }
    case "prototype":
      throw new Error(`Prototype carrots cannot be reinstalled: ${record.id}`);
  }
}

export async function reinstallInstalledCarrot(
  id: string,
  permissionsGranted?: CarrotPermissionGrant,
) {
  const record = readInstalledRecord(id);
  if (!record) {
    throw new Error(`Carrot is not installed: ${id}`);
  }

  const prepared = await prepareReinstall(record);
  try {
    return await prepared.install(permissionsGranted ?? record.permissionsGranted);
  } finally {
    prepared.cleanup();
  }
}

export async function rebuildInstalledDevCarrot(id: string) {
  const existing = readInstalledRecord(id);
  if (!existing || existing.devMode !== true || existing.source.kind !== "local") {
    throw new Error(`Carrot is not installed in dev mode: ${id}`);
  }

  try {
    return await reinstallInstalledCarrot(id, existing.permissionsGranted);
  } catch (error) {
    updateInstallRecord(id, (record) => ({
      ...record,
      status: "broken",
      lastBuildError: normalizeBuildError(error),
    }));
    throw error;
  }
}

export async function refreshTrackedDevCarrots() {
  const errors: Array<{ id: string; error: string }> = [];
  const records = loadAllInstallRecords();

  for (const record of records) {
    if (record.devMode !== true || record.source.kind !== "local") {
      continue;
    }

    try {
      await installDevCarrotFromSource(record.source.path, record.permissionsGranted);
    } catch (error) {
      const message = normalizeBuildError(error);
      errors.push({ id: record.id, error: message });
      updateInstallRecord(record.id, (current) => ({
        ...current,
        status: "broken",
        lastBuildError: message,
      }));
    }
  }

  return errors;
}

export function uninstallInstalledCarrot(id: string) {
  const record = readInstalledRecord(id);
  if (!record) {
    return null;
  }

  rmSync(getCarrotPaths(id).rootDir, { recursive: true, force: true });
  loadAllInstallRecords();
  return record;
}

export function pruneLegacyPrototypeCarrots() {
  const records = loadAllInstallRecords();
  const keptRecords: CarrotInstallRecord[] = [];

  for (const record of records) {
    if (record.source.kind === "prototype") {
      rmSync(getCarrotPaths(record.id).rootDir, { recursive: true, force: true });
      continue;
    }
    keptRecords.push(record);
  }

  syncRegistryFromInstalledRecords(keptRecords);
}

export function loadInstalledCarrots(): InstalledCarrot[] {
  return loadAllInstallRecords()
    .map((record) => loadInstalledCarrot(record))
    .filter((carrot): carrot is InstalledCarrot => carrot !== null)
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

export function listInstalledCarrotDirectories() {
  ensureStoreRoot();
  return readdirSync(INSTALLED_CARROTS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
