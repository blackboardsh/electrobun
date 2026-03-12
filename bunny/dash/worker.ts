import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  createDashDb,
  type DashDb,
  type DashDocumentTypes,
  migrateLegacyExampleData,
  seedDashDb,
  type LayoutWindow,
  type WindowTabId,
} from "./db";
import { TerminalManager } from "./terminalManager";

type ColabPane =
  | {
      id: string;
      tabIds: string[];
      currentTabId: string | null;
      type: "pane";
    }
  | {
      id: string;
      direction: "row" | "column";
      divider: number;
      panes: ColabPane[];
      type: "container";
    };

type ColabWindow = {
  id: string;
  ui: {
    showSidebar: boolean;
    sidebarWidth: number;
  };
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  expansions: string[];
  rootPane: ColabPane;
  currentPaneId: string;
  tabs: Record<string, any>;
};

type ColabWorkspace = {
  id: string;
  name: string;
  color: string;
  windows: ColabWindow[];
};

type ColabAppSettings = {
  llama: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    temperature: number;
    inlineEnabled: boolean;
  };
  github: {
    accessToken: string;
    username: string;
    connectedAt?: number | undefined;
    scopes: string[];
  };
  colabCloud: {
    accessToken: string;
    refreshToken: string;
    userId: string;
    email: string;
    name: string;
    emailVerified: boolean;
    connectedAt?: number | undefined;
  };
};

type PersistedColabState = {
  workspaces?: Record<string, ColabWorkspace>;
  appSettings?: ColabAppSettings;
  tokens?: any[];
};

type TreeNode = {
  id: string;
  label: string;
  kind: "folder" | "file";
  children?: TreeNode[];
};

type Tab = {
  id: WindowTabId;
  title: string;
  kind: "editor" | "fleet" | "cloud" | "notes";
  icon: string;
  body: string;
};

type SessionSnapshot = {
  updatedAt: number;
  currentLayoutId: string;
  currentWindowId: string;
  windows: LayoutWindow[];
};

type DashState = {
  sidebarCollapsed: boolean;
  commandPaletteOpen: boolean;
  bunnyPopoverOpen: boolean;
  commandQuery: string;
  currentLayoutId: string;
  currentWindowId: string;
  activeTreeNodeId: string;
};

type WorkspaceDoc = DashDocumentTypes["workspaces"];
type ProjectMountDoc = DashDocumentTypes["projectMounts"];
type LayoutDoc = DashDocumentTypes["layouts"];
type SessionSnapshotDoc = DashDocumentTypes["sessionSnapshots"];
type UiSettingsDoc = DashDocumentTypes["uiSettings"];

type Snapshot = {
  shellTitle: string;
  subtitle: string;
  permissions: string[];
  cloudLabel: string;
  cloudStatus: string;
  commandHint: string;
  topActions: Array<{ id: string; label: string }>;
  currentLayout: {
    id: string;
    name: string;
    description: string;
  };
  currentWorkspace: {
    id: string;
    name: string;
    subtitle: string;
  };
  currentWindow: {
    id: string;
    title: string;
    currentMainTabId: string;
    currentSideTabId: string;
  };
  layouts: Array<{
    id: string;
    name: string;
    description: string;
    windowCount: number;
    isActive: boolean;
  }>;
  workspaces: Array<{
    id: string;
    name: string;
    subtitle: string;
    projectCount: number;
    isCurrent: boolean;
  }>;
  layoutWindows: Array<{
    id: string;
    title: string;
    workspaceId: string;
    workspaceName: string;
    isActive: boolean;
  }>;
  sessionSummary: {
    updatedAt: number;
    label: string;
  };
  tree: TreeNode[];
  mainTabs: Tab[];
  sideTabs: Tab[];
  stats: Array<{ label: string; value: string }>;
  state: DashState;
};

let statePath = "";
let permissions = new Set<string>();
let dashDb: DashDb | null = null;
let manifestVersion = "0.0.1";
let runtimeWindows: LayoutWindow[] = [];
let hostRequestId = 1;
let terminalManager: TerminalManager | null = null;
const pendingHostRequests = new Map<
  number,
  {
    resolve: (payload: unknown) => void;
    reject: (error: Error) => void;
  }
>();
const expandedFsDirs = new Set<string>();
const directoryWatchers = new Map<string, FSWatcher>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const LEGACY_CURRENT_SESSION_MAIN_TABS: WindowTabId[] = [
  "workspace",
  "projects",
  "layout",
  "instances",
  "cloud",
];
const LEGACY_CURRENT_SESSION_SIDE_TABS: WindowTabId[] = [
  "session",
  "windows",
  "notes",
  "cloud",
];
const DEFAULT_CURRENT_SESSION_WINDOW: LayoutWindow = {
  id: "main",
  title: "Main",
  workspaceId: "local-workspace",
  mainTabIds: ["workspace"],
  sideTabIds: ["session"],
  currentMainTabId: "workspace",
  currentSideTabId: "session",
};
let sessionSnapshot: SessionSnapshot = {
  updatedAt: Date.now(),
  currentLayoutId: "current-session",
  currentWindowId: "main",
  windows: [],
};

const defaultColabAppSettings: ColabAppSettings = {
  llama: {
    enabled: true,
    baseUrl: "llama.cpp",
    model: "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
    temperature: 0.1,
    inlineEnabled: true,
  },
  github: {
    accessToken: "",
    username: "",
    connectedAt: undefined,
    scopes: [],
  },
  colabCloud: {
    accessToken: "",
    refreshToken: "",
    userId: "",
    email: "",
    name: "",
    emailVerified: false,
    connectedAt: undefined,
  },
};

let colabState: PersistedColabState = {
  workspaces: {},
  appSettings: structuredClone(defaultColabAppSettings),
  tokens: [],
};
const UNHANDLED_COLAB_REQUEST = Symbol("unhandled-colab-request");

let state: DashState = {
  sidebarCollapsed: false,
  commandPaletteOpen: false,
  bunnyPopoverOpen: false,
  commandQuery: "",
  currentLayoutId: "current-session",
  currentWindowId: "main",
  activeTreeNodeId: "workspace-overview:local-workspace",
};

function cloneWindows(value: LayoutWindow[]) {
  return structuredClone(value);
}

function sameTabIds(left: WindowTabId[], right: WindowTabId[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "untitled";
}

function log(message: string) {
  post({ type: "action", action: "log", payload: { message } });
}

function post(message: unknown) {
  self.postMessage(message);
}

function requestHost<T = unknown>(method: string, params?: unknown): Promise<T> {
  const requestId = hostRequestId++;

  post({
    type: "host-request",
    requestId,
    method,
    params,
  });

  return new Promise<T>((resolve, reject) => {
    pendingHostRequests.set(requestId, {
      resolve: (payload) => resolve(payload as T),
      reject,
    });
  });
}

function focusWindow() {
  post({ type: "action", action: "focus-window" });
}

function stopCarrot() {
  post({ type: "action", action: "stop-carrot" });
}

function ensureDb() {
  if (!dashDb) {
    throw new Error("Bunny Dash DB has not been initialized");
  }
  return dashDb;
}

function flushDb() {
  const db = ensureDb() as any;
  if (typeof db.trySave === "function") {
    db.trySave();
  }
}

function listWorkspaces() {
  return [...(ensureDb().collection("workspaces").query().data || [])].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
}

function listProjectMounts() {
  return [...(ensureDb().collection("projectMounts").query().data || [])].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
}

function isIgnoredPath(path: string) {
  return path.includes("/node_modules/") || path.endsWith("/.DS_Store");
}

function scheduleRefresh(reason: string) {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    emitSnapshot();
    log(`filesystem refresh: ${reason}`);
  }, 80);
}

function listLayouts() {
  return [...(ensureDb().collection("layouts").query().data || [])].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
}

function findWorkspaceByKey(key: string) {
  return listWorkspaces().find((workspace) => workspace.key === key) || null;
}

function findProjectMountByKey(key: string) {
  return listProjectMounts().find((project) => project.key === key) || null;
}

function findLayoutByKey(key: string) {
  return listLayouts().find((layout) => layout.key === key) || null;
}

