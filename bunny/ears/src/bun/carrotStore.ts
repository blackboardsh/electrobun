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
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { buildCarrotSource } from "./carrotBuilder";
import type {
  CarrotInstallRecord,
  CarrotManifest,
  CarrotPermissionGrant,
  CarrotRegistry,
  CarrotInstallSource,
} from "../carrot-runtime/types";
import {
  mergeCarrotPermissions,
  normalizeCarrotPermissions,
} from "../carrot-runtime/types";

const INSTALLED_CARROTS_ROOT = join(Utils.paths.userData, "carrots");
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
  workerPath: string;
  viewPath: string;
  viewUrl: string;
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

function assertPreparedCarrotPayload(sourceDir: string) {
  const manifestPath = join(sourceDir, "carrot.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing carrot.json in ${sourceDir}`);
  }

  const manifest = readManifestAt(manifestPath);
  const workerPath = resolveInside(sourceDir, manifest.worker.relativePath);
  const viewPath = resolveInside(sourceDir, manifest.view.relativePath);

  if (!existsSync(workerPath)) {
    throw new Error(`Missing worker for ${manifest.id}: ${workerPath}`);
  }

  if (!existsSync(viewPath)) {
    throw new Error(`Missing view entry for ${manifest.id}: ${viewPath}`);
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
  const workerPath = resolveInside(paths.currentDir, manifest.worker.relativePath);
  const viewPath = resolveInside(paths.currentDir, manifest.view.relativePath);

  if (!existsSync(workerPath) || !existsSync(viewPath)) {
    return null;
  }

  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.extractionDir, { recursive: true });

  return {
    install: record,
    manifest,
    ...paths,
    workerPath,
    viewPath,
    viewUrl: toViewsUrl(manifest.view.relativePath),
  };
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
    permissionsGranted: mergeCarrotPermissions(
      manifest.permissions,
      options.permissionsGranted ?? previousInstall?.permissionsGranted,
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

function normalizeBuildError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function installDevCarrotFromSource(
  sourceDir: string,
  permissionsGranted?: CarrotPermissionGrant,
) {
  const normalizedSourceDir = resolve(sourceDir);
  const { manifest, tempPayloadDir } = await buildSourceIntoTemp(normalizedSourceDir);

  try {
    const previousInstall = readInstalledRecord(manifest.id) ?? undefined;
    return installPreparedCarrot(tempPayloadDir, {
      source: {
        kind: "local",
        path: normalizedSourceDir,
      },
      devMode: true,
      lastBuildAt: Date.now(),
      permissionsGranted,
      previousInstall,
    });
  } finally {
    rmSync(tempPayloadDir, { recursive: true, force: true });
  }
}

export async function rebuildInstalledDevCarrot(id: string) {
  const existing = readInstalledRecord(id);
  if (!existing || existing.devMode !== true || existing.source.kind !== "local") {
    throw new Error(`Carrot is not installed in dev mode: ${id}`);
  }

  try {
    return await installDevCarrotFromSource(
      existing.source.path,
      existing.permissionsGranted,
    );
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
