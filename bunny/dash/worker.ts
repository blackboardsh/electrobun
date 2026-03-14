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
  ApplicationMenu,
  BrowserWindow,
  Carrots,
  ContextMenu,
  Tray,
  Utils,
  app,
} from "electrobun/bun";
import {
  createDashDb,
  type DashDb,
  type DashDocumentTypes,
  migrateLegacyExampleData,
  seedDashDb,
  type LensWindow,
  type WindowTabId,
} from "./db";

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

type CurrentState = {
  updatedAt: number;
  currentLayoutId: string;
  currentWindowId: string;
  windows: LensWindow[];
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
type LensDoc = DashDocumentTypes["layouts"];
type CurrentStateDoc = DashDocumentTypes["sessionSnapshots"];
type UiSettingsDoc = DashDocumentTypes["uiSettings"];

type Snapshot = {
  shellTitle: string;
  subtitle: string;
  permissions: string[];
  cloudLabel: string;
  cloudStatus: string;
  commandHint: string;
  topActions: Array<{ id: string; label: string }>;
  currentLens: {
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
  lenses: Array<{
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
  openWindows: Array<{
    id: string;
    title: string;
    workspaceId: string;
    workspaceName: string;
    isActive: boolean;
  }>;
  currentStateSummary: {
    updatedAt: number;
    label: string;
  };
  tree: TreeNode[];
  mainTabs: Tab[];
  sideTabs: Tab[];
  stats: Array<{ label: string; value: string }>;
  state: DashState;
};

type BunnyDashWorkspaceLensPayload = {
  currentWorkspaceId: string;
  currentLensId: string;
  workspaces: Array<{
    id: string;
    name: string;
    subtitle: string;
    isCurrent: boolean;
    currentLensId: string;
    currentLensIsActive: boolean;
    canExpand: boolean;
    lenses: Array<{
      id: string;
      name: string;
      description: string;
      workspaceId: string;
      isCurrent: boolean;
      isDirty: boolean;
    }>;
  }>;
};

let statePath = "";
let permissions = new Set<string>();
let dashDb: DashDb | null = null;
let manifestVersion = "0.0.1";
let runtimeWindows: LensWindow[] = [];
const browserWindows = new Map<string, BrowserWindow>();
let tray: Tray | null = null;
const terminalWindowOwners = new Map<string, string>();
const expandedFsDirs = new Set<string>();
const directoryWatchers = new Map<string, FSWatcher>();
const framePersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let ptyHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
const LIVE_WINDOW_ID_SEPARATOR = "::";
const WORKSPACE_CURRENT_LENS_PREFIX = "__workspace-current__:";
const PTY_CARROT_ID = "bunny.pty";
const DEFAULT_PTY_HEARTBEAT_INTERVAL_MS = 60 * 1000;
let ptyHeartbeatIntervalMs = DEFAULT_PTY_HEARTBEAT_INTERVAL_MS;
const LEGACY_CURRENT_SESSION_MAIN_TABS: WindowTabId[] = [
  "workspace",
  "projects",
  "lens",
  "instances",
  "cloud",
];
const LEGACY_CURRENT_SESSION_SIDE_TABS: WindowTabId[] = [
  "current-state",
  "windows",
  "notes",
  "cloud",
];
const DEFAULT_STARTER_LENS_WINDOW: LensWindow = {
  id: "main",
  lensId: "starter-lens",
  title: "Main",
  workspaceId: "local-workspace",
  mainTabIds: ["workspace"],
  sideTabIds: ["current-state"],
  currentMainTabId: "workspace",
  currentSideTabId: "current-state",
};
let currentState: CurrentState = {
  updatedAt: Date.now(),
  currentLayoutId: "starter-lens",
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

const builtInShortcuts: Array<{
  accelerator: string;
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}> = [
  {
    accelerator: "t",
    key: "t",
    ctrl: false,
    shift: false,
    alt: false,
    meta: true,
  },
  {
    accelerator: "p",
    key: "p",
    ctrl: false,
    shift: false,
    alt: false,
    meta: true,
  },
  {
    accelerator: "cmd+shift+p",
    key: "p",
    ctrl: false,
    shift: true,
    alt: false,
    meta: true,
  },
  {
    accelerator: "cmd+shift+f",
    key: "f",
    ctrl: false,
    shift: true,
    alt: false,
    meta: true,
  },
  {
    accelerator: "w",
    key: "w",
    ctrl: false,
    shift: false,
    alt: false,
    meta: true,
  },
  {
    accelerator: "cmd+shift+w",
    key: "w",
    ctrl: false,
    shift: true,
    alt: false,
    meta: true,
  },
  {
    accelerator: "ctrl+tab",
    key: "Tab",
    ctrl: true,
    shift: false,
    alt: false,
    meta: false,
  },
  {
    accelerator: "ctrl+shift+tab",
    key: "Tab",
    ctrl: true,
    shift: true,
    alt: false,
    meta: false,
  },
];

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
  currentLayoutId: "starter-lens",
  currentWindowId: "main",
  activeTreeNodeId: "lens-overview:starter-lens",
};

let bootPromise: Promise<void> | null = null;

function cloneWindows(value: LensWindow[]) {
  return structuredClone(value);
}

function sameTabIds(left: WindowTabId[], right: WindowTabId[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameLensWindowTemplate(left: LensWindow, right: LensWindow) {
  return (
    left.workspaceId === right.workspaceId &&
    left.title === right.title &&
    left.currentMainTabId === right.currentMainTabId &&
    left.currentSideTabId === right.currentSideTabId &&
    sameTabIds(left.mainTabIds, right.mainTabIds) &&
    sameTabIds(left.sideTabIds, right.sideTabIds)
  );
}

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "untitled";
}

function workspaceCurrentLensKey(workspaceId: string) {
  return `${WORKSPACE_CURRENT_LENS_PREFIX}${workspaceId}`;
}

function isWorkspaceCurrentLensKey(key: string) {
  return key.startsWith(WORKSPACE_CURRENT_LENS_PREFIX);
}

function log(message: string) {
  post({ type: "action", action: "log", payload: { message } });
}

function post(message: unknown) {
  self.postMessage(message);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseDurationMs(value: string | undefined, fallback: number, minimum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, parsed);
}

function getOrCreateBrowserWindow(windowId = state.currentWindowId, title?: string) {
  const runtimeWindow = runtimeWindows.find((candidate) => candidate.id === windowId);
  if (!runtimeWindow) {
    throw new Error(`Unknown runtime window: ${windowId}`);
  }

  const existing = browserWindows.get(windowId);
  if (existing) {
    if (title && title !== existing.title) {
      existing.setTitle(title);
    }
    return existing;
  }

  const colabWindow = getColabWindowForRuntimeWindow(windowId);
  const win = new BrowserWindow({
    id: windowId,
    title: title || runtimeWindow.title,
    url: "views://lens/index.html",
    titleBarStyle: "hiddenInset",
    frame: {
      x: colabWindow?.position.x ?? 120,
      y: colabWindow?.position.y ?? 120,
      width: colabWindow?.position.width ?? 1400,
      height: colabWindow?.position.height ?? 920,
    },
  });
  browserWindows.set(windowId, win);

  win.on("move", (event: any) => {
    updateColabWindowFrame(windowId, {
      x: typeof event?.data?.x === "number" ? event.data.x : undefined,
      y: typeof event?.data?.y === "number" ? event.data.y : undefined,
    });
    schedulePersistWindowFrame(windowId);
  });

  win.on("resize", (event: any) => {
    updateColabWindowFrame(windowId, {
      x: typeof event?.data?.x === "number" ? event.data.x : undefined,
      y: typeof event?.data?.y === "number" ? event.data.y : undefined,
      width: typeof event?.data?.width === "number" ? event.data.width : undefined,
      height: typeof event?.data?.height === "number" ? event.data.height : undefined,
    });
    schedulePersistWindowFrame(windowId);
  });

  return win;
}

function focusWindow(windowId?: string, title?: string) {
  getOrCreateBrowserWindow(windowId, title).focus();
}

function closeWindow(windowId?: string) {
  const targetWindowId = windowId || state.currentWindowId;
  const existing = browserWindows.get(targetWindowId);
  if (!existing) {
    return;
  }
  browserWindows.delete(targetWindowId);
  existing.close();
}

function stopCarrot() {
  app.quit();
}

async function reopenRuntimeWindowsOnBoot() {
  if (runtimeWindows.length === 0) {
    return;
  }

  for (const runtimeWindow of runtimeWindows) {
    getOrCreateBrowserWindow(runtimeWindow.id, runtimeWindow.title);
  }

  if (runtimeWindows.some((window) => window.id === state.currentWindowId)) {
    focusWindow(state.currentWindowId, getCurrentWindow().title);
  }
}

function getMenuStartingFolder() {
  return process.env.HOME || getDashHomeDir();
}

function openAboutWindow(url: string) {
  const id = `about-${Date.now().toString(36)}`;
  const win = new BrowserWindow({
    id,
    title: "About",
    url,
    frame: {
      width: 800,
      height: 800,
      x: 120,
      y: 120,
    },
  });
  browserWindows.set(id, win);
}

function sendToFocusedDashWindow(name: string, payload?: unknown) {
  emitViewMessage(name, payload, state.currentWindowId);
}

function sendToDashWindow(windowId: string | undefined, name: string, payload?: unknown) {
  emitViewMessage(name, payload, windowId || state.currentWindowId);
}

function sendRuntimeEventToDashWindow(windowId: string | undefined, name: string, payload?: unknown) {
  post({
    type: "action",
    action: "emit-view",
    payload: {
      name,
      payload,
      raw: false,
      windowId: windowId || state.currentWindowId,
    },
  });
}

function broadcastRuntimeEventToDashWindows(name: string, payload?: unknown) {
  post({
    type: "action",
    action: "emit-view",
    payload: { raw: false, name, payload },
  });
}

function getUniqueLensNameForWorkspace(workspaceId: string, baseName = "Lens", excludeLensId?: string) {
  const existingNames = new Set(
    getLensesForWorkspace(workspaceId)
      .filter((lens) => lens.key !== excludeLensId)
      .map((lens) => lens.name.trim().toLowerCase()),
  );

  let index = 1;
  while (existingNames.has(`${baseName} ${index}`.toLowerCase())) {
    index += 1;
  }

  return `${baseName} ${index}`;
}

function getUniqueLensDisplayName(workspaceId: string, rawName: string, excludeLensId?: string) {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return getUniqueLensNameForWorkspace(workspaceId, "Lens", excludeLensId);
  }

  const existingNames = new Set(
    getLensesForWorkspace(workspaceId)
      .filter((lens) => lens.key !== excludeLensId)
      .map((lens) => lens.name.trim().toLowerCase()),
  );

  if (!existingNames.has(trimmed.toLowerCase())) {
    return trimmed;
  }

  let index = 2;
  let candidate = `${trimmed} ${index}`;
  while (existingNames.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${trimmed} ${index}`;
  }
  return candidate;
}

async function handleContextMenuAction(action: string, data: any) {
  const windowId = typeof data?.windowId === "string" ? data.windowId : state.currentWindowId;
  if (windowId) {
    setActiveWindow(windowId);
  }

  switch (action) {
    case "workspace_new_lens":
      sendRuntimeEventToDashWindow(windowId, "showLensSettings", {
        mode: "create",
        workspaceId: String(data?.workspaceId || getCurrentWorkspace().key),
        name: getUniqueLensNameForWorkspace(
          String(data?.workspaceId || getCurrentWorkspace().key),
          "Lens",
        ),
        description: "",
      });
      return;
    case "workspace_open_in_new_window":
      await openWorkspaceInNewWindow(String(data?.workspaceId || getCurrentWorkspace().key));
      return;
    case "lens_open_in_new_window":
      await openLensInNewWindow(String(data?.lensId || state.currentLayoutId));
      return;
    case "lens_rename": {
      const lens = getLensByKey(String(data?.lensId || state.currentLayoutId));
      sendRuntimeEventToDashWindow(windowId, "showLensSettings", {
        mode: "rename",
        workspaceId: getLensWorkspaceId(lens),
        lensId: lens.key,
        name: lens.name,
        description: lens.description || "",
      });
      return;
    }
    case "lens_fork": {
      const lens = getLensByKey(String(data?.lensId || state.currentLayoutId));
      sendRuntimeEventToDashWindow(windowId, "showLensSettings", {
        mode: "create",
        workspaceId: getLensWorkspaceId(lens),
        sourceLensId: lens.key,
        name: getUniqueLensDisplayName(
          getLensWorkspaceId(lens),
          `${lens.name} Copy`,
        ),
        description: lens.description?.trim() || `Forked from ${lens.name}`,
      });
      return;
    }
    case "lens_delete":
      await deleteLens(String(data?.lensId || state.currentLayoutId));
      return;
    case "focus_tab":
      sendToDashWindow(windowId, "focusTab", { tabId: data?.tabId });
      return;
    case "open_new_tab":
      sendToDashWindow(windowId, "openNewTab", { nodePath: data?.nodePath });
      return;
    case "open_as_text":
      sendToDashWindow(windowId, "openAsText", { nodePath: data?.nodePath });
      return;
    case "show_node_settings":
      sendToDashWindow(windowId, "showNodeSettings", { nodePath: data?.nodePath });
      return;
    case "add_child_node":
      sendToDashWindow(windowId, "addChildNode", { nodePath: data?.nodePath });
      return;
    case "add_child_file":
      sendToDashWindow(windowId, "addChildNode", {
        nodePath: data?.nodePath,
        nodeType: "file",
      });
      return;
    case "add_child_folder":
      sendToDashWindow(windowId, "addChildNode", {
        nodePath: data?.nodePath,
        nodeType: "dir",
      });
      return;
    case "add_child_web":
      sendToDashWindow(windowId, "addChildNode", {
        nodePath: data?.nodePath,
        nodeType: "web",
      });
      return;
    case "add_child_agent":
      sendToDashWindow(windowId, "addChildNode", {
        nodePath: data?.nodePath,
        nodeType: "agent",
      });
      return;
    case "create_preload_file":
      sendToDashWindow(windowId, "createSpecialFile", {
        nodePath: data?.nodePath,
        fileType: "preload",
      });
      return;
    case "create_context_file":
      sendToDashWindow(windowId, "createSpecialFile", {
        nodePath: data?.nodePath,
        fileType: "context",
      });
      return;
    case "new_terminal":
      sendToDashWindow(windowId, "newTerminal", { nodePath: data?.nodePath });
      return;
    case "clone_repo_to_folder":
      sendToDashWindow(windowId, "addChildNode", {
        nodePath: data?.nodePath,
        nodeType: "repo",
      });
      return;
    case "copy_path_to_clipboard":
      await Utils.clipboardWriteText(String(data?.nodePath || ""));
      return;
    case "open_node_in_finder":
      await Utils.showItemInFolder(String(data?.nodePath || ""));
      return;
    case "remove_project_from_colab": {
      const project = findProjectMountByKey(String(data?.projectId || ""));
      if (project) {
        ensureDb().collection("projectMounts").remove(project.id);
        flushDb();
        syncProjectWatchers();
        emitSetProjects();
        await writeCompatibilityState();
      }
      return;
    }
    case "fully_delete_node_from_disk": {
      const nodePath = String(data?.nodePath || "");
      const projectId = typeof data?.projectId === "string" ? data.projectId : "";
      if (projectId) {
        const project = findProjectMountByKey(projectId);
        if (project) {
          ensureDb().collection("projectMounts").remove(project.id);
          flushDb();
        }
      }
      rmSync(nodePath, { recursive: true, force: true });
      emitFileWatchEvent(nodePath);
      emitSetProjects();
      return;
    }
    case "split_pane_container":
      sendToDashWindow(windowId, "splitPaneContainer", {
        pathToPane: data?.pathToPane,
        direction: data?.direction,
      });
      return;
    case "remove_open_file":
      sendToDashWindow(windowId, "removeOpenFile", { filePath: data?.filePath });
      return;
    case "open_open_file":
      sendToDashWindow(windowId, "openFileInEditor", {
        filePath: data?.filePath,
        createIfNotExists: false,
      });
      return;
    default:
      return;
  }
}

async function handleApplicationMenuAction(action: string) {
  if (action === "terms-of-service") {
    openAboutWindow("https://colab.dev/terms-of-service");
    return;
  }
  if (action === "privacy-statement") {
    openAboutWindow("https://colab.dev/privacy");
    return;
  }
  if (action === "acknowledgements") {
    openAboutWindow("views://assets/licenses.html");
    return;
  }
  if (action === "open-file") {
    const files = await Utils.openFileDialog({
      startingFolder: getMenuStartingFolder(),
      allowedFileTypes: "",
      canChooseFiles: true,
      canChooseDirectory: false,
      allowsMultipleSelection: true,
    });
    for (const filePath of files) {
      sendToFocusedDashWindow("openFileInEditor", {
        filePath,
        createIfNotExists: false,
      });
    }
    return;
  }
  if (action === "open-folder") {
    const folders = await Utils.openFileDialog({
      startingFolder: getMenuStartingFolder(),
      allowedFileTypes: "",
      canChooseFiles: false,
      canChooseDirectory: true,
      allowsMultipleSelection: false,
    });
    for (const folderPath of folders) {
      sendToFocusedDashWindow("openFolderAsProject", {
        folderPath,
      });
    }
    return;
  }
  if (action === "open-command-palette") {
    sendToFocusedDashWindow("openCommandPalette", {});
    return;
  }
  if (action === "new-browser-tab") {
    sendToFocusedDashWindow("newBrowserTab", {});
    return;
  }
  if (action === "close-tab") {
    sendToFocusedDashWindow("closeCurrentTab", {});
    return;
  }
  if (action === "close-window") {
    sendToFocusedDashWindow("closeCurrentWindow", {});
    return;
  }
  if (action === "plugin-marketplace") {
    sendToFocusedDashWindow("openSettings", { settingsType: "plugin-marketplace" });
    return;
  }
  if (action === "llama-settings") {
    sendToFocusedDashWindow("openSettings", { settingsType: "llama-settings" });
    return;
  }
  if (action === "colab-settings") {
    sendToFocusedDashWindow("openSettings", { settingsType: "global-settings" });
    return;
  }
  if (action === "workspace-settings") {
    sendToFocusedDashWindow("openSettings", { settingsType: "workspace-settings" });
    return;
  }
  if (action.startsWith("global-shortcut:")) {
    const accelerator = action.replace("global-shortcut:", "");
    const shortcut = builtInShortcuts.find((candidate) => candidate.accelerator === accelerator);
    if (!shortcut) {
      return;
    }
    sendToFocusedDashWindow("handleGlobalShortcut", {
      key: shortcut.key,
      ctrl: shortcut.ctrl,
      shift: shortcut.shift,
      alt: shortcut.alt,
      meta: shortcut.meta,
    });
  }
}

function syncApplicationMenu() {
  ApplicationMenu.setApplicationMenu([
    {
      label: "Bunny Dash",
      submenu: [{ role: "quit", accelerator: "cmd+q" }],
    },
    {
      label: "File",
      submenu: [
        {
          type: "normal",
          label: "Open File...",
          action: "open-file",
          accelerator: "cmd+o",
        },
        {
          type: "normal",
          label: "Open Folder...",
          action: "open-folder",
          accelerator: "cmd+shift+o",
        },
        { type: "separator" },
        {
          type: "normal",
          label: "New Browser Tab",
          action: "new-browser-tab",
          accelerator: "cmd+t",
        },
        {
          type: "normal",
          label: "Close Tab",
          action: "close-tab",
          accelerator: "cmd+w",
        },
        {
          type: "normal",
          label: "Close Window",
          action: "close-window",
          accelerator: "cmd+shift+w",
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          type: "normal",
          label: "Next Tab",
          action: "global-shortcut:ctrl+tab",
          accelerator: "ctrl+tab",
        },
        {
          type: "normal",
          label: "Previous Tab",
          action: "global-shortcut:ctrl+shift+tab",
          accelerator: "ctrl+shift+tab",
        },
      ],
    },
    {
      label: "Tools",
      submenu: [
        {
          type: "normal",
          label: "Command Palette",
          action: "open-command-palette",
          accelerator: "cmd+p",
        },
        {
          type: "normal",
          label: "Command Palette (Commands)",
          action: "global-shortcut:cmd+shift+p",
          accelerator: "cmd+shift+p",
        },
        {
          type: "normal",
          label: "Find in Files",
          action: "global-shortcut:cmd+shift+f",
          accelerator: "cmd+shift+f",
        },
      ],
    },
    {
      label: "Settings",
      submenu: [
        {
          type: "normal",
          label: "Plugins",
          action: "plugin-marketplace",
        },
        {
          type: "normal",
          label: "Llama Settings",
          action: "llama-settings",
        },
        {
          type: "normal",
          label: "Bunny Dash Settings",
          action: "colab-settings",
        },
        {
          type: "normal",
          label: "Workspace Settings",
          action: "workspace-settings",
        },
      ],
    },
    {
      role: "help",
      label: "Help",
      submenu: [
        {
          type: "normal",
          label: "Terms of Service",
          action: "terms-of-service",
        },
        {
          type: "normal",
          label: "Privacy Statement",
          action: "privacy-statement",
        },
        {
          type: "normal",
          label: "Acknowledgements",
          action: "acknowledgements",
        },
      ],
    },
  ]);
}

function ensureDb() {
  if (!dashDb) {
    throw new Error("Bunny Dash DB has not been initialized");
  }
  return dashDb;
}

function initializeRuntimeContext(message?: {
  context?: {
    permissions?: string[];
    statePath?: string;
    config?: { ptyHeartbeatIntervalMs?: unknown };
  };
  manifest?: { version?: string };
}) {
  permissions = new Set(
    message?.context?.permissions ||
      ((app.permissions as string[] | undefined) ?? []),
  );
  statePath = message?.context?.statePath || app.statePath || statePath;
  manifestVersion = message?.manifest?.version || app.manifest?.version || manifestVersion;
  ptyHeartbeatIntervalMs = parseDurationMs(
    String(
      message?.context?.config?.ptyHeartbeatIntervalMs ??
        process.env.BUNNY_DASH_PTY_HEARTBEAT_INTERVAL_MS ??
        "",
    ),
    ptyHeartbeatIntervalMs,
    1_000,
  );
}

function ensureBootPromise() {
  if (!bootPromise) {
    bootPromise = (async () => {
      await loadState();
      ensureRuntimeState();
      currentState = captureCurrentState();
      ensurePtyHeartbeatLoop();
      syncApplicationMenu();
      await reopenRuntimeWindowsOnBoot();
      post({ type: "ready" });
      syncTray();
      emitSnapshot();
      log("bunny dash worker initialized");
    })();
  }

  return bootPromise;
}

initializeRuntimeContext();
if (statePath) {
  void ensureBootPromise();
}

ApplicationMenu.on("application-menu-clicked", (payload) => {
  const action = String((payload as { action?: string } | undefined)?.action || "");
  if (!action) {
    return;
  }
  void handleApplicationMenuAction(action);
});

ContextMenu.on("context-menu-clicked", (payload) => {
  const action =
    String(
      (payload as { action?: string; data?: unknown } | undefined)?.action ||
        (payload as { data?: { action?: string } } | undefined)?.data?.action ||
        "",
    );
  if (!action) {
    return;
  }

  const data =
    (payload as { data?: unknown } | undefined)?.data ??
    (payload as { data?: { data?: unknown } } | undefined)?.data?.data ??
    {};
  void handleContextMenuAction(action, data);
});

process.on("exit", () => {
  if (ptyHeartbeatTimer) {
    clearInterval(ptyHeartbeatTimer);
    ptyHeartbeatTimer = null;
  }
});

function flushDb() {
  const db = ensureDb() as any;
  if (typeof db.trySave === "function") {
    db.trySave();
  }
}

function getLensesForWorkspace(workspaceId: string) {
  return listLenses().filter(
    (lens) => getLensWorkspaceId(lens) === workspaceId && !isWorkspaceCurrentLensKey(lens.key),
  );
}

function setActiveWindow(windowId?: string) {
  if (!windowId) {
    return;
  }
  const runtimeWindow = runtimeWindows.find((window) => window.id === windowId);
  if (!runtimeWindow) {
    return;
  }
  state.currentWindowId = windowId;
  const lensId = getLensIdForWindow(runtimeWindow);
  if (lensId && findLensByKey(lensId)) {
    state.currentLayoutId = lensId;
  }
  syncActiveTreeNode();
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

function listLenses() {
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

function findLensByKey(key: string) {
  return listLenses().find((layout) => layout.key === key) || null;
}

function getWorkspaceByKey(key: string) {
  const workspace = findWorkspaceByKey(key);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${key}`);
  }
  return workspace;
}

function getLensByKey(key: string) {
  const layout = findLensByKey(key);
  if (!layout) {
    throw new Error(`Unknown lens: ${key}`);
  }
  return layout;
}

function ensureWorkspaceCurrentLens(workspaceId: string) {
  const existing = findLensByKey(workspaceCurrentLensKey(workspaceId));
  if (existing) {
    return existing;
  }

  const db = ensureDb();
  const workspace = getWorkspaceByKey(workspaceId);
  const hiddenLens = db.collection("layouts").insert({
    key: workspaceCurrentLensKey(workspaceId),
    name: "Current",
    description: `Current working state for ${workspace.name}.`,
    workspaceId,
    windowStateJson: serializeColabWindow(makeDefaultColabWindow("main")),
    sortOrder: listLenses().length,
    windows: [
      {
        id: "main",
        title: buildLiveWindowTitle(workspace, { name: "Current" } as LensDoc, "Main"),
        workspaceId,
        mainTabIds: ["workspace"],
        sideTabIds: ["current-state"],
        currentMainTabId: "workspace",
        currentSideTabId: "current-state",
      },
    ],
  });
  flushDb();
  return hiddenLens;
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

function cloneColabWindow(value: ColabWindow) {
  return structuredClone(value);
}

function serializeColabWindow(value: ColabWindow) {
  return JSON.stringify(value);
}

function parseStoredColabWindow(lens: LensDoc) {
  if (typeof lens.windowStateJson === "string" && lens.windowStateJson.trim()) {
    try {
      return JSON.parse(lens.windowStateJson) as ColabWindow;
    } catch (error) {
      log(
        `failed to parse stored lens window for ${lens.key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return makeDefaultColabWindow(lens.windows[0]?.id || "main");
}

function getLensWorkspaceId(lens: LensDoc) {
  return lens.workspaceId || lens.windows[0]?.workspaceId || "local-workspace";
}

function makeLiveWindowId(lensId: string, baseWindowId = "main") {
  return `${lensId}${LIVE_WINDOW_ID_SEPARATOR}${baseWindowId}${LIVE_WINDOW_ID_SEPARATOR}${Date.now()}`;
}

function lensIdFromWindowId(windowId: string) {
  const maybeLensId = windowId.split(LIVE_WINDOW_ID_SEPARATOR)[0];
  if (maybeLensId && findLensByKey(maybeLensId)) {
    return maybeLensId;
  }
  return null;
}

function getLensIdForWindow(window: LensWindow) {
  if (window.lensId && findLensByKey(window.lensId)) {
    return window.lensId;
  }
  return lensIdFromWindowId(window.id) || state.currentLayoutId;
}

function resolveWindowLensId(window: LensWindow) {
  if (window.lensId && findLensByKey(window.lensId)) {
    return window.lensId;
  }
  const fromId = lensIdFromWindowId(window.id);
  if (fromId && findLensByKey(fromId)) {
    return fromId;
  }
  if (window.id === state.currentWindowId && findLensByKey(state.currentLayoutId)) {
    return state.currentLayoutId;
  }
  return ensureWorkspaceCurrentLens(window.workspaceId).key;
}

function buildLiveWindowTitle(workspace: WorkspaceDoc, lens: LensDoc, windowTitle?: string) {
  return windowTitle?.trim() || `${workspace.name} · ${lens.name}`;
}

function removeColabWindowFromAllWorkspaces(windowId: string) {
  for (const workspace of Object.values(colabState.workspaces || {})) {
    workspace.windows = (workspace.windows || []).filter((window) => window.id !== windowId);
  }
}

function upsertColabWindowForWorkspace(workspaceId: string, window: ColabWindow) {
  const workspace = getOrCreateColabWorkspace(workspaceId);
  const existingIndex = workspace.windows.findIndex((candidate) => candidate.id === window.id);
  if (existingIndex >= 0) {
    workspace.windows[existingIndex] = cloneColabWindow(window);
  } else {
    workspace.windows = [...workspace.windows, cloneColabWindow(window)];
  }
}

function ensureColabWorkspaceWindow(runtimeWindow: LensWindow, lens?: LensDoc) {
  const workspaceId = runtimeWindow.workspaceId;
  const workspace = getOrCreateColabWorkspace(workspaceId);
  const existing = workspace.windows.find((candidate) => candidate.id === runtimeWindow.id);
  if (existing) {
    return existing;
  }

  const resolvedLens = lens || findLensByKey(getLensIdForWindow(runtimeWindow)) || getCurrentLens();
  const next = cloneColabWindow(parseStoredColabWindow(resolvedLens));
  next.id = runtimeWindow.id;
  upsertColabWindowForWorkspace(workspaceId, next);
  return next;
}

function getColabWindowForRuntimeWindow(windowId: string) {
  for (const workspace of Object.values(colabState.workspaces || {})) {
    const existing = workspace.windows.find((candidate) => candidate.id === windowId);
    if (existing) {
      return existing;
    }
  }
  const runtimeWindow = runtimeWindows.find((candidate) => candidate.id === windowId);
  if (!runtimeWindow) {
    return null;
  }
  return ensureColabWorkspaceWindow(runtimeWindow);
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

function emitViewMessage(name: string, payload?: unknown, windowId?: string) {
  const targetWindowId = windowId || state.currentWindowId;
  const existing = browserWindows.get(targetWindowId);
  if (existing) {
    existing.send(name, payload, { raw: true });
    return;
  }

  post({
    type: "action",
    action: "emit-view",
    payload: { raw: true, name, payload, windowId: targetWindowId },
  });
}

function handlePtyTerminalOutput(payload: unknown) {
  const eventPayload =
    payload && typeof payload === "object"
      ? (payload as {
          terminalId?: string;
          data?: string;
          windowId?: string | null;
        })
      : {};
  const terminalId = String(eventPayload.terminalId || "");
  if (!terminalId) {
    return;
  }

  const targetWindowId =
    typeof eventPayload.windowId === "string" && eventPayload.windowId.length > 0
      ? eventPayload.windowId
      : terminalWindowOwners.get(terminalId);
  if (targetWindowId) {
    terminalWindowOwners.set(terminalId, targetWindowId);
  }

  emitViewMessage(
    "terminalOutput",
    {
      terminalId,
      data: String(eventPayload.data || ""),
    },
    targetWindowId,
  );
}

function handlePtyTerminalExit(payload: unknown) {
  const eventPayload =
    payload && typeof payload === "object"
      ? (payload as {
          terminalId?: string;
          exitCode?: number;
          signal?: number;
          windowId?: string | null;
        })
      : {};
  const terminalId = String(eventPayload.terminalId || "");
  if (!terminalId) {
    return;
  }

  const targetWindowId =
    typeof eventPayload.windowId === "string" && eventPayload.windowId.length > 0
      ? eventPayload.windowId
      : terminalWindowOwners.get(terminalId);
  emitViewMessage(
    "terminalExit",
    {
      terminalId,
      exitCode: Number(eventPayload.exitCode || 0),
      signal: Number(eventPayload.signal || 0),
    },
    targetWindowId,
  );
  log(`PTY carrot terminal exited ${terminalId}`);
  terminalWindowOwners.delete(terminalId);
}

async function killTerminalSession(terminalId: string) {
  if (!terminalId) {
    return;
  }

  try {
    await invokePtyCarrot<boolean>("killTerminal", {
      terminalId,
    });
  } catch (error) {
    log(
      `failed to kill PTY terminal ${terminalId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    terminalWindowOwners.delete(terminalId);
  }
}

async function killTerminalsForWindow(windowId: string) {
  const terminalIds = Array.from(terminalWindowOwners.entries())
    .filter(([, ownerWindowId]) => ownerWindowId === windowId)
    .map(([terminalId]) => terminalId);

  if (terminalIds.length === 0) {
    return;
  }

  await Promise.all(terminalIds.map((terminalId) => killTerminalSession(terminalId)));
  log(`killed ${terminalIds.length} PTY terminal(s) for window ${windowId}`);
}

async function invokePtyCarrot<T = unknown>(
  method: string,
  params?: unknown,
  options?: { windowId?: string },
) {
  return Carrots.invoke<T>(PTY_CARROT_ID, method, params, options);
}

async function heartbeatPtyTerminals() {
  const terminalIds = Array.from(terminalWindowOwners.keys());
  if (terminalIds.length === 0) {
    return;
  }

  try {
    await invokePtyCarrot<{ refreshedCount: number }>("heartbeatTerminals", {
      terminalIds,
    });
  } catch {
    // Ignore heartbeat failures here. Explicit terminal calls will still surface errors.
  }
}

function ensurePtyHeartbeatLoop() {
  if (ptyHeartbeatTimer) {
    return;
  }

  ptyHeartbeatTimer = setInterval(() => {
    void heartbeatPtyTerminals();
  }, ptyHeartbeatIntervalMs);
}

app.on("pty-terminal-output", handlePtyTerminalOutput);
app.on("pty-terminal-exit", handlePtyTerminalExit);

function emitSetProjectsForWindow(windowId: string) {
  const runtimeWindow = runtimeWindows.find((window) => window.id === windowId);
  if (!runtimeWindow) {
    return;
  }

  const workspace = getOrCreateColabWorkspace(runtimeWindow.workspaceId);
  ensureColabWorkspaceWindow(runtimeWindow);
  emitViewMessage(
    "setProjects",
    {
      projects: colabProjectsForWorkspace(workspace.id),
      tokens: colabState.tokens || [],
      workspace,
      appSettings: colabState.appSettings || defaultColabAppSettings,
      bunnyDash: buildWorkspaceLensPayload(windowId),
    },
    windowId,
  );
}

function buildWorkspaceLensPayload(windowId = state.currentWindowId): BunnyDashWorkspaceLensPayload {
  const runtimeWindow = runtimeWindows.find((window) => window.id === windowId) || getCurrentWindowUnsafe();
  const currentWorkspaceId = runtimeWindow?.workspaceId || getCurrentWorkspace().key;
  const currentLensId = runtimeWindow ? getLensIdForWindow(runtimeWindow) : state.currentLayoutId;

  return {
    currentWorkspaceId,
    currentLensId,
    workspaces: listWorkspaces().map((workspace) => ({
      id: workspace.key,
      name: workspace.name,
      subtitle: workspace.subtitle,
      isCurrent: workspace.key === currentWorkspaceId,
      currentLensId: ensureWorkspaceCurrentLens(workspace.key).key,
      currentLensIsActive:
        workspace.key === currentWorkspaceId &&
        ensureWorkspaceCurrentLens(workspace.key).key === currentLensId,
      canExpand: getLensesForWorkspace(workspace.key).length > 0,
      lenses: getLensesForWorkspace(workspace.key).map((lens) => ({
        id: lens.key,
        name: lens.name,
        description: lens.description,
        workspaceId: workspace.key,
        isCurrent: workspace.key === currentWorkspaceId && lens.key === currentLensId,
        isDirty:
          workspace.key === currentWorkspaceId &&
          lens.key === currentLensId &&
          runtimeWindow != null
            ? isLensDirtyInWindow(lens, runtimeWindow)
            : false,
      })),
    })),
  };
}

function emitSetProjects(workspaceId?: string) {
  const windows = workspaceId
    ? runtimeWindows.filter((window) => window.workspaceId === workspaceId)
    : runtimeWindows;
  for (const window of windows) {
    emitSetProjectsForWindow(window.id);
  }
}

function emitFileWatchEvent(absolutePath: string, workspaceId?: string) {
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

  const targetWindows = workspaceId
    ? runtimeWindows.filter((window) => window.workspaceId === workspaceId)
    : runtimeWindows;
  for (const window of targetWindows) {
    emitViewMessage(
      "fileWatchEvent",
      {
        absolutePath,
        exists,
        isDelete: !exists,
        isAdding: exists,
        isFile,
        isDir,
      },
      window.id,
    );
  }
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

          emitFileWatchEvent(absolutePath, project.workspaceId);
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

function getCurrentStateDoc() {
  const doc = ensureDb()
    .collection("sessionSnapshots")
    .query({ where: (item) => item.key === "last", limit: 1 }).data?.[0];

  if (!doc) {
    throw new Error("Missing Bunny Dash current state");
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

function captureCurrentState(): CurrentState {
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
    const currentLens = findLensByKey(state.currentLayoutId);
    if (currentLens) {
      return findWorkspaceByKey(getLensWorkspaceId(currentLens)) || listWorkspaces()[0] || null;
    }
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

function getCurrentLens() {
  const currentWindow = getCurrentWindowUnsafe();
  if (currentWindow) {
    const lensId = getLensIdForWindow(currentWindow);
    const lens = findLensByKey(lensId);
    if (lens) {
      return lens;
    }
  }
  return getLensByKey(state.currentLayoutId);
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
  const layouts = listLenses();
  if (!layouts.some((layout) => layout.key === state.currentLayoutId)) {
    state.currentLayoutId = layouts[0]!.key;
  }

  if (runtimeWindows.length > 0 && !runtimeWindows.some((window) => window.id === state.currentWindowId)) {
    state.currentWindowId = runtimeWindows[0]!.id;
  }

  const workspaceIds = new Set(listWorkspaces().map((workspace) => workspace.key));
  for (const window of runtimeWindows) {
    if (!workspaceIds.has(window.workspaceId)) {
      window.workspaceId = listWorkspaces()[0]!.key;
    }
    window.lensId = resolveWindowLensId(window);
    if (!window.mainTabIds.includes(window.currentMainTabId)) {
      window.currentMainTabId = window.mainTabIds[0]!;
    }
    if (!window.sideTabIds.includes(window.currentSideTabId)) {
      window.currentSideTabId = window.sideTabIds[0]!;
    }
    ensureColabWorkspaceWindow(window);
  }

  const activeWindow = getCurrentWindowUnsafe();
  const activeLensId = activeWindow ? getLensIdForWindow(activeWindow) : null;
  if (activeLensId && findLensByKey(activeLensId)) {
    state.currentLayoutId = activeLensId;
  }

  const runtimeWindowIds = new Set(runtimeWindows.map((window) => window.id));
  for (const workspace of Object.values(colabState.workspaces || {})) {
    workspace.windows = (workspace.windows || []).filter((window) =>
      runtimeWindowIds.has(window.id),
    );
  }

  if (!isTreeNodeIdValid(state.activeTreeNodeId)) {
    syncActiveTreeNode();
  }
}

function isLegacyCurrentSessionWindow(window: LensWindow) {
  return (
    window.id === DEFAULT_STARTER_LENS_WINDOW.id &&
    window.title === DEFAULT_STARTER_LENS_WINDOW.title &&
    window.workspaceId === DEFAULT_STARTER_LENS_WINDOW.workspaceId &&
    sameTabIds(window.mainTabIds, LEGACY_CURRENT_SESSION_MAIN_TABS) &&
    sameTabIds(window.sideTabIds, LEGACY_CURRENT_SESSION_SIDE_TABS)
  );
}

function normalizeCurrentSessionWindows(windows: LensWindow[]) {
  let didNormalize = false;
  const nextWindows = windows.map((window) => {
    if (!isLegacyCurrentSessionWindow(window)) {
      return window;
    }

    didNormalize = true;
    return {
      ...window,
      mainTabIds: [...DEFAULT_STARTER_LENS_WINDOW.mainTabIds],
      sideTabIds: [...DEFAULT_STARTER_LENS_WINDOW.sideTabIds],
      currentMainTabId: DEFAULT_STARTER_LENS_WINDOW.currentMainTabId,
      currentSideTabId: DEFAULT_STARTER_LENS_WINDOW.currentSideTabId,
    };
  });

  return {
    didNormalize,
    windows: nextWindows,
  };
}

function migrateLegacyStarterLens() {
  const db = ensureDb();
  const snapshotDoc = getCurrentStateDoc();
  const uiDoc = getUiSettingsDoc();
  const starterLens = findLensByKey("starter-lens");
  const legacyCurrentSessionLens = findLensByKey("current-session");

  const normalizedSnapshot = normalizeCurrentSessionWindows(snapshotDoc.windows);
  if (normalizedSnapshot.didNormalize) {
    db.collection("sessionSnapshots").update(snapshotDoc.id, {
      windows: cloneWindows(normalizedSnapshot.windows),
    });
  }

  if (legacyCurrentSessionLens && !starterLens) {
    db.collection("layouts").update(legacyCurrentSessionLens.id, {
      key: "starter-lens",
      name: "Starter Lens",
      description: "Default Bunny Dash lens for local work.",
    });
  }

  const canonicalStarterLens = findLensByKey("starter-lens") || legacyCurrentSessionLens;

  if (canonicalStarterLens) {
    const normalizedLayout = normalizeCurrentSessionWindows(canonicalStarterLens.windows);
    if (normalizedLayout.didNormalize) {
      db.collection("layouts").update(canonicalStarterLens.id, {
        windows: cloneWindows(normalizedLayout.windows),
      });
    }
  }

  if (snapshotDoc.currentLayoutId === "current-session") {
    db.collection("sessionSnapshots").update(snapshotDoc.id, {
      currentLayoutId: "starter-lens",
    });
  }

  if (
    uiDoc.currentLayoutId === "current-session" ||
    uiDoc.activeTreeNodeId === "lens-overview:current-session"
  ) {
    db.collection("uiSettings").update(uiDoc.id, {
      currentLayoutId: uiDoc.currentLayoutId === "current-session" ? "starter-lens" : uiDoc.currentLayoutId,
      activeTreeNodeId: "lens-overview:starter-lens",
    });
  }

  if (normalizedSnapshot.didNormalize || legacyCurrentSessionLens || snapshotDoc.currentLayoutId === "current-session") {
    flushDb();
  }
}

function hydrateLensMetadata() {
  const db = ensureDb();
  let didUpdate = false;

  for (const workspace of listWorkspaces()) {
    ensureWorkspaceCurrentLens(workspace.key);
  }

  for (const lens of listLenses()) {
    const workspaceId = getLensWorkspaceId(lens);
    const updates: Partial<LensDoc> = {};

    if (!lens.workspaceId) {
      updates.workspaceId = workspaceId;
    }

    if (!lens.windowStateJson) {
      const fallbackWindow =
        currentColabWorkspace().id === workspaceId
          ? getColabWindowForRuntimeWindow(state.currentWindowId) || makeDefaultColabWindow()
          : makeDefaultColabWindow(lens.windows[0]?.id || "main");
      updates.windowStateJson = serializeColabWindow(fallbackWindow);
    }

    if (Object.keys(updates).length > 0) {
      db.collection("layouts").update(lens.id, updates);
      didUpdate = true;
    }
  }

  if (didUpdate) {
    flushDb();
  }
}

function buildStats() {
  const workspaces = listWorkspaces();
  const projects = listProjectMounts();
  const lenses = listLenses().filter((lens) => !isWorkspaceCurrentLensKey(lens.key));
  const instanceCount = new Set(projects.map((project) => project.instanceLabel)).size;

  return [
    { label: "Workspaces", value: String(workspaces.length) },
    { label: "Projects", value: String(projects.length) },
    { label: "Lenses", value: String(lenses.length) },
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
  const workspaces = listWorkspaces();

  return [
    {
      id: "workspaces-root",
      label: "Workspaces",
      kind: "folder",
      children: workspaces.map((candidate) => ({
        id: `workspace:${candidate.key}`,
        label: candidate.name,
        kind: "folder" as const,
        children: getLensesForWorkspace(candidate.key).map((lens) => ({
          id: `lens-overview:${lens.key}`,
          label: lens.name,
          kind: "file" as const,
        })),
      })),
    },
    {
      id: `projects-root:${workspace.key}`,
      label: "Projects",
      kind: "folder",
      children: workspaceProjects.map((project) => ({
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
    },
    {
      id: "current-state-overview",
      label: "Current State",
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
  currentLens: LensDoc,
  currentWindow: LensWindow,
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
    case "lens":
      return {
        id: tabId,
        title: "Lens",
        kind: "fleet",
        icon: "▥",
        body: `${currentLens.name}\n\n${currentLens.description}\n\nWindows\n${runtimeWindows
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
          "Terminal sessions will move into a dedicated PTY carrot so Bunny Dash can attach locally or remotely without SSH. This is the future pty path.",
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
          "Bunny Dash now persists workspaces, project mounts, lenses, and current state in GoldfishDB. The current UI uses that local store as the source of truth rather than the old in-memory seed data.",
      };
    case "current-state":
    default:
      return {
        id: tabId,
        title: "Current State",
        kind: "notes",
        icon: "◌",
        body: `Current window: ${currentWindow.title}\nLens: ${currentLens.name}\nWorkspace: ${currentWorkspace.name}\n\nLast updated: ${new Date(currentState.updatedAt).toLocaleString()}\nLocal store: GoldfishDB`,
      };
  }
}

function formatCurrentStateLabel(updatedAt: number) {
  return `Updated ${new Date(updatedAt).toLocaleTimeString([], {
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
  const lenses = listLenses();
  const currentLens = getCurrentLens();
  const currentWindow =
    getCurrentWindowUnsafe() || buildRuntimeWindowFromLens(currentLens, state.currentWindowId || "main");
  const currentWorkspace = getCurrentWorkspace();
  const tree = buildTree(currentWorkspace);
  const mainTabs = currentWindow.mainTabIds.map((tabId) =>
    buildTab(tabId, currentWorkspace, currentLens, currentWindow),
  );
  const sideTabs = currentWindow.sideTabIds.map((tabId) =>
    buildTab(tabId, currentWorkspace, currentLens, currentWindow),
  );

  return {
    shellTitle: "Bunny Dash",
    subtitle: "Local shell for Bunny Ears fleets, lenses, and project work.",
    permissions: [...permissions],
    cloudLabel: "Bunny Cloud",
    cloudStatus: "colab-cloud is the working reference foundation for the future Bunny Cloud service.",
    commandHint: process.platform === "darwin" ? "cmd+p" : "ctrl+p",
    topActions: [
      { id: "command-palette", label: "Command Palette" },
      { id: "resume-last-state", label: "Resume Current State" },
      { id: "pop-out-bunny", label: "Pop Out Bunny" },
      { id: "bunny-cloud", label: "Bunny Cloud" },
    ],
    currentLens: {
      id: currentLens.key,
      name: currentLens.name,
      description: currentLens.description,
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
    lenses: lenses.map((lens) => ({
      id: lens.key,
      name: lens.name,
      description: lens.description,
      windowCount: lens.windows.length,
      isActive: lens.key === state.currentLayoutId,
    })),
    workspaces: workspaces.map((workspace) => ({
      id: workspace.key,
      name: workspace.name,
      subtitle: workspace.subtitle,
      projectCount: getProjectMountsForWorkspace(workspace.key).length,
      isCurrent: workspace.key === currentWorkspace.key,
    })),
    openWindows: runtimeWindows.map((window) => ({
      id: window.id,
      title: window.title,
      workspaceId: window.workspaceId,
      workspaceName: getWorkspaceByKey(window.workspaceId).name,
      isActive: window.id === state.currentWindowId,
    })),
    currentStateSummary: {
      updatedAt: currentState.updatedAt,
      label: formatCurrentStateLabel(currentState.updatedAt),
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
  } else if (currentWindow.currentMainTabId === "lens") {
    state.activeTreeNodeId = `lens-overview:${state.currentLayoutId}`;
  } else {
    state.activeTreeNodeId = `lens-overview:${getCurrentLens().key}`;
  }
}

async function writeCompatibilityState() {
  const persisted = {
    state: {
      sidebarCollapsed: state.sidebarCollapsed,
      bunnyPopoverOpen: false,
      currentLensId: state.currentLayoutId,
      currentLayoutId: state.currentLayoutId,
      currentWindowId: state.currentWindowId,
      activeTreeNodeId: state.activeTreeNodeId,
    },
    lens: {
      id: state.currentLayoutId,
      name: getCurrentLens().name,
    },
    currentState,
    sessionSnapshot: currentState,
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
  const snapshotDoc = getCurrentStateDoc();
  const currentWindow = getCurrentWindowUnsafe();

  db.collection("uiSettings").update(uiDoc.id, {
    sidebarCollapsed: state.sidebarCollapsed,
    bunnyPopoverOpen: false,
    currentLayoutId: state.currentLayoutId,
    currentWindowId: state.currentWindowId,
    activeTreeNodeId: state.activeTreeNodeId,
  });

  currentState = captureCurrentState();
  db.collection("sessionSnapshots").update(snapshotDoc.id, {
    updatedAt: currentState.updatedAt,
    currentLayoutId: currentState.currentLayoutId,
    currentWindowId: currentState.currentWindowId,
    windows: cloneWindows(currentState.windows),
  });

  if (currentWindow) {
    await syncRuntimeWindowFrameFromHost(currentWindow.id);
    const currentColabWindow = getCurrentColabWindow();
    const currentWorkspaceLens = ensureWorkspaceCurrentLens(currentWindow.workspaceId);
    db.collection("layouts").update(currentWorkspaceLens.id, {
      workspaceId: currentWindow.workspaceId,
      windowStateJson: serializeColabWindow(currentColabWindow),
      windows: [toLensTemplateWindow(currentWindow)],
    });
  }

  flushDb();
  await writeCompatibilityState();
}

async function loadState() {
  const dbFolder = `${dirname(statePath)}/goldfishdb`;
  dashDb = createDashDb(dbFolder);
  seedDashDb(dashDb);
  migrateLegacyExampleData(dashDb);
  migrateLegacyStarterLens();
  flushDb();

  const uiDoc = getUiSettingsDoc();
  const snapshotDoc = getCurrentStateDoc();

  state = {
    sidebarCollapsed: uiDoc.sidebarCollapsed,
    commandPaletteOpen: false,
    bunnyPopoverOpen: false,
    commandQuery: "",
    currentLayoutId: uiDoc.currentLayoutId || snapshotDoc.currentLayoutId,
    currentWindowId: uiDoc.currentWindowId || snapshotDoc.currentWindowId,
    activeTreeNodeId: uiDoc.activeTreeNodeId || `lens-overview:${snapshotDoc.currentLayoutId}`,
  };

  runtimeWindows = cloneWindows(snapshotDoc.windows);
  currentState = {
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

  hydrateLensMetadata();
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

function uniqueKey(base: string, existingKeys: string[]) {
  let candidate = slugify(base);
  let index = 2;
  while (existingKeys.includes(candidate)) {
    candidate = `${slugify(base)}-${index}`;
    index += 1;
  }
  return candidate;
}

function toLensTemplateWindow(window: LensWindow): LensWindow {
  return {
    ...structuredClone(window),
    id: window.id.split(LIVE_WINDOW_ID_SEPARATOR)[1] || "main",
  };
}

function buildRuntimeWindowFromLens(lens: LensDoc, windowId?: string): LensWindow {
  const template = structuredClone(lens.windows[0] || DEFAULT_STARTER_LENS_WINDOW);
  const workspace = getWorkspaceByKey(getLensWorkspaceId(lens));
  return {
    ...template,
    id: windowId || template.id,
    lensId: lens.key,
    workspaceId: workspace.key,
    title: buildLiveWindowTitle(workspace, lens, template.title),
  };
}

function buildDefaultRuntimeWindowForWorkspace(workspaceId: string, windowId: string): LensWindow {
  const workspace = getWorkspaceByKey(workspaceId);
  const currentLens = ensureWorkspaceCurrentLens(workspace.key);
  return {
    ...structuredClone(DEFAULT_STARTER_LENS_WINDOW),
    id: windowId,
    lensId: currentLens.key,
    workspaceId: workspace.key,
    title: "Main",
  };
}

function applyLensWindowStateToRuntimeWindow(lens: LensDoc, runtimeWindowId: string, workspaceId: string) {
  removeColabWindowFromAllWorkspaces(runtimeWindowId);
  const nextWindow = cloneColabWindow(parseStoredColabWindow(lens));
  nextWindow.id = runtimeWindowId;
  upsertColabWindowForWorkspace(workspaceId, nextWindow);
  return nextWindow;
}

function applyDefaultWorkspaceStateToRuntimeWindow(runtimeWindowId: string, workspaceId: string) {
  removeColabWindowFromAllWorkspaces(runtimeWindowId);
  const nextWindow = makeDefaultColabWindow(runtimeWindowId);
  upsertColabWindowForWorkspace(workspaceId, nextWindow);
  return nextWindow;
}

function getCurrentColabWindow() {
  return ensureColabWorkspaceWindow(getCurrentWindow(), getCurrentLens());
}

function updateColabWindowFrame(
  windowId: string,
  frame: Partial<{ x: number; y: number; width: number; height: number }>,
) {
  const colabWindow = getColabWindowForRuntimeWindow(windowId);
  if (!colabWindow) {
    return;
  }

  colabWindow.position = {
    ...colabWindow.position,
    ...(typeof frame.x === "number" ? { x: frame.x } : {}),
    ...(typeof frame.y === "number" ? { y: frame.y } : {}),
    ...(typeof frame.width === "number" ? { width: frame.width } : {}),
    ...(typeof frame.height === "number" ? { height: frame.height } : {}),
  };
  upsertColabWindowForWorkspace(
    runtimeWindows.find((window) => window.id === windowId)?.workspaceId || getCurrentWorkspace().key,
    colabWindow,
  );
}

function schedulePersistWindowFrame(windowId: string) {
  const existing = framePersistTimers.get(windowId);
  if (existing) {
    clearTimeout(existing);
  }

  framePersistTimers.set(
    windowId,
    setTimeout(() => {
      framePersistTimers.delete(windowId);
      if (state.currentWindowId !== windowId) {
        return;
      }
      void saveState();
    }, 120),
  );
}

function isLensDirtyInWindow(lens: LensDoc, window: LensWindow) {
  const currentColabWindow = getColabWindowForRuntimeWindow(window.id);
  if (!currentColabWindow) {
    return false;
  }

  const savedColabWindow = parseStoredColabWindow(lens);
  const savedTemplate = lens.windows[0] || DEFAULT_STARTER_LENS_WINDOW;
  const currentTemplate = toLensTemplateWindow(window);

  return (
    JSON.stringify(currentColabWindow) !== JSON.stringify(savedColabWindow) ||
    !sameLensWindowTemplate(currentTemplate, savedTemplate)
  );
}

async function restoreLensInCurrentWindow(lensId: string) {
  const lens = getLensByKey(lensId);
  const savedWindowState = parseStoredColabWindow(lens);
  log(
    `restoreLensInCurrentWindow begin: ${lens.key} rootPane=${savedWindowState.rootPane.type} currentPane=${savedWindowState.currentPaneId}`,
  );
  const currentWindow = getCurrentWindow();
  await killTerminalsForWindow(currentWindow.id);
  const restoredWindow = buildRuntimeWindowFromLens(lens, currentWindow.id);

  currentWindow.title = restoredWindow.title;
  currentWindow.lensId = restoredWindow.lensId;
  currentWindow.workspaceId = restoredWindow.workspaceId;
  currentWindow.mainTabIds = [...restoredWindow.mainTabIds];
  currentWindow.sideTabIds = [...restoredWindow.sideTabIds];
  currentWindow.currentMainTabId = restoredWindow.currentMainTabId;
  currentWindow.currentSideTabId = restoredWindow.currentSideTabId;

  const restoredColabWindow = applyLensWindowStateToRuntimeWindow(
    lens,
    currentWindow.id,
    restoredWindow.workspaceId,
  );
  const existingBrowserWindow = browserWindows.get(currentWindow.id);
  if (existingBrowserWindow) {
    existingBrowserWindow.setTitle(restoredWindow.title);
    existingBrowserWindow.setFrame(
      restoredColabWindow.position.x,
      restoredColabWindow.position.y,
      restoredColabWindow.position.width,
      restoredColabWindow.position.height,
    );
  }
  state.currentLayoutId = lens.key;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  state.activeTreeNodeId = `lens-overview:${lens.key}`;
  await saveState();
  syncTray();
  emitSetProjectsForWindow(currentWindow.id);
  emitSnapshot();
  log(`lens restored: ${lens.name}`);
  return snapshot();
}

async function openLensInNewWindow(lensId: string) {
  const lens = getLensByKey(lensId);
  const savedWindowState = parseStoredColabWindow(lens);
  log(
    `openLensInNewWindow begin: ${lens.key} rootPane=${savedWindowState.rootPane.type} currentPane=${savedWindowState.currentPaneId}`,
  );
  const liveWindowId = makeLiveWindowId(lens.key, lens.windows[0]?.id || "main");
  const runtimeWindow = buildRuntimeWindowFromLens(lens, liveWindowId);

  runtimeWindows.push(runtimeWindow);
  applyLensWindowStateToRuntimeWindow(lens, liveWindowId, runtimeWindow.workspaceId);

  state.currentWindowId = liveWindowId;
  state.currentLayoutId = lens.key;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  state.activeTreeNodeId = `lens-overview:${lens.key}`;
  await saveState();
  syncTray();
  emitSnapshot();
  emitSetProjectsForWindow(liveWindowId);
  focusWindow(liveWindowId, runtimeWindow.title);
  log(`lens opened in new window: ${lens.name}`);
  return snapshot();
}

async function focusExistingLensWindow(windowId: string) {
  const runtimeWindow = runtimeWindows.find((window) => window.id === windowId);
  if (!runtimeWindow) {
    throw new Error(`Unknown runtime window: ${windowId}`);
  }

  state.currentWindowId = runtimeWindow.id;
  state.currentLayoutId = getLensIdForWindow(runtimeWindow);
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  syncActiveTreeNode();
  await saveState();
  syncTray();
  emitSnapshot();
  emitSetProjectsForWindow(runtimeWindow.id);
  focusWindow(runtimeWindow.id, runtimeWindow.title);
  log(`lens focused: ${state.currentLayoutId}`);
  return snapshot();
}

async function activateLens(lensId: string) {
  return restoreLensInCurrentWindow(lensId);
}

async function openLens(lensId: string) {
  log(`openLens request: ${lensId}`);
  return activateLens(lensId);
}

async function restoreCurrentState() {
  const snapshotDoc = getCurrentStateDoc();
  runtimeWindows = cloneWindows(snapshotDoc.windows);
  state.currentLayoutId = snapshotDoc.currentLayoutId;
  state.currentWindowId = snapshotDoc.currentWindowId;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  currentState = {
    updatedAt: snapshotDoc.updatedAt,
    currentLayoutId: snapshotDoc.currentLayoutId,
    currentWindowId: snapshotDoc.currentWindowId,
    windows: cloneWindows(snapshotDoc.windows),
  };
  ensureRuntimeState();
  await saveState();
  syncTray();
  emitSetProjects();
  emitSnapshot();
  if (runtimeWindows.length > 0) {
    focusWindow(state.currentWindowId, getCurrentWindow().title);
  }
  log("current state restored");
}

async function overwriteCurrentLens() {
  const db = ensureDb();
  const lens = getCurrentLens();
  const currentWindow = getCurrentWindow();
  await syncRuntimeWindowFrameFromHost(currentWindow.id);
  const currentColabWindow = getCurrentColabWindow();
  log(
    `overwriteCurrentLens begin: ${lens.key} rootPane=${currentColabWindow.rootPane.type} currentPane=${currentColabWindow.currentPaneId}`,
  );
  db.collection("layouts").update(lens.id, {
    workspaceId: currentWindow.workspaceId,
    windowStateJson: serializeColabWindow(currentColabWindow),
    windows: [toLensTemplateWindow(currentWindow)],
  });
  flushDb();
  await saveState();
  syncTray();
  emitSetProjectsForWindow(currentWindow.id);
  emitSnapshot();
  log(`lens overwritten: ${lens.name}`);
}

async function createLens(
  workspaceId: string,
  name: string,
  description = "",
  sourceLensId?: string,
) {
  const workspace = getWorkspaceByKey(workspaceId);
  const lenses = listLenses();
  const cleanName = getUniqueLensDisplayName(workspace.key, name);
  const key = uniqueKey(cleanName, lenses.map((lens) => lens.key));
  const currentWindow = getCurrentWindow();
  const sourceLens = sourceLensId ? getLensByKey(sourceLensId) : null;
  const useCurrentWindowState =
    !sourceLens && currentWindow.workspaceId === workspace.key;

  let sourceColabWindow: ColabWindow;
  let sourceRuntimeWindow: LensWindow;

  if (sourceLens) {
    const isCurrentLens = sourceLens.key === getLensIdForWindow(currentWindow);
    const sourceWindow = isCurrentLens ? currentWindow : null;
    if (isCurrentLens && sourceWindow) {
      await syncRuntimeWindowFrameFromHost(sourceWindow.id);
    }
    sourceColabWindow = isCurrentLens
      ? getCurrentColabWindow()
      : parseStoredColabWindow(sourceLens);
    sourceRuntimeWindow = sourceWindow
      ? sourceWindow
      : buildRuntimeWindowFromLens(
          sourceLens,
          sourceLens.windows[0]?.id || "main",
        );
  } else if (useCurrentWindowState) {
    await syncRuntimeWindowFrameFromHost(currentWindow.id);
    sourceColabWindow = getCurrentColabWindow();
    sourceRuntimeWindow = currentWindow;
  } else {
    const workspaceCurrentLens = ensureWorkspaceCurrentLens(workspace.key);
    sourceColabWindow = parseStoredColabWindow(workspaceCurrentLens);
    sourceRuntimeWindow = buildRuntimeWindowFromLens(
      workspaceCurrentLens,
      workspaceCurrentLens.windows[0]?.id || "main",
    );
  }

  const created = ensureDb().collection("layouts").insert({
    key,
    name: cleanName,
    description: description.trim() || (sourceLens ? `Forked from ${sourceLens.name}` : `Saved from ${workspace.name}`),
    workspaceId: workspace.key,
    windowStateJson: serializeColabWindow(sourceColabWindow),
    sortOrder: lenses.length,
    windows: [toLensTemplateWindow(sourceRuntimeWindow)],
  });

  if (useCurrentWindowState) {
    state.currentLayoutId = created.key;
    currentWindow.lensId = created.key;
    state.activeTreeNodeId = `lens-overview:${created.key}`;
  }

  flushDb();
  await saveState();
  syncTray();
  if (useCurrentWindowState) {
    emitSetProjectsForWindow(currentWindow.id);
  } else {
    emitSetProjects();
  }
  broadcastRuntimeEventToDashWindows("refreshBunnyDashState");
  emitSnapshot();
  log(sourceLens ? `lens forked: ${created.name}` : `lens created: ${created.name}`);
  return snapshot();
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

  const currentLens = ensureWorkspaceCurrentLens(created.key);
  const starterColabWindow = parseStoredColabWindow(currentLens);
  const starterRuntimeWindow = buildRuntimeWindowFromLens(currentLens, getCurrentWindow().id);

  const currentWindow = getCurrentWindow();
  await killTerminalsForWindow(currentWindow.id);
  currentWindow.workspaceId = created.key;
  currentWindow.title = starterRuntimeWindow.title;
  currentWindow.mainTabIds = [...starterRuntimeWindow.mainTabIds];
  currentWindow.sideTabIds = [...starterRuntimeWindow.sideTabIds];
  currentWindow.currentMainTabId = starterRuntimeWindow.currentMainTabId;
  currentWindow.currentSideTabId = starterRuntimeWindow.currentSideTabId;
  state.currentLayoutId = currentLens.key;
  state.activeTreeNodeId = `workspace-overview:${created.key}`;
  removeColabWindowFromAllWorkspaces(currentWindow.id);
  upsertColabWindowForWorkspace(created.key, {
    ...starterColabWindow,
    id: currentWindow.id,
  });
  flushDb();
  await saveState();
  syncTray();
  emitSetProjectsForWindow(currentWindow.id);
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

async function saveLens(name: string, description = "") {
  const workspace = getCurrentWorkspace();
  await syncRuntimeWindowFrameFromHost(getCurrentWindow().id);
  const currentColabWindow = getCurrentColabWindow();
  log(
    `saveLens begin: workspace=${workspace.key} name=${name || "<auto>"} rootPane=${currentColabWindow.rootPane.type} currentPane=${currentColabWindow.currentPaneId}`,
  );
  return createLens(
    workspace.key,
    name || getUniqueLensNameForWorkspace(workspace.key, "Lens"),
    description,
  );
}

async function renameLens(lensId: string, name: string, description = "") {
  const lens = getLensByKey(lensId);
  if (isWorkspaceCurrentLensKey(lens.key)) {
    throw new Error("Cannot rename the workspace current lens");
  }

  const workspace = getWorkspaceByKey(getLensWorkspaceId(lens));
  const cleanName = getUniqueLensDisplayName(workspace.key, name, lens.key);
  ensureDb().collection("layouts").update(lens.id, {
    name: cleanName,
    description: description.trim(),
  });

  flushDb();
  await saveState();
  syncTray();
  emitSetProjects();
  broadcastRuntimeEventToDashWindows("refreshBunnyDashState");
  emitSnapshot();
  log(`lens renamed: ${cleanName}`);
  return snapshot();
}

async function openWorkspaceInNewWindow(workspaceId: string) {
  const workspace = getWorkspaceByKey(workspaceId);
  const currentLens = ensureWorkspaceCurrentLens(workspace.key);
  const savedWindowState = parseStoredColabWindow(currentLens);
  log(
    `openWorkspaceInNewWindow begin: ${workspace.key} rootPane=${savedWindowState.rootPane.type} currentPane=${savedWindowState.currentPaneId}`,
  );
  const liveWindowId = makeLiveWindowId(currentLens.key, currentLens.windows[0]?.id || "main");
  const runtimeWindow = buildRuntimeWindowFromLens(currentLens, liveWindowId);

  runtimeWindows.push(runtimeWindow);
  applyLensWindowStateToRuntimeWindow(currentLens, liveWindowId, runtimeWindow.workspaceId);

  state.currentWindowId = liveWindowId;
  state.currentLayoutId = currentLens.key;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  state.activeTreeNodeId = `workspace-overview:${workspace.key}`;
  await saveState();
  syncTray();
  emitSnapshot();
  emitSetProjectsForWindow(liveWindowId);
  focusWindow(liveWindowId, runtimeWindow.title);
  log(`workspace opened in new window: ${workspace.name}`);
  return snapshot();
}

async function syncRuntimeWindowFrameFromHost(windowId = state.currentWindowId) {
  const frame = await app.getWindowFrame(windowId);
  if (!frame) {
    return null;
  }
  updateColabWindowFrame(windowId, frame);
  return frame;
}

async function deleteLens(lensId: string) {
  const lens = getLensByKey(lensId);
  if (isWorkspaceCurrentLensKey(lens.key)) {
    throw new Error("Cannot delete a workspace current lens");
  }

  const workspaceId = getLensWorkspaceId(lens);
  const replacementLens = ensureWorkspaceCurrentLens(workspaceId);
  const affectedWindows = runtimeWindows.filter((window) => getLensIdForWindow(window) === lens.key);

  for (const runtimeWindow of affectedWindows) {
    await killTerminalsForWindow(runtimeWindow.id);
    const restoredWindow = buildRuntimeWindowFromLens(replacementLens, runtimeWindow.id);
    runtimeWindow.title = restoredWindow.title;
    runtimeWindow.lensId = restoredWindow.lensId;
    runtimeWindow.workspaceId = restoredWindow.workspaceId;
    runtimeWindow.mainTabIds = [...restoredWindow.mainTabIds];
    runtimeWindow.sideTabIds = [...restoredWindow.sideTabIds];
    runtimeWindow.currentMainTabId = restoredWindow.currentMainTabId;
    runtimeWindow.currentSideTabId = restoredWindow.currentSideTabId;

    const restoredColabWindow = applyLensWindowStateToRuntimeWindow(
      replacementLens,
      runtimeWindow.id,
      restoredWindow.workspaceId,
    );
    const existingBrowserWindow = browserWindows.get(runtimeWindow.id);
    if (existingBrowserWindow) {
      existingBrowserWindow.setTitle(restoredWindow.title);
      existingBrowserWindow.setFrame(
        restoredColabWindow.position.x,
        restoredColabWindow.position.y,
        restoredColabWindow.position.width,
        restoredColabWindow.position.height,
      );
    }
  }

  ensureDb().collection("layouts").remove(lens.id);
  if (state.currentLayoutId === lens.key) {
    state.currentLayoutId = replacementLens.key;
  }
  if (state.activeTreeNodeId === `lens-overview:${lens.key}`) {
    state.activeTreeNodeId = `workspace-overview:${workspaceId}`;
  }
  flushDb();
  await saveState();
  syncTray();
  emitSetProjects();
  broadcastRuntimeEventToDashWindows("refreshBunnyDashState");
  emitSnapshot();
  log(`lens deleted: ${lens.name}`);
  return snapshot();
}

async function openWorkspace(workspaceId: string) {
  const workspace = getWorkspaceByKey(workspaceId);
  const currentLens = ensureWorkspaceCurrentLens(workspace.key);
  log(`openWorkspace request: ${workspace.key}`);
  await restoreLensInCurrentWindow(currentLens.key);
  state.activeTreeNodeId = `workspace-overview:${workspace.key}`;
  await saveState();
  emitSetProjectsForWindow(getCurrentWindow().id);
  emitSnapshot();
  return snapshot();
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

async function handleTrayAction(action: string) {
  if (action === "open-window") {
    if (runtimeWindows.length === 0) {
      await openWorkspaceInNewWindow(getCurrentWorkspace().key);
      return;
    }
    focusWindow(state.currentWindowId, getCurrentWindow().title);
  } else if (action === "resume-last-state" || action === "restore-current-state") {
    await restoreCurrentState();
  } else if (action === "update-current-layout" || action === "overwrite-current-lens") {
    await overwriteCurrentLens();
  } else if (action.startsWith("layout:")) {
    await openLensInNewWindow(action.replace("layout:", ""));
  } else if (action.startsWith("lens:")) {
    await openLensInNewWindow(action.replace("lens:", ""));
  } else if (action.startsWith("workspace:")) {
    await openWorkspaceInNewWindow(action.replace("workspace:", ""));
  } else if (action === "stop") {
    stopCarrot();
  }
}

async function selectWindow(windowId: string) {
  if (!runtimeWindows.some((window) => window.id === windowId)) {
    return;
  }
  setActiveWindow(windowId);
  syncActiveTreeNode();
  await saveState();
  syncTray();
  emitSnapshot();
}

async function selectNode(nodeId: string) {
  state.activeTreeNodeId = nodeId;

  if (nodeId.startsWith("lens-overview:")) {
    await activateLens(nodeId.replace("lens-overview:", ""));
    return;
  } else if (nodeId.startsWith("lens:")) {
    await activateLens(nodeId.replace("lens:", ""));
    return;
  } else if (nodeId.startsWith("workspace-overview:")) {
    const workspaceId = nodeId.replace("workspace-overview:", "");
    if (workspaceId !== getCurrentWorkspace().key) {
      await openWorkspace(workspaceId);
      return;
    }
    ensureMainTab("workspace");
  } else if (nodeId === "current-state-overview") {
    ensureSideTab("current-state");
  } else if (nodeId.startsWith("window:")) {
    await selectWindow(nodeId.replace("window:", ""));
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
    return;
  } else if (nodeId.startsWith("lens-root:")) {
    return;
  }

  await saveState();
  emitSnapshot();
}

function syncTray() {
  if (!permissions.has("host:tray")) return;
  const currentLens = getCurrentLens();
  const workspaces = listWorkspaces();
  const currentWorkspace = getCurrentWorkspaceUnsafe();

  if (!tray) {
    tray = new Tray({ title: `Dash: ${currentLens.name}` });
    tray.on("click", (payload) => {
      void handleTrayAction(String((payload as { action?: string } | undefined)?.action || ""));
    });
  } else {
    tray.setTitle(`Dash: ${currentLens.name}`);
  }

  tray.setMenu([
    { type: "normal", label: "Open Bunny Dash", action: "open-window" },
    { type: "normal", label: "Restore Current State", action: "restore-current-state" },
    { type: "normal", label: "Overwrite Current Lens", action: "overwrite-current-lens" },
    { type: "divider" },
    {
      type: "normal",
        label: "Open Lens",
        action: "noop-lens",
        submenu: workspaces.map((workspace) => ({
          type: "normal",
          label: workspace.name,
          action: `noop-workspace:${workspace.key}`,
          submenu: getLensesForWorkspace(workspace.key).map((lens) => ({
            type: "normal",
            label:
            lens.key === state.currentLayoutId && workspace.key === currentWorkspace?.key
              ? `• ${lens.name}`
              : lens.name,
          action: `lens:${lens.key}`,
        })),
      })),
    },
    { type: "divider" },
    { type: "normal", label: "Stop Bunny Dash", action: "stop" },
  ]);
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

function buildWorkspaceLensSidebarData() {
  const currentWindow = getCurrentWindow();
  const currentLensId = getLensIdForWindow(currentWindow);

  return {
    currentWindowId: currentWindow.id,
    currentWorkspaceId: currentWindow.workspaceId,
    currentLensId,
    workspaces: listWorkspaces().map((workspace) => ({
      id: workspace.key,
      name: workspace.name,
      lenses: getLensesForWorkspace(workspace.key).map((lens) => ({
        id: lens.key,
        name: lens.name,
        isCurrent:
          lens.key === currentLensId && workspace.key === currentWindow.workspaceId,
      })),
    })),
  };
}

async function createAdditionalWindow(offset?: { x?: number; y?: number }) {
  const currentWindow = getCurrentWindow();
  const currentLens = getCurrentLens();
  const currentWorkspace = getCurrentWorkspace();
  const currentColabWindow = getCurrentColabWindow();
  const nextWindowId = makeLiveWindowId(currentLens.key, currentWindow.id.split(LIVE_WINDOW_ID_SEPARATOR)[1] || "main");
  const nextRuntimeWindow = {
    ...structuredClone(currentWindow),
    id: nextWindowId,
  };
  const nextColabWindow = cloneColabWindow(currentColabWindow);
  nextColabWindow.id = nextWindowId;
  if (offset) {
    nextColabWindow.position = {
      ...nextColabWindow.position,
      x: nextColabWindow.position.x + Number(offset.x || 0),
      y: nextColabWindow.position.y + Number(offset.y || 0),
    };
  }

  runtimeWindows.push(nextRuntimeWindow);
  upsertColabWindowForWorkspace(currentWorkspace.key, nextColabWindow);
  state.currentWindowId = nextWindowId;
  state.currentLayoutId = currentLens.key;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  syncActiveTreeNode();
  await saveState();
  syncTray();
  emitSnapshot();
  emitSetProjectsForWindow(nextWindowId);
  focusWindow(nextWindowId, nextRuntimeWindow.title);
  log(`window opened: ${nextWindowId}`);
  return snapshot();
}

async function hideCurrentWorkspaceWindows() {
  const workspaceId = getCurrentWorkspace().key;
  const windowIds = runtimeWindows
    .filter((window) => window.workspaceId === workspaceId)
    .map((window) => window.id);

  for (const windowId of windowIds) {
    closeWindow(windowId);
  }

  log(`workspace hidden: ${workspaceId}`);
}

async function handleColabRequest(method: string, params: any) {
  switch (method) {
    case "getInitialState": {
      const workspace = currentColabWorkspace();
      ensureColabWorkspaceWindow(getCurrentWindow());
      return {
        windowId: getCurrentWindow().id,
        buildVars: colabBuildVars(),
        paths: colabPaths(),
        peerDependencies: colabPeerDependencies(),
        workspace,
        bunnyDash: buildWorkspaceLensPayload(getCurrentWindow().id),
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
      log(`syncWorkspace request: workspace=${getCurrentWorkspace().key}`);
      colabState.workspaces ||= {};
      colabState.workspaces[getCurrentWorkspace().key] = params.workspace;
      await saveState();
      emitSetProjectsForWindow(getCurrentWindow().id);
      return;
    case "syncAppSettings":
      colabState.appSettings = params.appSettings;
      await writeCompatibilityState();
      return;
    case "openFileDialog":
      return Utils.openFileDialog({
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
      await Utils.showItemInFolder(String(params?.path || ""));
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
      return (async () => {
        const currentWindowId = getCurrentWindow().id;
        const terminalId = await invokePtyCarrot<string>(
          "createTerminal",
          {
            cwd: String(params?.cwd || process.cwd()),
            shell: typeof params?.shell === "string" ? params.shell : undefined,
            cols: Number(params?.cols || 80),
            rows: Number(params?.rows || 24),
          },
          { windowId: currentWindowId },
        );
        log(`PTY carrot created terminal ${terminalId} for window ${currentWindowId}`);
        terminalWindowOwners.set(terminalId, currentWindowId);
        return terminalId;
      })();
    case "writeToTerminal":
      return invokePtyCarrot<boolean>("writeToTerminal", {
        terminalId: String(params?.terminalId || ""),
        data: String(params?.data || ""),
      });
    case "resizeTerminal":
      return invokePtyCarrot<boolean>("resizeTerminal", {
        terminalId: String(params?.terminalId || ""),
        cols: Number(params?.cols || 80),
        rows: Number(params?.rows || 24),
      });
    case "killTerminal":
      return (async () => {
        const result = await invokePtyCarrot<boolean>("killTerminal", {
          terminalId: String(params?.terminalId || ""),
        });
        terminalWindowOwners.delete(String(params?.terminalId || ""));
        return result;
      })();
    case "getTerminalCwd":
      return invokePtyCarrot<string | null>("getTerminalCwd", {
        terminalId: String(params?.terminalId || ""),
      });
    case "getWorkspaceLensSidebar":
      return buildWorkspaceLensSidebarData();
    case "activateLens":
      return activateLens(String(params?.lensId || state.currentLayoutId));
    case "findFilesInWorkspace":
      return findFilesInWorkspace(String(params?.query || ""));
    case "findAllInWorkspace":
      return findAllInWorkspace(String(params?.query || ""));
    case "cancelFileSearch":
    case "cancelFindAll":
      return true;
    case "getUniqueNewName":
      return getUniqueNewName(String(params?.parentPath || ""), String(params?.baseName || "untitled"));
    case "getUniqueLensName":
      return getUniqueLensNameForWorkspace(
        String(params?.workspaceId || getCurrentWorkspace().key),
        String(params?.baseName || "Lens"),
      );
    case "makeFileNameSafe":
      return makeFileNameSafe(String(params?.value || ""));
    case "getFaviconForUrl":
      return "views://assets/file-icons/bookmark.svg";
    case "showContextMenu":
      ContextMenu.showContextMenu(Array.isArray(params?.menuItems) ? params.menuItems : []);
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
      app.openBunnyWindow({
        screenX: typeof payload?.screenX === "number" ? payload.screenX : undefined,
        screenY: typeof payload?.screenY === "number" ? payload.screenY : undefined,
      });
      return;
    case "closeWindow":
      closeWindow(getCurrentWindow().id);
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
      await openWorkspace(listWorkspaces()[0]!.key);
      emitSetProjects();
      await writeCompatibilityState();
      return;
    }
    case "track":
    case "installUpdateNow":
    case "addToken":
    case "deleteToken":
    case "formatFile":
    case "tsServerRequest":
    case "syncDevlink":
      return;
    case "createWindow":
      await createAdditionalWindow(
        payload && typeof payload === "object"
          ? { x: Number(payload.offset?.x || 0), y: Number(payload.offset?.y || 0) }
          : undefined,
      );
      return;
    case "hideWorkspace":
      await hideCurrentWorkspaceWindows();
      return;
    default:
      return;
  }
}

self.onmessage = async (event) => {
  const message = event.data as any;

  if (message.type === "init") {
    initializeRuntimeContext(message);
    await ensureBootPromise();
    return;
  }

  if (message.type === "event") {
    await ensureBootPromise();

    if (message.name === "boot") {
      syncTray();
      emitSnapshot();
      return;
    }

    if (message.name === "window-focus") {
      setActiveWindow(String(message.payload?.windowId || ""));
      syncTray();
      emitSnapshot();
      return;
    }

    if (message.name === "window-closed") {
      const closedWindowId = String(message.payload?.windowId || "");
      browserWindows.delete(closedWindowId);
      await killTerminalsForWindow(closedWindowId);
      removeColabWindowFromAllWorkspaces(closedWindowId);
      runtimeWindows = runtimeWindows.filter((window) => window.id !== closedWindowId);
      const pendingPersist = framePersistTimers.get(closedWindowId);
      if (pendingPersist) {
        clearTimeout(pendingPersist);
        framePersistTimers.delete(closedWindowId);
      }
      if (state.currentWindowId === closedWindowId) {
        state.currentWindowId = runtimeWindows[0]?.id || "";
      }
      if (runtimeWindows.length > 0) {
        const currentWindow = getCurrentWindowUnsafe();
        if (currentWindow) {
          state.currentLayoutId = getLensIdForWindow(currentWindow);
        }
      }
      syncActiveTreeNode();
      await saveState();
      syncTray();
      emitSetProjects();
      emitSnapshot();
      return;
    }
    return;
  }

  if (message.type !== "request") {
    return;
  }

  try {
    await ensureBootPromise();
    setActiveWindow(typeof message.windowId === "string" ? message.windowId : undefined);

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
        state.activeTreeNodeId = `lens-overview:${state.currentLayoutId}`;
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
      case "openLens":
      case "applyLayout":
        await openLens(String(message.params?.lensId || message.params?.layoutId || state.currentLayoutId));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "openLensInNewWindow":
        await openLensInNewWindow(String(message.params?.lensId || state.currentLayoutId));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "switchWorkspace":
      case "openWorkspace":
        await openWorkspace(String(message.params?.workspaceId || getCurrentWorkspace().key));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "openWorkspaceInNewWindow":
        await openWorkspaceInNewWindow(String(message.params?.workspaceId || getCurrentWorkspace().key));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "selectLayoutWindow":
      case "selectWindow":
        await selectWindow(String(message.params?.windowId || state.currentWindowId));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "restoreCurrentState":
      case "resumeLastState":
        await restoreCurrentState();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "overwriteCurrentLens":
      case "updateCurrentLayout":
        await overwriteCurrentLens();
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
      case "saveLens":
      case "saveLayout": {
        const created = await saveLens(
          String(message.params?.name || ""),
          String(message.params?.description || ""),
        );
        post({ type: "response", requestId: message.requestId, success: true, payload: created });
        break;
      }
      case "createLens": {
        const created = await createLens(
          String(message.params?.workspaceId || getCurrentWorkspace().key),
          String(message.params?.name || ""),
          String(message.params?.description || ""),
          typeof message.params?.sourceLensId === "string" ? message.params.sourceLensId : undefined,
        );
        post({ type: "response", requestId: message.requestId, success: true, payload: created });
        break;
      }
      case "renameLens": {
        const renamed = await renameLens(
          String(message.params?.lensId || state.currentLayoutId),
          String(message.params?.name || ""),
          String(message.params?.description || ""),
        );
        post({ type: "response", requestId: message.requestId, success: true, payload: renamed });
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