function getWorkspaceByKey(key: string) {
  const workspace = findWorkspaceByKey(key);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${key}`);
  }
  return workspace;
}

function getLayoutByKey(key: string) {
  const layout = findLayoutByKey(key);
  if (!layout) {
    throw new Error(`Unknown layout: ${key}`);
  }
  return layout;
}

function getProjectMountsForWorkspace(workspaceId: string) {
  return listProjectMounts().filter((project) => project.workspaceId === workspaceId);
}

function getDashHomeDir() {
  return dirname(statePath);
}

function getColabProjectsFolder() {
  const workspace = getCurrentWorkspaceUnsafe() || listWorkspaces()[0];
  const root = join(getDashHomeDir(), "projects", workspace?.key || "default");
  mkdirSync(root, { recursive: true });
  return root;
}

function makeDefaultColabWindow(id = "main"): ColabWindow {
  return {
    id,
    ui: {
      showSidebar: true,
      sidebarWidth: 250,
    },
    position: {
      x: 0,
      y: 0,
      width: 1500,
      height: 900,
    },
    expansions: [],
    rootPane: {
      id: "root",
      type: "pane",
      tabIds: [],
      currentTabId: null,
    },
    tabs: {},
    currentPaneId: "root",
  };
}

function getOrCreateColabWorkspace(workspaceId: string) {
  const workspaceDoc = getWorkspaceByKey(workspaceId);
  const workspaces = (colabState.workspaces ||= {});
  if (!workspaces[workspaceId]) {
    workspaces[workspaceId] = {
      id: workspaceId,
      name: workspaceDoc.name,
      color: "#184d8b",
      windows: [makeDefaultColabWindow("main")],
    };
  }

  workspaces[workspaceId]!.name = workspaceDoc.name;
  return workspaces[workspaceId]!;
}

function currentColabWorkspace() {
  return getOrCreateColabWorkspace(getCurrentWorkspace().key);
}

function colabProjectsForWorkspace(workspaceId: string) {
  return getProjectMountsForWorkspace(workspaceId).map((project) => ({
    id: project.key,
    name: project.name,
    path: project.path,
  }));
}

function colabBuildVars() {
  return {
    channel: "dev",
    version: manifestVersion,
    hash: "bunny-dash",
  };
}

function colabPaths() {
  const bunPath = Bun.which("bun") || "";
  const gitPath = Bun.which("git") || "";
  return {
    APP_PATH: getDashHomeDir(),
    COLAB_HOME_FOLDER: getDashHomeDir(),
    COLAB_PROJECTS_FOLDER: getColabProjectsFolder(),
    COLAB_DEPS_PATH: "",
    COLAB_ENV_PATH: "",
    BUN_BINARY_PATH: bunPath,
    BIOME_BINARY_PATH: "",
    TSSERVER_PATH: "",
    GIT_BINARY_PATH: gitPath,
    BUN_PATH: bunPath,
    BUN_DEPS_FOLDER: "",
    TYPESCRIPT_PACKAGE_PATH: "",
    BIOME_PACKAGE_PATH: "",
  };
}

function colabPeerDependencies() {
  return {
    bun: {
      installed: Boolean(Bun.which("bun")),
      version: Bun.version,
    },
    typescript: {
      installed: false,
      version: "",
    },
    biome: {
      installed: false,
      version: "",
    },
    git: {
      installed: Boolean(Bun.which("git")),
      version: "",
    },
  };
}

function emitViewMessage(name: string, payload?: unknown) {
  post({ type: "action", action: "emit-view", payload: { raw: true, name, payload } });
}

function getTerminalManager() {
  if (!terminalManager) {
    terminalManager = new TerminalManager((message) => {
      if (message.type === "terminalOutput") {
        emitViewMessage("terminalOutput", {
          terminalId: message.terminalId,
          data: message.data,
        });
      } else if (message.type === "terminalExit") {
        emitViewMessage("terminalExit", {
          terminalId: message.terminalId,
          exitCode: message.exitCode,
          signal: message.signal,
        });
      }
    });
  }

  return terminalManager;
}

function emitSetProjects() {
  const workspace = currentColabWorkspace();
  emitViewMessage("setProjects", {
    projects: colabProjectsForWorkspace(workspace.id),
    tokens: colabState.tokens || [],
    workspace,
    appSettings: colabState.appSettings || defaultColabAppSettings,
  });
}

function emitFileWatchEvent(absolutePath: string) {
  const exists = existsSync(absolutePath);
  let isFile = false;
  let isDir = false;

  if (exists) {
    try {
      const stat = statSync(absolutePath);
      isFile = stat.isFile();
      isDir = stat.isDirectory();
    } catch {}
  }

  emitViewMessage("fileWatchEvent", {
    absolutePath,
    exists,
    isDelete: !exists,
    isAdding: exists,
    isFile,
    isDir,
  });
}

function syncProjectWatchers() {
  const projects = listProjectMounts();
  const nextKeys = new Set(
    projects.filter((project) => existsSync(project.path)).map((project) => project.key),
  );

  for (const [projectKey, watcher] of directoryWatchers.entries()) {
    if (nextKeys.has(projectKey)) {
      continue;
    }
    watcher.close();
    directoryWatchers.delete(projectKey);
  }

  for (const project of projects) {
    if (!existsSync(project.path) || directoryWatchers.has(project.key)) {
      continue;
    }

    try {
      const watcher = watch(
        project.path,
        { recursive: true },
        (_eventType, relativePath) => {
          if (!relativePath) {
            return;
          }

          const absolutePath = join(project.path, relativePath);
          if (isIgnoredPath(absolutePath)) {
            return;
          }

          emitFileWatchEvent(absolutePath);
          scheduleRefresh(`project ${project.name}`);
        },
      );
      directoryWatchers.set(project.key, watcher);
    } catch (error) {
      log(
        `watch failed for ${project.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function getSessionSnapshotDoc() {
  const doc = ensureDb()
    .collection("sessionSnapshots")
    .query({ where: (item) => item.key === "last", limit: 1 }).data?.[0];

  if (!doc) {
    throw new Error("Missing Bunny Dash session snapshot");
  }

  return doc;
}

function getUiSettingsDoc() {
  const doc = ensureDb()
    .collection("uiSettings")
    .query({ where: (item) => item.key === "primary", limit: 1 }).data?.[0];

  if (!doc) {
    throw new Error("Missing Bunny Dash UI settings");
  }

  return doc;
}

function captureSessionSnapshot(): SessionSnapshot {
  return {
    updatedAt: Date.now(),
    currentLayoutId: state.currentLayoutId,
    currentWindowId: state.currentWindowId,
    windows: cloneWindows(runtimeWindows),
  };
}

function getCurrentWindowUnsafe() {
  return runtimeWindows.find((window) => window.id === state.currentWindowId) || runtimeWindows[0] || null;
}

function getCurrentWorkspaceUnsafe() {
  const currentWindow = getCurrentWindowUnsafe();
  if (!currentWindow) {
    return listWorkspaces()[0] || null;
  }

  return findWorkspaceByKey(currentWindow.workspaceId) || listWorkspaces()[0] || null;
}

function getCurrentWindow() {
  ensureRuntimeState();
  const current = getCurrentWindowUnsafe();
  if (!current) {
    throw new Error(`Unknown runtime window: ${state.currentWindowId}`);
  }
  return current;
}

function getCurrentLayout() {
  return getLayoutByKey(state.currentLayoutId);
}

function getCurrentWorkspace() {
  ensureRuntimeState();
  const currentWorkspace = getCurrentWorkspaceUnsafe();
  if (!currentWorkspace) {
    throw new Error("No current workspace available");
  }
  return currentWorkspace;
}

function ensureRuntimeState() {
  const layouts = listLayouts();
  if (!layouts.some((layout) => layout.key === state.currentLayoutId)) {
    state.currentLayoutId = layouts[0]!.key;
  }

  if (runtimeWindows.length === 0) {
    runtimeWindows = cloneWindows(getLayoutByKey(state.currentLayoutId).windows);
  }

  if (!runtimeWindows.some((window) => window.id === state.currentWindowId)) {
    state.currentWindowId = runtimeWindows[0]!.id;
  }

  const workspaceIds = new Set(listWorkspaces().map((workspace) => workspace.key));
  for (const window of runtimeWindows) {
    if (!workspaceIds.has(window.workspaceId)) {
      window.workspaceId = listWorkspaces()[0]!.key;
    }
    if (!window.mainTabIds.includes(window.currentMainTabId)) {
      window.currentMainTabId = window.mainTabIds[0]!;
    }
    if (!window.sideTabIds.includes(window.currentSideTabId)) {
      window.currentSideTabId = window.sideTabIds[0]!;
    }
  }

  if (!isTreeNodeIdValid(state.activeTreeNodeId)) {
    syncActiveTreeNode();
  }
}

function isLegacyCurrentSessionWindow(window: LayoutWindow) {
  return (
    window.id === DEFAULT_CURRENT_SESSION_WINDOW.id &&
    window.title === DEFAULT_CURRENT_SESSION_WINDOW.title &&
    window.workspaceId === DEFAULT_CURRENT_SESSION_WINDOW.workspaceId &&
    sameTabIds(window.mainTabIds, LEGACY_CURRENT_SESSION_MAIN_TABS) &&
    sameTabIds(window.sideTabIds, LEGACY_CURRENT_SESSION_SIDE_TABS)
  );
}

function normalizeCurrentSessionWindows(windows: LayoutWindow[]) {
  let didNormalize = false;
  const nextWindows = windows.map((window) => {
    if (!isLegacyCurrentSessionWindow(window)) {
      return window;
    }

    didNormalize = true;
    return {
      ...window,
      mainTabIds: [...DEFAULT_CURRENT_SESSION_WINDOW.mainTabIds],
      sideTabIds: [...DEFAULT_CURRENT_SESSION_WINDOW.sideTabIds],
      currentMainTabId: DEFAULT_CURRENT_SESSION_WINDOW.currentMainTabId,
      currentSideTabId: DEFAULT_CURRENT_SESSION_WINDOW.currentSideTabId,
    };
  });

  return {
    didNormalize,
    windows: nextWindows,
  };
}

function normalizePersistedCurrentSession() {
  const db = ensureDb();
  const snapshotDoc = getSessionSnapshotDoc();
  const uiDoc = getUiSettingsDoc();
  const currentSessionLayout = findLayoutByKey("current-session");

  const normalizedSnapshot = normalizeCurrentSessionWindows(snapshotDoc.windows);
  if (normalizedSnapshot.didNormalize) {
    db.collection("sessionSnapshots").update(snapshotDoc.id, {
      windows: cloneWindows(normalizedSnapshot.windows),
    });
  }

  if (currentSessionLayout) {
    const normalizedLayout = normalizeCurrentSessionWindows(currentSessionLayout.windows);
    if (normalizedLayout.didNormalize) {
      db.collection("layouts").update(currentSessionLayout.id, {
        windows: cloneWindows(normalizedLayout.windows),
      });
    }
  }

  if (
    normalizedSnapshot.didNormalize &&
    uiDoc.currentLayoutId === "current-session" &&
    uiDoc.activeTreeNodeId === "layout-overview:current-session"
  ) {
    db.collection("uiSettings").update(uiDoc.id, {
      activeTreeNodeId: "workspace-overview:local-workspace",
    });
  }

  if (normalizedSnapshot.didNormalize || currentSessionLayout) {
    flushDb();
  }
}

function buildStats() {
  const workspaces = listWorkspaces();
  const projects = listProjectMounts();
  const layouts = listLayouts();
  const instanceCount = new Set(projects.map((project) => project.instanceLabel)).size;

  return [
    { label: "Workspaces", value: String(workspaces.length) },
    { label: "Projects", value: String(projects.length) },
    { label: "Layouts", value: String(layouts.length) },
    { label: "Instances", value: String(instanceCount) },
  ];
}

function getSelectedFilePath() {
  if (!state.activeTreeNodeId.startsWith("fsfile:")) {
    return null;
  }
  return state.activeTreeNodeId.replace("fsfile:", "");
}

function getSelectedDirectoryPath() {
  if (!state.activeTreeNodeId.startsWith("fsdir:")) {
    return null;
  }
  return state.activeTreeNodeId.replace("fsdir:", "");
}

function formatFilePreview(path: string) {
  try {
    if (!existsSync(path)) {
      return `Missing file: ${path}`;
    }

    const stat = statSync(path);
    if (!stat.isFile()) {
      return `Not a file: ${path}`;
    }

    const maxBytes = 32 * 1024;
    const contents = readFileSync(path, "utf8");
    const snippet = contents.slice(0, maxBytes);
    const truncated = contents.length > maxBytes ? "\n\n…truncated…" : "";
    return `${path}\n\n${snippet}${truncated}`;
  } catch (error) {
    return `Unable to read file: ${path}\n\n${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function formatDirectoryPreview(path: string) {
  try {
    if (!existsSync(path)) {
      return `Missing directory: ${path}`;
    }

    const entries = readdirSync(path, { withFileTypes: true })
      .filter((entry) => !isIgnoredPath(join(path, entry.name)))
      .sort((left, right) => {
        if (left.isDirectory() && !right.isDirectory()) return -1;
        if (!left.isDirectory() && right.isDirectory()) return 1;
        return left.name.localeCompare(right.name);
      });

    if (entries.length === 0) {
      return `${path}\n\nDirectory is empty.`;
    }

    return `${path}\n\n${entries
      .slice(0, 120)
      .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
      .join("\n")}`;
  } catch (error) {
    return `Unable to read directory: ${path}\n\n${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function buildProjectFileNodes(rootPath: string): TreeNode[] {
  if (!existsSync(rootPath)) {
    return [
      {
        id: `fsmissing:${rootPath}`,
        label: "Path missing",
        kind: "file",
      },
    ];
  }
  try {
    let entries = readdirSync(rootPath, { withFileTypes: true }).filter(
      (entry) => !isIgnoredPath(join(rootPath, entry.name)),
    );
    entries = entries.sort((left, right) => {
      if (left.isDirectory() && !right.isDirectory()) return -1;
      if (!left.isDirectory() && right.isDirectory()) return 1;
      return left.name.localeCompare(right.name);
    });

    return entries.slice(0, 200).map((entry) => {
      const fullPath = join(rootPath, entry.name);
      if (entry.isDirectory()) {
        const isExpanded = expandedFsDirs.has(fullPath);
        return {
          id: `fsdir:${fullPath}`,
          label: entry.name,
          kind: "folder" as const,
          children: isExpanded ? buildProjectFileNodes(fullPath) : [],
        };
      }

      return {
        id: `fsfile:${fullPath}`,
        label: entry.name,
        kind: "file" as const,
      };
    });
  } catch (error) {
    return [
      {
        id: `fsmissing:${rootPath}`,
        label: `Unreadable: ${basename(rootPath)}`,
        kind: "file",
      },
    ];
  }
}

function buildTree(workspace: WorkspaceDoc): TreeNode[] {
  const workspaceProjects = getProjectMountsForWorkspace(workspace.key);
  const layouts = listLayouts();
  const workspaces = listWorkspaces();

  return [
    {
      id: `layout-root:${state.currentLayoutId}`,
      label: "Layout",
      kind: "folder",
      children: layouts.map((layout) => ({
        id: `layout-overview:${layout.key}`,
        label: layout.name,
        kind: "file" as const,
      })),
    },
    {
      id: `workspace:${workspace.key}`,
      label: workspace.name,
      kind: "folder",
      children: [
        {
          id: `workspace-overview:${workspace.key}`,
          label: "Overview",
          kind: "file",
        },
        ...workspaceProjects.map((project) => ({
          id: `project:${project.key}`,
          label: project.name,
          kind: "folder" as const,
          children: [
            {
              id: `project-readme:${project.key}`,
              label: "Overview",
              kind: "file" as const,
            },
            ...buildProjectFileNodes(project.path),
          ],
        })),
      ],
    },
    {
      id: "session-overview",
      label: "Session",
      kind: "folder",
      children: runtimeWindows.map((window) => ({
        id: `window:${window.id}`,
        label: window.title,
        kind: "file",
      })),
    },
    {
      id: "instances-root",
      label: "Instances",
      kind: "folder",
      children: Array.from(
        new Set(listProjectMounts().map((project) => `${project.instanceId}|${project.instanceLabel}`)),
      ).map((value) => {
        const [instanceId, instanceLabel] = value.split("|");
        return {
          id: `instance:${instanceId}`,
          label: instanceLabel,
          kind: "file" as const,
        };
      }),
    },
    {
      id: "workspace-switcher",
      label: "All Workspaces",
      kind: "folder",
      children: workspaces.map((candidate) => ({
        id: `workspace:${candidate.key}`,
        label: candidate.name,
        kind: "file" as const,
      })),
    },
  ];
}

function formatProjectsForBody(workspaceId: string) {
  const projects = getProjectMountsForWorkspace(workspaceId);
  if (projects.length === 0) {
    return "No project folders mounted yet. Use Add Project Folder to attach one to this workspace.";
  }

  return projects
    .map(
      (project) =>
        `${project.name}\n  path: ${project.path}\n  instance: ${project.instanceLabel}\n  kind: ${project.kind}\n  status: ${project.status}`,
    )
    .join("\n\n");
}

function formatProjectExplorerBody(workspaceId: string) {
  const selectedFilePath = getSelectedFilePath();
  if (selectedFilePath) {
    return formatFilePreview(selectedFilePath);
  }

  const selectedDirectoryPath = getSelectedDirectoryPath();
  if (selectedDirectoryPath) {
    return formatDirectoryPreview(selectedDirectoryPath);
  }

  const activeProjectKey = state.activeTreeNodeId.startsWith("project:")
    ? state.activeTreeNodeId.replace("project:", "")
    : state.activeTreeNodeId.startsWith("project-readme:")
      ? state.activeTreeNodeId.replace("project-readme:", "")
      : null;
  const activeProject = activeProjectKey ? findProjectMountByKey(activeProjectKey) : null;
  if (activeProject) {
    return `${activeProject.name}\n\npath: ${activeProject.path}\ninstance: ${activeProject.instanceLabel}\nkind: ${activeProject.kind}\nstatus: ${activeProject.status}`;
  }

  return formatProjectsForBody(workspaceId);
}

function buildTab(
  tabId: WindowTabId,
  currentWorkspace: WorkspaceDoc,
  currentLayout: LayoutDoc,
  currentWindow: LayoutWindow,
): Tab {
  switch (tabId) {
    case "workspace":
      return {
        id: tabId,
        title: "Workspace",
        kind: "editor",
        icon: "▤",
        body: `${currentWorkspace.name}\n\n${currentWorkspace.subtitle}\n\nProjects\n${formatProjectsForBody(currentWorkspace.key)}`,
      };
    case "projects":
      return {
        id: tabId,
        title: "Projects",
        kind: "editor",
        icon: "◫",
        body: formatProjectExplorerBody(currentWorkspace.key),
      };
    case "layout":
      return {
        id: tabId,
        title: "Layout",
        kind: "fleet",
        icon: "▥",
        body: `${currentLayout.name}\n\n${currentLayout.description}\n\nWindows\n${runtimeWindows
          .map((window) => `- ${window.title} (${getWorkspaceByKey(window.workspaceId).name})`)
          .join("\n")}`,
      };
    case "instances":
      return {
        id: tabId,
        title: "Instances",
        kind: "fleet",
        icon: "⌘",
        body: Array.from(
          new Set(
            listProjectMounts().map(
              (project) => `${project.instanceLabel}\n  path: ${project.path}\n  workspace: ${getWorkspaceByKey(project.workspaceId).name}`,
            ),
          ),
        ).join("\n\n"),
      };
    case "cloud":
      return {
        id: tabId,
        title: "Bunny Cloud",
        kind: "cloud",
        icon: "☁",
        body:
          "Bunny Cloud will evolve from the existing colab-cloud flow. This pane becomes the bridge for account auth, fleet orchestration, remote surfaces, and browser-hosted Bunny Dash.",
      };
    case "browser":
      return {
        id: tabId,
        title: "Web Browser",
        kind: "fleet",
        icon: "◎",
        body:
          "Browser surfaces will run as carrots inside Bunny Ears and attach into Bunny Dash locally or remotely. This is the Bunny Dash replacement path for Colab web slates.",
      };
    case "terminal":
      return {
        id: tabId,
        title: "Terminal",
        kind: "notes",
        icon: "›_",
        body:
          "Terminal sessions will move into a dedicated PTY carrot so Bunny Dash can attach locally or remotely without SSH. This is the future colab-pty path.",
      };
    case "agent":
      return {
        id: tabId,
        title: "AI Chat",
        kind: "notes",
        icon: "✦",
        body:
          "Agent workflows will move into carrots that expose local and remote tool surfaces. This tab is the placeholder for the Bunny Dash agent shell.",
      };
    case "windows":
      return {
        id: tabId,
        title: "Windows",
        kind: "notes",
        icon: "▦",
        body: runtimeWindows
          .map(
            (window) =>
              `${window.title}\n  workspace: ${getWorkspaceByKey(window.workspaceId).name}\n  main: ${window.currentMainTabId}\n  side: ${window.currentSideTabId}`,
          )
          .join("\n\n"),
      };
    case "notes":
      return {
        id: tabId,
        title: "Notes",
        kind: "notes",
        icon: "✎",
        body:
          "Bunny Dash now persists workspaces, project mounts, layouts, and the active session in GoldfishDB. The current UI uses that local store as the source of truth rather than the old in-memory seed data.",
      };
    case "session":
    default:
      return {
        id: tabId,
        title: "Session",
        kind: "notes",
        icon: "◌",
        body: `Current window: ${currentWindow.title}\nLayout: ${currentLayout.name}\nWorkspace: ${currentWorkspace.name}\n\nLast updated: ${new Date(sessionSnapshot.updatedAt).toLocaleString()}\nLocal store: GoldfishDB`,
      };
  }
}

function formatSessionLabel(updatedAt: number) {
  return `Last saved ${new Date(updatedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function makeFileNameSafe(input: string) {
  return input
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+$/, "untitled")
    .replace(/^$/, "untitled");
}

function getUniqueNewName(parentPath: string, baseName: string) {
  const safeBase = makeFileNameSafe(baseName);
  let candidate = safeBase;
  let index = 2;
  while (existsSync(join(parentPath, candidate))) {
    candidate = `${safeBase} ${index}`;
    index += 1;
  }
  return candidate;
}

function snapshot(): Snapshot {
  ensureRuntimeState();

  const workspaces = listWorkspaces();
  const layouts = listLayouts();
  const currentLayout = getCurrentLayout();
  const currentWindow = getCurrentWindow();
  const currentWorkspace = getCurrentWorkspace();
  const tree = buildTree(currentWorkspace);
  const mainTabs = currentWindow.mainTabIds.map((tabId) =>
    buildTab(tabId, currentWorkspace, currentLayout, currentWindow),
  );
  const sideTabs = currentWindow.sideTabIds.map((tabId) =>
    buildTab(tabId, currentWorkspace, currentLayout, currentWindow),
  );

  return {
    shellTitle: "Bunny Dash",
    subtitle: "Local shell for Bunny Ears fleets, layouts, and project work.",
    permissions: [...permissions],
    cloudLabel: "Bunny Cloud",
    cloudStatus: "colab-cloud is the working reference foundation for the future Bunny Cloud service.",
    commandHint: process.platform === "darwin" ? "cmd+p" : "ctrl+p",
    topActions: [
      { id: "command-palette", label: "Command Palette" },
      { id: "resume-last-state", label: "Resume Last State" },
      { id: "pop-out-bunny", label: "Pop Out Bunny" },
      { id: "bunny-cloud", label: "Bunny Cloud" },
    ],
    currentLayout: {
      id: currentLayout.key,
      name: currentLayout.name,
      description: currentLayout.description,
    },
    currentWorkspace: {
      id: currentWorkspace.key,
      name: currentWorkspace.name,
      subtitle: currentWorkspace.subtitle,
    },
    currentWindow: {
      id: currentWindow.id,
      title: currentWindow.title,
      currentMainTabId: currentWindow.currentMainTabId,
      currentSideTabId: currentWindow.currentSideTabId,
    },
    layouts: layouts.map((layout) => ({
      id: layout.key,
      name: layout.name,
      description: layout.description,
      windowCount: layout.windows.length,
      isActive: layout.key === state.currentLayoutId,
    })),
    workspaces: workspaces.map((workspace) => ({
      id: workspace.key,
      name: workspace.name,
      subtitle: workspace.subtitle,
      projectCount: getProjectMountsForWorkspace(workspace.key).length,
      isCurrent: workspace.key === currentWorkspace.key,
    })),
    layoutWindows: runtimeWindows.map((window) => ({
      id: window.id,
      title: window.title,
      workspaceId: window.workspaceId,
      workspaceName: getWorkspaceByKey(window.workspaceId).name,
      isActive: window.id === state.currentWindowId,
    })),
    sessionSummary: {
      updatedAt: sessionSnapshot.updatedAt,
      label: formatSessionLabel(sessionSnapshot.updatedAt),
    },
    tree,
    mainTabs,
    sideTabs,
    stats: buildStats(),
    state: { ...state },
  };
}

function emitSnapshot() {
  post({ type: "event", name: "snapshot", payload: snapshot() });
}

function isTreeNodeIdValid(nodeId: string) {
  const currentWorkspace = getCurrentWorkspaceUnsafe();
  if (!currentWorkspace) {
    return false;
  }
  const tree = buildTree(currentWorkspace);
  return flattenTree(tree).some((node) => node.id === nodeId);
}

function flattenTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...(node.children ? flattenTree(node.children) : [])]);
}

function syncActiveTreeNode() {
  const currentWindow = getCurrentWindowUnsafe();
  const currentWorkspace = getCurrentWorkspaceUnsafe();
  if (!currentWindow || !currentWorkspace) {
    return;
  }
  const projects = getProjectMountsForWorkspace(currentWorkspace.key);

  if (projects.length > 0) {
    state.activeTreeNodeId = `project:${projects[0]!.key}`;
  } else if (currentWindow.currentMainTabId === "layout") {
    state.activeTreeNodeId = `layout-overview:${state.currentLayoutId}`;
  } else {
    state.activeTreeNodeId = `workspace-overview:${currentWorkspace.key}`;
  }
}

async function writeCompatibilityState() {
  const persisted = {
    state: {
      sidebarCollapsed: state.sidebarCollapsed,
      bunnyPopoverOpen: false,
      currentLayoutId: state.currentLayoutId,
      currentWindowId: state.currentWindowId,
      activeTreeNodeId: state.activeTreeNodeId,
    },
    sessionSnapshot,
    db: {
      engine: "goldfishdb",
      folder: dirname(statePath) + "/goldfishdb",
    },
    colab: colabState,
  };

  await Bun.write(statePath, JSON.stringify(persisted, null, 2));
}

async function saveState() {
  const db = ensureDb();
  const uiDoc = getUiSettingsDoc();
  const snapshotDoc = getSessionSnapshotDoc();

  db.collection("uiSettings").update(uiDoc.id, {
    sidebarCollapsed: state.sidebarCollapsed,
    bunnyPopoverOpen: false,
    currentLayoutId: state.currentLayoutId,
    currentWindowId: state.currentWindowId,
    activeTreeNodeId: state.activeTreeNodeId,
  });

  sessionSnapshot = captureSessionSnapshot();
  db.collection("sessionSnapshots").update(snapshotDoc.id, {
    updatedAt: sessionSnapshot.updatedAt,
    currentLayoutId: sessionSnapshot.currentLayoutId,
    currentWindowId: sessionSnapshot.currentWindowId,
    windows: cloneWindows(sessionSnapshot.windows),
  });

  flushDb();
  await writeCompatibilityState();
}

async function loadState() {
  const dbFolder = `${dirname(statePath)}/goldfishdb`;
  dashDb = createDashDb(dbFolder);
  seedDashDb(dashDb);
  migrateLegacyExampleData(dashDb);
  normalizePersistedCurrentSession();
  flushDb();

  const uiDoc = getUiSettingsDoc();
  const snapshotDoc = getSessionSnapshotDoc();

  state = {
    sidebarCollapsed: uiDoc.sidebarCollapsed,
    commandPaletteOpen: false,
    bunnyPopoverOpen: false,
    commandQuery: "",
    currentLayoutId: uiDoc.currentLayoutId || snapshotDoc.currentLayoutId,
    currentWindowId: uiDoc.currentWindowId || snapshotDoc.currentWindowId,
    activeTreeNodeId: uiDoc.activeTreeNodeId || `layout-overview:${snapshotDoc.currentLayoutId}`,
  };

  runtimeWindows = cloneWindows(snapshotDoc.windows);
  sessionSnapshot = {
    updatedAt: snapshotDoc.updatedAt,
    currentLayoutId: snapshotDoc.currentLayoutId,
    currentWindowId: snapshotDoc.currentWindowId,
    windows: cloneWindows(snapshotDoc.windows),
  };

  if (existsSync(statePath)) {
    try {
      const persisted = JSON.parse(readFileSync(statePath, "utf8")) as { colab?: PersistedColabState };
      if (persisted.colab) {
        colabState = {
          workspaces: persisted.colab.workspaces || {},
          appSettings: persisted.colab.appSettings || structuredClone(defaultColabAppSettings),
          tokens: persisted.colab.tokens || [],
        };
      }
    } catch (error) {
      log(
        `failed to load persisted colab state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  expandedFsDirs.clear();
  for (const project of listProjectMounts()) {
    if (existsSync(project.path)) {
      expandedFsDirs.add(project.path);
    }
  }

  ensureRuntimeState();
  syncProjectWatchers();
  await writeCompatibilityState();
}

function setCommandQuery(query: string) {
  state.commandQuery = query;
}

function setMainTab(tabId: WindowTabId) {
  const currentWindow = getCurrentWindow();
  if (currentWindow.mainTabIds.includes(tabId)) {
    currentWindow.currentMainTabId = tabId;
  }
}

function setSideTab(tabId: WindowTabId) {
  const currentWindow = getCurrentWindow();
  if (currentWindow.sideTabIds.includes(tabId)) {
    currentWindow.currentSideTabId = tabId;
  }
}

function ensureMainTab(tabId: WindowTabId) {
  const currentWindow = getCurrentWindow();
  if (!currentWindow.mainTabIds.includes(tabId)) {
    currentWindow.mainTabIds.push(tabId);
  }
  currentWindow.currentMainTabId = tabId;
}

function ensureSideTab(tabId: WindowTabId) {
  const currentWindow = getCurrentWindow();
  if (!currentWindow.sideTabIds.includes(tabId)) {
    currentWindow.sideTabIds.push(tabId);
  }
  currentWindow.currentSideTabId = tabId;
}

async function applyLayout(layoutId: string) {
  const layout = getLayoutByKey(layoutId);
  runtimeWindows = cloneWindows(layout.windows);
  state.currentLayoutId = layout.key;
  state.currentWindowId = runtimeWindows[0]!.id;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  syncActiveTreeNode();
  await saveState();
  syncTray();
  emitSnapshot();
  log(`layout applied: ${layout.name}`);
}

async function resumeLastState() {
  const snapshotDoc = getSessionSnapshotDoc();
  runtimeWindows = cloneWindows(snapshotDoc.windows);
  state.currentLayoutId = snapshotDoc.currentLayoutId;
  state.currentWindowId = snapshotDoc.currentWindowId;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  sessionSnapshot = {
    updatedAt: snapshotDoc.updatedAt,
    currentLayoutId: snapshotDoc.currentLayoutId,
    currentWindowId: snapshotDoc.currentWindowId,
    windows: cloneWindows(snapshotDoc.windows),
  };
  ensureRuntimeState();
  await saveState();
  syncTray();
  emitSnapshot();
  log("resumed last state");
}

async function updateCurrentLayout() {
  const db = ensureDb();
  const layout = getLayoutByKey(state.currentLayoutId);
  db.collection("layouts").update(layout.id, {
    windows: cloneWindows(runtimeWindows),
  });
  flushDb();
  await saveState();
  syncTray();
  emitSnapshot();
  log(`updated layout: ${layout.name}`);
}

function uniqueKey(base: string, existingKeys: string[]) {
  let candidate = slugify(base);
  let index = 2;
  while (existingKeys.includes(candidate)) {
    candidate = `${slugify(base)}-${index}`;
    index += 1;
  }
  return candidate;
}

async function createWorkspace(name: string, subtitle = "") {
  const db = ensureDb();
  const workspaces = listWorkspaces();
  const key = uniqueKey(name, workspaces.map((workspace) => workspace.key));
  const created = db.collection("workspaces").insert({
    key,
    name: name.trim(),
    subtitle: subtitle.trim() || "New Bunny Dash workspace.",
    sortOrder: workspaces.length,
  });

  const currentWindow = getCurrentWindow();
  currentWindow.workspaceId = created.key;
  state.activeTreeNodeId = `workspace-overview:${created.key}`;
  flushDb();
  await saveState();
  syncTray();
  emitSnapshot();
  log(`workspace created: ${created.name}`);
  return snapshot();
}

async function addProjectMount(params: {
  workspaceId?: string;
  name?: string;
  path: string;
  instanceId?: string;
  instanceLabel?: string;
  kind?: string;
}) {
  const workspaceId = params.workspaceId || getCurrentWorkspace().key;
  const workspace = getWorkspaceByKey(workspaceId);
  const projects = listProjectMounts();
  const projectName = params.name?.trim() || basename(params.path) || "project";
  const existingWorkspaceProjects = getProjectMountsForWorkspace(workspace.key);
  const resolvedPath = params.path.trim();

  if (!resolvedPath) {
    throw new Error("Project path is required");
  }

  if (!existsSync(resolvedPath)) {
    throw new Error(`Project path does not exist: ${resolvedPath}`);
  }

  if (!statSync(resolvedPath).isDirectory()) {
    throw new Error(`Project path is not a directory: ${resolvedPath}`);
  }

  if (
    existingWorkspaceProjects.some(
      (project) => project.path === resolvedPath || project.name === projectName,
    )
  ) {
    throw new Error(`Workspace ${workspace.name} already contains ${projectName}`);
  }

  const key = uniqueKey(`${workspace.key}-${projectName}`, projects.map((project) => project.key));
  const created = ensureDb().collection("projectMounts").insert({
    key,
    workspaceId: workspace.key,
    name: projectName,
    instanceId: params.instanceId || "host-machine",
    instanceLabel: params.instanceLabel || "host-machine",
    path: resolvedPath,
    kind: params.kind || "code",
    status: "ready",
    sortOrder: projects.length,
  });

  if (existsSync(created.path)) {
    expandedFsDirs.add(created.path);
  }
  syncProjectWatchers();
  state.activeTreeNodeId = `project:${created.key}`;
  flushDb();
  await saveState();
  syncTray();
  emitSnapshot();
  log(`project added: ${created.name}`);
  return snapshot();
}

async function saveLayout(name: string, description = "") {
  const layouts = listLayouts();
  const cleanName = name.trim();
  if (!cleanName) {
    throw new Error("Layout name is required");
  }

  const key = uniqueKey(cleanName, layouts.map((layout) => layout.key));
  const created = ensureDb().collection("layouts").insert({
    key,
    name: cleanName,
    description: description.trim() || `Saved from ${getCurrentWorkspace().name}`,
    sortOrder: layouts.length,
    windows: cloneWindows(runtimeWindows),
  });

  state.currentLayoutId = created.key;
  state.activeTreeNodeId = `layout-overview:${created.key}`;
  flushDb();
  await saveState();
  syncTray();
  emitSnapshot();
  log(`layout saved: ${created.name}`);
  return snapshot();
}

async function switchWorkspace(workspaceId: string) {
  const workspace = getWorkspaceByKey(workspaceId);
  const currentWindow = getCurrentWindow();
  currentWindow.workspaceId = workspace.key;
  state.activeTreeNodeId = `workspace-overview:${workspace.key}`;
  await saveState();
  syncTray();
  emitSnapshot();
  log(`workspace switched to ${workspace.name}`);
}

async function openQuickAccess(tabId: "browser" | "terminal" | "agent") {
  ensureMainTab(tabId);
  syncActiveTreeNode();
  await saveState();
  syncTray();
  emitSnapshot();
  log(`quick access opened: ${tabId}`);
  return snapshot();
}

async function selectLayoutWindow(windowId: string) {
  if (!runtimeWindows.some((window) => window.id === windowId)) {
    return;
  }
  state.currentWindowId = windowId;
  syncActiveTreeNode();
  await saveState();
  syncTray();
  emitSnapshot();
}

async function selectNode(nodeId: string) {
  state.activeTreeNodeId = nodeId;

  if (nodeId.startsWith("layout-overview:")) {
    ensureMainTab("layout");
  } else if (nodeId.startsWith("workspace-overview:")) {
    ensureMainTab("workspace");
  } else if (nodeId === "session-overview") {
    ensureSideTab("session");
  } else if (nodeId.startsWith("window:")) {
    await selectLayoutWindow(nodeId.replace("window:", ""));
    ensureSideTab("windows");
    return;
  } else if (nodeId.startsWith("project:")) {
    ensureMainTab("projects");
  } else if (nodeId.startsWith("project-readme:")) {
    ensureMainTab("workspace");
  } else if (nodeId.startsWith("project-mount:")) {
    ensureMainTab("projects");
  } else if (nodeId.startsWith("fsdir:")) {
    const path = nodeId.replace("fsdir:", "");
    if (expandedFsDirs.has(path)) {
      expandedFsDirs.delete(path);
    } else {
      expandedFsDirs.add(path);
    }
    ensureMainTab("projects");
  } else if (nodeId.startsWith("fsfile:") || nodeId.startsWith("fsmissing:")) {
    ensureMainTab("projects");
  } else if (nodeId.startsWith("instance:")) {
    ensureMainTab("instances");
  } else if (nodeId.startsWith("workspace:")) {
    await switchWorkspace(nodeId.replace("workspace:", ""));
    return;
  } else if (nodeId.startsWith("layout-root:")) {
    await applyLayout(nodeId.replace("layout-root:", ""));
    return;
  }

  await saveState();
  emitSnapshot();
}

function syncTray() {
  if (!permissions.has("host:tray")) return;
  const currentLayout = getCurrentLayout();
  const currentWorkspace = getCurrentWorkspace();
  const layouts = listLayouts();
  const workspaces = listWorkspaces();

  post({ type: "action", action: "set-tray", payload: { title: `Dash: ${currentLayout.name}` } });
  post({
    type: "action",
    action: "set-tray-menu",
    payload: [
      { type: "normal", label: "Open Bunny Dash", action: "open-window" },
      { type: "normal", label: "Resume Last State", action: "resume-last-state" },
      { type: "normal", label: "Update Current Layout", action: "update-current-layout" },
      { type: "divider" },
      {
        type: "normal",
        label: `Switch Layout (${currentLayout.name})`,
        action: "noop-layout",
        submenu: layouts.map((layout) => ({
          type: "normal",
          label: layout.key === state.currentLayoutId ? `• ${layout.name}` : layout.name,
          action: `layout:${layout.key}`,
        })),
      },
      {
        type: "normal",
        label: `Switch Workspace (${currentWorkspace.name})`,
        action: "noop-workspace",
        submenu: workspaces.map((workspace) => ({
          type: "normal",
          label: workspace.key === currentWorkspace.key ? `• ${workspace.name}` : workspace.name,
          action: `workspace:${workspace.key}`,
        })),
      },
      { type: "divider" },
      { type: "normal", label: "Stop Bunny Dash", action: "stop" },
    ],
  });
}

function getNodeForPath(path: string) {
  if (!existsSync(path)) {
    return null;
  }

  const name = basename(path);
  const stat = statSync(path);

  if (stat.isDirectory()) {
    const children = readdirSync(path)
      .filter((entry) => !isIgnoredPath(join(path, entry)))
      .sort((left, right) => left.localeCompare(right));
    return {
      name,
      type: "dir" as const,
      path,
      children,
    };
  }

  return {
    name,
    type: "file" as const,
    path,
    persistedContent: "",
    isDirty: false,
    model: null,
    editors: {},
    isCached: false,
  };
}

function readSlateConfig(path: string) {
  const configPath = statSync(path).isDirectory() ? join(path, ".colab.json") : path;
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

async function findFilesInWorkspace(query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }

  const matches: string[] = [];
  const queue = getProjectMountsForWorkspace(getCurrentWorkspace().key).map((project) => project.path);

  while (queue.length > 0 && matches.length < 200) {
    const current = queue.shift()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry);
      if (isIgnoredPath(fullPath)) {
        continue;
      }
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        queue.push(fullPath);
      }
      if (entry.toLowerCase().includes(needle)) {
        matches.push(fullPath);
      }
      if (matches.length >= 200) {
        break;
      }
    }
  }

  return matches;
}

async function findAllInWorkspace(query: string) {
  const needle = query.trim();
  if (!needle) {
    return [];
  }

  const results: Array<{ path: string; line: number; column: number; match: string }> = [];
  const queue = getProjectMountsForWorkspace(getCurrentWorkspace().key).map((project) => project.path);

  while (queue.length > 0 && results.length < 200) {
    const current = queue.shift()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry);
      if (isIgnoredPath(fullPath)) {
        continue;
      }
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      let contents = "";
      try {
        contents = readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      const lines = contents.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const column = lines[index]!.indexOf(needle);
        if (column >= 0) {
          results.push({
            path: fullPath,
            line: index + 1,
            column: column + 1,
            match: lines[index]!,
          });
        }
        if (results.length >= 200) {
          break;
        }
      }

      if (results.length >= 200) {
        break;
      }
    }
  }

  return results;
}

async function handleColabRequest(method: string, params: any) {
  switch (method) {
    case "getInitialState": {
      const workspace = currentColabWorkspace();
      return {
        windowId: workspace.windows[0]?.id || "main",
        buildVars: colabBuildVars(),
        paths: colabPaths(),
        peerDependencies: colabPeerDependencies(),
        workspace,
        projects: colabProjectsForWorkspace(workspace.id),
        tokens: colabState.tokens || [],
        appSettings: colabState.appSettings || defaultColabAppSettings,
      };
    }
    case "newPreviewNode": {
      const parentPath = getColabProjectsFolder();
      const nodeName = getUniqueNewName(parentPath, params?.candidateName || "new-project");
      return {
        type: "dir",
        name: nodeName,
        path: join(parentPath, nodeName),
        previewChildren: [],
        isExpanded: false,
        slate: {
          v: 1,
          name: "",
          url: "",
          icon: "",
          type: "project",
          config: {},
        },
      };
    }
    case "addProject":
      return addProjectMount({
        workspaceId: getCurrentWorkspace().key,
        name: params?.projectName,
        path: String(params?.path || ""),
      }).then((result) => {
        emitSetProjects();
        return result;
      });
    case "syncWorkspace":
      colabState.workspaces ||= {};
      colabState.workspaces[getCurrentWorkspace().key] = params.workspace;
      await writeCompatibilityState();
      return;
    case "syncAppSettings":
      colabState.appSettings = params.appSettings;
      await writeCompatibilityState();
      return;
    case "openFileDialog":
      return requestHost<string[]>("open-file-dialog", {
        startingFolder: params?.startingFolder,
        allowedFileTypes: params?.allowedFileTypes,
        canChooseFiles: params?.canChooseFiles,
        canChooseDirectory: params?.canChooseDirectory,
        allowsMultipleSelection: params?.allowsMultipleSelection,
      });
    case "getNode":
      return getNodeForPath(String(params?.path || ""));
    case "readSlateConfigFile":
      return readSlateConfig(String(params?.path || ""));
    case "readFile": {
      const path = String(params?.path || "");
      const textContent = readFileSync(path, "utf8");
      return {
        textContent,
        isBinary: false,
        loadedBytes: textContent.length,
        totalBytes: textContent.length,
      };
    }
    case "writeFile":
      try {
        writeFileSync(String(params?.path || ""), String(params?.value || ""));
        emitFileWatchEvent(String(params?.path || ""));
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    case "touchFile":
      try {
        const path = String(params?.path || "");
        writeFileSync(path, String(params?.contents || ""), { flag: existsSync(path) ? "a" : "w" });
        emitFileWatchEvent(path);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    case "rename":
      try {
        renameSync(String(params?.oldPath || ""), String(params?.newPath || ""));
        emitFileWatchEvent(String(params?.oldPath || ""));
        emitFileWatchEvent(String(params?.newPath || ""));
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    case "exists":
      return existsSync(String(params?.path || ""));
    case "isFolder": {
      const path = String(params?.path || "");
      try {
        return existsSync(path) && statSync(path).isDirectory();
      } catch {
        return false;
      }
    }
    case "mkdir":
      try {
        mkdirSync(String(params?.path || ""), { recursive: true });
        emitFileWatchEvent(String(params?.path || ""));
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    case "showInFinder":
      await requestHost("show-item-in-folder", { path: String(params?.path || "") });
      return;
    case "copy":
      cpSync(String(params?.src || ""), String(params?.dest || ""), { recursive: true });
      emitFileWatchEvent(String(params?.dest || ""));
      return;
    case "safeDeleteFileOrFolder":
    case "safeTrashFileOrFolder":
      rmSync(String(params?.path || ""), { recursive: true, force: true });
      emitFileWatchEvent(String(params?.path || ""));
      return;
    case "execSpawnSync": {
      const cmd = String(params?.cmd || "");
      const args = Array.isArray(params?.args) ? params.args.map(String) : [];
      const result = Bun.spawnSync([cmd, ...args], {
        ...(typeof params?.opts === "object" && params?.opts ? params.opts : {}),
      });
      if (result.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(result.stderr || new Uint8Array()) || `${cmd} exited with code ${result.exitCode}`);
      }
      return new TextDecoder().decode(result.stdout || new Uint8Array());
    }
    case "createTerminal":
      return getTerminalManager().createTerminal(
        String(params?.cwd || process.cwd()),
        typeof params?.shell === "string" ? params.shell : undefined,
      );
    case "writeToTerminal":
      return getTerminalManager().writeToTerminal(
        String(params?.terminalId || ""),
        String(params?.data || ""),
      );
    case "resizeTerminal":
      return getTerminalManager().resizeTerminal(
        String(params?.terminalId || ""),
        Number(params?.cols || 80),
        Number(params?.rows || 24),
      );
    case "killTerminal":
      return getTerminalManager().killTerminal(String(params?.terminalId || ""));
    case "getTerminalCwd":
      return getTerminalManager().getTerminalCwd(String(params?.terminalId || ""));
    case "findFilesInWorkspace":
      return findFilesInWorkspace(String(params?.query || ""));
    case "findAllInWorkspace":
      return findAllInWorkspace(String(params?.query || ""));
    case "cancelFileSearch":
    case "cancelFindAll":
      return true;
    case "getUniqueNewName":
      return getUniqueNewName(String(params?.parentPath || ""), String(params?.baseName || "untitled"));
    case "makeFileNameSafe":
      return makeFileNameSafe(String(params?.value || ""));
    case "getFaviconForUrl":
      return "views://assets/file-icons/bookmark.svg";
    case "showContextMenu":
      return;
    case "pluginGetFileDecoration":
    case "pluginFindSlateForFolder":
    case "pluginGetStateValue":
      return null;
    case "pluginGetPreloadScripts":
    case "pluginGetAllSlates":
    case "pluginGetStatusBarItems":
    case "pluginGetInstalled":
    case "pluginSearch":
    case "pluginGetSettingsValues":
    case "pluginGetSettingsSchema":
    case "pluginGetEntitlements":
    case "pluginGetSettingValidationStatuses":
    case "pluginGetCompletions":
    case "pluginGetContextMenuItems":
    case "pluginGetKeybindings":
      return [];
    case "pluginGetPendingSettingsMessages":
      return [];
    case "pluginSetSettingValue":
    case "pluginInstall":
    case "pluginUninstall":
    case "pluginSetEnabled":
    case "pluginSlateEvent":
    case "pluginMountSlate":
    case "pluginUnmountSlate":
    case "pluginSendSettingsMessage":
      return { success: true };
    case "pluginExecuteCommand":
      return;
    case "llamaListModels":
      return [];
    case "llamaCompletion":
      return { content: "Llama is not wired into Bunny Dash yet." };
    case "llamaInstallModel":
    case "llamaRemoveModel":
      return { success: false, error: "Not implemented in Bunny Dash yet." };
    case "llamaDownloadStatus":
      return { status: "idle" };
    case "getTokens":
      return colabState.tokens || [];
    case "setToken":
      return;
    case "getGitConfig":
      return { name: "", email: "", hasKeychainHelper: false };
    case "checkGitHubCredentials":
      return { hasCredentials: false };
    case "storeGitHubCredentials":
    case "removeGitHubCredentials":
    case "setGitConfig":
      return;
    default:
      return UNHANDLED_COLAB_REQUEST;
  }
}

async function handleColabSend(name: string, payload: any) {
  switch (name) {
    case "openBunnyWindow":
      post({
        type: "action",
        action: "open-bunny-window",
        payload: {
          screenX: typeof payload?.screenX === "number" ? payload.screenX : undefined,
          screenY: typeof payload?.screenY === "number" ? payload.screenY : undefined,
        },
      });
      return;
    case "closeWindow":
      stopCarrot();
      return;
    case "createWorkspace": {
      const nextName = `Workspace ${listWorkspaces().length + 1}`;
      await createWorkspace(nextName, "Colab workspace inside Bunny Dash.");
      getOrCreateColabWorkspace(getCurrentWorkspace().key);
      emitSetProjects();
      return;
    }
    case "updateWorkspace": {
      const workspace = getCurrentWorkspace();
      const db = ensureDb();
      const nextName = typeof payload?.name === "string" && payload.name.trim() ? payload.name.trim() : workspace.name;
      db.collection("workspaces").update(workspace.id, {
        name: nextName,
        subtitle: workspace.subtitle,
      });
      const colabWorkspace = getOrCreateColabWorkspace(workspace.key);
      colabWorkspace.name = nextName;
      if (typeof payload?.color === "string" && payload.color) {
        colabWorkspace.color = payload.color;
      }
      flushDb();
      emitSetProjects();
      await writeCompatibilityState();
      return;
    }
    case "removeProjectFromColabOnly": {
      const projectId = String(payload?.projectId || "");
      const db = ensureDb();
      const project = findProjectMountByKey(projectId);
      if (project) {
        db.collection("projectMounts").remove(project.id);
        flushDb();
        syncProjectWatchers();
        emitSetProjects();
        await writeCompatibilityState();
      }
      return;
    }
    case "fullyDeleteProjectFromDiskAndColab": {
      const projectId = String(payload?.projectId || "");
      const project = findProjectMountByKey(projectId);
      if (project) {
        rmSync(project.path, { recursive: true, force: true });
        const db = ensureDb();
        db.collection("projectMounts").remove(project.id);
        flushDb();
        syncProjectWatchers();
        emitSetProjects();
        await writeCompatibilityState();
      }
      return;
    }
    case "fullyDeleteNodeFromDisk":
      rmSync(String(payload?.nodePath || ""), { recursive: true, force: true });
      emitFileWatchEvent(String(payload?.nodePath || ""));
      return;
    case "editProject": {
      const project = findProjectMountByKey(String(payload?.projectId || ""));
      if (!project) {
        return;
      }
      ensureDb().collection("projectMounts").update(project.id, {
        name: String(payload?.projectName || project.name),
        path: String(payload?.path || project.path),
      });
      flushDb();
      syncProjectWatchers();
      emitSetProjects();
      await writeCompatibilityState();
      return;
    }
    case "deleteWorkspace":
    case "deleteWorkspaceCompletely": {
      const workspaces = listWorkspaces();
      if (workspaces.length <= 1) {
        return;
      }
      const current = getCurrentWorkspace();
      const db = ensureDb();
      const projects = getProjectMountsForWorkspace(current.key);
      for (const project of projects) {
        if (name === "deleteWorkspaceCompletely") {
          rmSync(project.path, { recursive: true, force: true });
        }
        db.collection("projectMounts").remove(project.id);
      }
      db.collection("workspaces").remove(current.id);
      delete (colabState.workspaces || {})[current.key];
      flushDb();
      await switchWorkspace(listWorkspaces()[0]!.key);
      emitSetProjects();
      await writeCompatibilityState();
      return;
    }
    case "track":
    case "hideWorkspace":
    case "createWindow":
    case "installUpdateNow":
    case "addToken":
    case "deleteToken":
    case "formatFile":
    case "tsServerRequest":
    case "syncDevlink":
      return;
    default:
      return;
  }
}

process.on("exit", () => {
  terminalManager?.cleanup();
});

self.onmessage = async (event) => {
  const message = event.data as any;

  if (message.type === "host-response") {
    const pending = pendingHostRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingHostRequests.delete(message.requestId);
    if (message.success) {
      pending.resolve(message.payload);
    } else {
      pending.reject(new Error(message.error || "Unknown host error"));
    }
    return;
  }

  if (message.type === "init") {
    permissions = new Set(message.context.permissions || []);
    statePath = message.context.statePath;
    manifestVersion = message.manifest?.version || manifestVersion;
    await loadState();
    ensureRuntimeState();
    sessionSnapshot = captureSessionSnapshot();
    post({ type: "ready" });
    syncTray();
    emitSnapshot();
    log("bunny dash worker initialized");
    return;
  }

  if (message.type === "event") {
    if (message.name === "boot") {
      syncTray();
      emitSnapshot();
      return;
    }

    if (message.name === "tray") {
      const action = String(message.payload?.action || "");
      if (action === "open-window") {
        focusWindow();
      } else if (action === "resume-last-state") {
        await resumeLastState();
      } else if (action === "update-current-layout") {
        await updateCurrentLayout();
      } else if (action.startsWith("layout:")) {
        await applyLayout(action.replace("layout:", ""));
      } else if (action.startsWith("workspace:")) {
        await switchWorkspace(action.replace("workspace:", ""));
      } else if (action === "stop") {
        stopCarrot();
      }
    }
    return;
  }

  if (message.type !== "request") {
    return;
  }

  try {
    if (typeof message.method === "string" && message.method.startsWith("send:")) {
      await handleColabSend(message.method.slice(5), message.params);
      post({ type: "response", requestId: message.requestId, success: true, payload: null });
      return;
    }

    switch (message.method) {
      case "getSnapshot":
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "toggleSidebar":
        state.sidebarCollapsed = !state.sidebarCollapsed;
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "togglePalette":
        state.commandPaletteOpen = !state.commandPaletteOpen;
        if (!state.commandPaletteOpen) {
          state.commandQuery = "";
        }
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "setCommandQuery":
        setCommandQuery(String(message.params?.query || ""));
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "selectNode":
        await selectNode(String(message.params?.nodeId || ""));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "focusMainTab":
        setMainTab(String(message.params?.tabId || getCurrentWindow().currentMainTabId) as WindowTabId);
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "focusSideTab":
        setSideTab(String(message.params?.tabId || getCurrentWindow().currentSideTabId) as WindowTabId);
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "toggleBunnyPopover":
        state.bunnyPopoverOpen = !state.bunnyPopoverOpen;
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "openCloudPanel":
        ensureMainTab("cloud");
        ensureSideTab("cloud");
        state.activeTreeNodeId = `layout-overview:${state.currentLayoutId}`;
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "openQuickAccess": {
        const tabId = String(message.params?.tabId || "");
        if (tabId !== "browser" && tabId !== "terminal" && tabId !== "agent") {
          throw new Error(`Unknown quick access tab: ${tabId}`);
        }
        const next = await openQuickAccess(tabId);
        post({ type: "response", requestId: message.requestId, success: true, payload: next });
        break;
      }
      case "applyLayout":
        await applyLayout(String(message.params?.layoutId || state.currentLayoutId));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "switchWorkspace":
        await switchWorkspace(String(message.params?.workspaceId || getCurrentWorkspace().key));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "selectLayoutWindow":
        await selectLayoutWindow(String(message.params?.windowId || state.currentWindowId));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "resumeLastState":
        await resumeLastState();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "updateCurrentLayout":
        await updateCurrentLayout();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "createWorkspace": {
        const created = await createWorkspace(
          String(message.params?.name || ""),
          String(message.params?.subtitle || ""),
        );
        post({ type: "response", requestId: message.requestId, success: true, payload: created });
        break;
      }
      case "addProjectMount": {
        const created = await addProjectMount({
          workspaceId: message.params?.workspaceId,
          name: message.params?.name,
          path: String(message.params?.path || ""),
          instanceId: message.params?.instanceId,
          instanceLabel: message.params?.instanceLabel,
          kind: message.params?.kind,
        });
        post({ type: "response", requestId: message.requestId, success: true, payload: created });
        break;
      }
      case "saveLayout": {
        const created = await saveLayout(
          String(message.params?.name || ""),
          String(message.params?.description || ""),
        );
        post({ type: "response", requestId: message.requestId, success: true, payload: created });
        break;
      }
      default: {
        const payload = await handleColabRequest(String(message.method), message.params);
        if (payload === UNHANDLED_COLAB_REQUEST) {
          post({
            type: "response",
            requestId: message.requestId,
            success: false,
            error: `Unknown method: ${message.method}`,
          });
        } else {
          post({ type: "response", requestId: message.requestId, success: true, payload });
        }
        break;
      }
    }
  } catch (error) {
    post({
      type: "response",
      requestId: message.requestId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
