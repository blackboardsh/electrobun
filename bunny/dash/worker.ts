import { existsSync } from "node:fs";

type TreeNode = {
  id: string;
  label: string;
  kind: "folder" | "file";
  children?: TreeNode[];
};

type ProjectMount = {
  id: string;
  name: string;
  instanceId: string;
  instanceLabel: string;
  path: string;
  kind: "code" | "content" | "ops" | "cloud";
  status: "ready" | "headless" | "draft";
};

type Workspace = {
  id: string;
  name: string;
  subtitle: string;
  projects: ProjectMount[];
};

type WindowTabId =
  | "workspace"
  | "projects"
  | "layout"
  | "instances"
  | "cloud"
  | "windows"
  | "notes"
  | "session";

type Tab = {
  id: WindowTabId;
  title: string;
  kind: "editor" | "fleet" | "cloud" | "notes";
  icon: string;
  body: string;
};

type LayoutWindow = {
  id: string;
  title: string;
  workspaceId: string;
  mainTabIds: WindowTabId[];
  sideTabIds: WindowTabId[];
  currentMainTabId: WindowTabId;
  currentSideTabId: WindowTabId;
};

type Layout = {
  id: string;
  name: string;
  description: string;
  windows: LayoutWindow[];
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

type PersistedDashState = {
  state?: Partial<DashState>;
  layouts?: Layout[];
  runtimeWindows?: LayoutWindow[];
  sessionSnapshot?: SessionSnapshot;
};

const workspaceCatalog: Workspace[] = [
  {
    id: "marketing",
    name: "Marketing",
    subtitle: "Campaigns, messaging, launch assets, and content calendars.",
    projects: [
      {
        id: "campaign-site",
        name: "campaign-site",
        instanceId: "host-machine",
        instanceLabel: "host-machine",
        path: "/Users/yoav/projects/marketing/campaign-site",
        kind: "content",
        status: "ready",
      },
      {
        id: "brand-copy",
        name: "brand-copy",
        instanceId: "host-machine",
        instanceLabel: "host-machine",
        path: "/Users/yoav/projects/marketing/brand-copy",
        kind: "content",
        status: "ready",
      },
      {
        id: "launch-assets",
        name: "launch-assets",
        instanceId: "local-vm-01",
        instanceLabel: "local-vm-01",
        path: "/workspace/assets/launch-assets",
        kind: "content",
        status: "ready",
      },
    ],
  },
  {
    id: "platform",
    name: "Platform",
    subtitle: "Bunny Ears, Bunny Dash, Bunny Cloud, and runtime infrastructure.",
    projects: [
      {
        id: "electrobun",
        name: "electrobun",
        instanceId: "host-machine",
        instanceLabel: "host-machine",
        path: "/Users/yoav/.colab-canary/projects/code/electrobun",
        kind: "code",
        status: "ready",
      },
      {
        id: "bunny-cloud",
        name: "bunny-cloud",
        instanceId: "cloud-vm-01",
        instanceLabel: "cloud-vm-01",
        path: "/srv/bunny-cloud",
        kind: "cloud",
        status: "headless",
      },
      {
        id: "colab-cloud-ref",
        name: "colab-cloud",
        instanceId: "host-machine",
        instanceLabel: "host-machine",
        path: "/Users/yoav/.colab-canary/projects/code/colab-cloud",
        kind: "cloud",
        status: "ready",
      },
    ],
  },
  {
    id: "client-alpha",
    name: "Client Alpha",
    subtitle: "Consulting workspace spanning strategy, delivery, and ops projects.",
    projects: [
      {
        id: "alpha-portal",
        name: "alpha-portal",
        instanceId: "local-vm-02",
        instanceLabel: "local-vm-02",
        path: "/workspace/client-alpha/portal",
        kind: "code",
        status: "ready",
      },
      {
        id: "alpha-deploy",
        name: "alpha-deploy",
        instanceId: "cloud-vm-02",
        instanceLabel: "cloud-vm-02",
        path: "/srv/client-alpha/deploy",
        kind: "ops",
        status: "headless",
      },
    ],
  },
];

const defaultLayouts: Layout[] = [
  {
    id: "marketing-day",
    name: "Marketing Day",
    description: "Content, launches, and fleet visibility across marketing and platform work.",
    windows: [
      {
        id: "campaign-planning",
        title: "Campaign Planning",
        workspaceId: "marketing",
        mainTabIds: ["projects", "workspace", "layout", "instances"],
        sideTabIds: ["windows", "notes", "cloud", "session"],
        currentMainTabId: "projects",
        currentSideTabId: "windows",
      },
      {
        id: "launch-ops",
        title: "Launch Ops",
        workspaceId: "platform",
        mainTabIds: ["instances", "layout", "cloud", "workspace"],
        sideTabIds: ["windows", "session", "notes", "cloud"],
        currentMainTabId: "instances",
        currentSideTabId: "session",
      },
    ],
  },
  {
    id: "fleet-ops",
    name: "Fleet Ops",
    description: "Remote Bunny Ears visibility, cloud relay, and instance management.",
    windows: [
      {
        id: "fleet-console",
        title: "Fleet Console",
        workspaceId: "platform",
        mainTabIds: ["instances", "cloud", "layout", "workspace"],
        sideTabIds: ["windows", "session", "notes", "cloud"],
        currentMainTabId: "instances",
        currentSideTabId: "windows",
      },
      {
        id: "client-ops",
        title: "Client Alpha Ops",
        workspaceId: "client-alpha",
        mainTabIds: ["projects", "workspace", "instances", "layout"],
        sideTabIds: ["windows", "notes", "session", "cloud"],
        currentMainTabId: "projects",
        currentSideTabId: "notes",
      },
    ],
  },
];

let statePath = "";
let permissions = new Set<string>();
let layouts: Layout[] = cloneLayouts(defaultLayouts);
let runtimeWindows: LayoutWindow[] = cloneWindows(defaultLayouts[0]!.windows);
let sessionSnapshot: SessionSnapshot = {
  updatedAt: Date.now(),
  currentLayoutId: defaultLayouts[0]!.id,
  currentWindowId: defaultLayouts[0]!.windows[0]!.id,
  windows: cloneWindows(defaultLayouts[0]!.windows),
};

let state: DashState = {
  sidebarCollapsed: false,
  commandPaletteOpen: false,
  bunnyPopoverOpen: false,
  commandQuery: "",
  currentLayoutId: defaultLayouts[0]!.id,
  currentWindowId: defaultLayouts[0]!.windows[0]!.id,
  activeTreeNodeId: "project:campaign-site",
};

function cloneLayouts(value: Layout[]) {
  return structuredClone(value);
}

function cloneWindows(value: LayoutWindow[]) {
  return structuredClone(value);
}

function post(message: unknown) {
  self.postMessage(message);
}

function log(message: string) {
  post({ type: "action", action: "log", payload: { message } });
}

function focusWindow() {
  post({ type: "action", action: "focus-window" });
}

function stopCarrot() {
  post({ type: "action", action: "stop-carrot" });
}

function emitSnapshot() {
  post({
    type: "action",
    action: "emit-view",
    payload: { name: "snapshot", payload: snapshot() },
  });
}

function canPersist() {
  return permissions.has("bun:read") && permissions.has("bun:write") && statePath.length > 0;
}

function getLayoutById(id: string) {
  return layouts.find((layout) => layout.id === id) ?? layouts[0]!;
}

function getWorkspaceById(id: string) {
  return workspaceCatalog.find((workspace) => workspace.id === id) ?? workspaceCatalog[0]!;
}

function getCurrentWindow() {
  return runtimeWindows.find((window) => window.id === state.currentWindowId) ?? runtimeWindows[0]!;
}

function getCurrentLayout() {
  return getLayoutById(state.currentLayoutId);
}

function getCurrentWorkspace() {
  return getWorkspaceById(getCurrentWindow().workspaceId);
}

function captureSessionSnapshot(): SessionSnapshot {
  return {
    updatedAt: Date.now(),
    currentLayoutId: state.currentLayoutId,
    currentWindowId: state.currentWindowId,
    windows: cloneWindows(runtimeWindows),
  };
}

function syncActiveTreeNode() {
  const currentWorkspace = getCurrentWorkspace();
  if (!state.activeTreeNodeId || state.activeTreeNodeId.startsWith("workspace-overview:")) {
    state.activeTreeNodeId = `workspace-overview:${currentWorkspace.id}`;
  }
}

function ensureRuntimeState() {
  if (layouts.length === 0) {
    layouts = cloneLayouts(defaultLayouts);
  }

  if (runtimeWindows.length === 0) {
    runtimeWindows = cloneWindows(getCurrentLayout().windows);
  }

  if (!runtimeWindows.some((window) => window.id === state.currentWindowId)) {
    state.currentWindowId = runtimeWindows[0]!.id;
  }

  if (!layouts.some((layout) => layout.id === state.currentLayoutId)) {
    state.currentLayoutId = layouts[0]!.id;
  }

  const currentWindow = getCurrentWindow();
  if (!workspaceCatalog.some((workspace) => workspace.id === currentWindow.workspaceId)) {
    currentWindow.workspaceId = workspaceCatalog[0]!.id;
  }

  if (!currentWindow.mainTabIds.includes(currentWindow.currentMainTabId)) {
    currentWindow.currentMainTabId = currentWindow.mainTabIds[0]!;
  }
  if (!currentWindow.sideTabIds.includes(currentWindow.currentSideTabId)) {
    currentWindow.currentSideTabId = currentWindow.sideTabIds[0]!;
  }

  syncActiveTreeNode();
}

async function saveState() {
  if (!canPersist()) return;
  ensureRuntimeState();
  sessionSnapshot = captureSessionSnapshot();
  const persisted: PersistedDashState = {
    state,
    layouts,
    runtimeWindows,
    sessionSnapshot,
  };
  await Bun.write(statePath, JSON.stringify(persisted, null, 2));
}

async function loadState() {
  if (!canPersist() || !existsSync(statePath)) return;
  try {
    const loaded = (await Bun.file(statePath).json()) as PersistedDashState;
    if (Array.isArray(loaded.layouts) && loaded.layouts.length > 0) {
      layouts = cloneLayouts(loaded.layouts);
    }
    if (Array.isArray(loaded.runtimeWindows) && loaded.runtimeWindows.length > 0) {
      runtimeWindows = cloneWindows(loaded.runtimeWindows);
    }
    if (loaded.sessionSnapshot?.windows?.length) {
      sessionSnapshot = {
        updatedAt: loaded.sessionSnapshot.updatedAt || Date.now(),
        currentLayoutId: loaded.sessionSnapshot.currentLayoutId || state.currentLayoutId,
        currentWindowId: loaded.sessionSnapshot.currentWindowId || state.currentWindowId,
        windows: cloneWindows(loaded.sessionSnapshot.windows),
      };
    }
    if (loaded.state) {
      state = {
        ...state,
        ...loaded.state,
      };
    }
    ensureRuntimeState();
  } catch (error) {
    log(`dash state load failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatTimestamp(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString();
}

function collectInstances(workspace: Workspace) {
  const seen = new Map<string, { id: string; label: string; projects: number; status: string }>();
  for (const project of workspace.projects) {
    const current = seen.get(project.instanceId) || {
      id: project.instanceId,
      label: project.instanceLabel,
      projects: 0,
      status: project.status,
    };
    current.projects += 1;
    if (project.status === "headless") {
      current.status = "headless";
    }
    seen.set(project.instanceId, current);
  }
  for (const window of runtimeWindows) {
    const windowWorkspace = getWorkspaceById(window.workspaceId);
    for (const project of windowWorkspace.projects) {
      if (!seen.has(project.instanceId)) {
        seen.set(project.instanceId, {
          id: project.instanceId,
          label: project.instanceLabel,
          projects: 0,
          status: project.status,
        });
      }
    }
  }
  return Array.from(seen.values());
}

function buildTab(tabId: WindowTabId, workspace: Workspace, layout: Layout, window: LayoutWindow): Tab {
  switch (tabId) {
    case "workspace":
      return {
        id: tabId,
        title: "workspace.md",
        kind: "editor",
        icon: "MD",
        body: `# ${workspace.name}\n\n${workspace.subtitle}\n\nProjects in scope:\n${workspace.projects
          .map((project) => `- ${project.name} @ ${project.instanceLabel} (${project.path})`)
          .join("\n")}`,
      };
    case "projects":
      return {
        id: tabId,
        title: "projects.json",
        kind: "editor",
        icon: "{}",
        body: JSON.stringify(workspace.projects, null, 2),
      };
    case "layout":
      return {
        id: tabId,
        title: "layout.json",
        kind: "editor",
        icon: "LY",
        body: JSON.stringify(
          {
            savedLayout: {
              id: layout.id,
              name: layout.name,
              description: layout.description,
              windows: layout.windows,
            },
            runtimeWindows,
          },
          null,
          2,
        ),
      };
    case "instances":
      return {
        id: tabId,
        title: "instances.json",
        kind: "fleet",
        icon: "{}",
        body: JSON.stringify(
          {
            activeWorkspace: workspace.name,
            instances: collectInstances(workspace),
          },
          null,
          2,
        ),
      };
    case "cloud":
      return {
        id: tabId,
        title: "bunny-cloud.ts",
        kind: "cloud",
        icon: "CL",
        body: `export const bunnyCloud = {\n  auth: true,\n  relay: \"colab-cloud reference\",\n  fleet: \"planned\",\n  browserDash: true,\n  hostedDash: true\n};`,
      };
    case "windows":
      return {
        id: tabId,
        title: "layout-windows.md",
        kind: "fleet",
        icon: "WN",
        body: runtimeWindows
          .map((candidate, index) => {
            const candidateWorkspace = getWorkspaceById(candidate.workspaceId);
            return `${index + 1}. ${candidate.title}\n   workspace: ${candidateWorkspace.name}\n   main: ${candidate.currentMainTabId}\n   side: ${candidate.currentSideTabId}`;
          })
          .join("\n\n"),
      };
    case "session":
      return {
        id: tabId,
        title: "last-state.json",
        kind: "notes",
        icon: "SS",
        body: JSON.stringify(sessionSnapshot, null, 2),
      };
    case "notes":
    default:
      return {
        id: tabId,
        title: "notes.md",
        kind: "notes",
        icon: "NT",
        body: `Bunny Dash now separates:\n- workspace -> shared projects\n- layout -> personal window state\n- session snapshot -> autosaved last state\n\nCurrent window: ${window.title}\nCurrent workspace: ${workspace.name}`,
      };
  }
}

function buildTree(): TreeNode[] {
  const layout = getCurrentLayout();
  const workspace = getCurrentWorkspace();
  const instances = collectInstances(workspace);

  return [
    {
      id: `layout-root:${layout.id}`,
      label: `layout: ${layout.name}`,
      kind: "folder",
      children: [
        { id: `layout-overview:${layout.id}`, label: "layout.json", kind: "file" },
        { id: "session-overview", label: "last-state.json", kind: "file" },
        ...runtimeWindows.map((window) => ({ id: `window:${window.id}`, label: window.title, kind: "file" as const })),
      ],
    },
    {
      id: `workspace:${workspace.id}`,
      label: workspace.name,
      kind: "folder",
      children: [
        { id: `workspace-overview:${workspace.id}`, label: "workspace.md", kind: "file" },
        {
          id: `projects-root:${workspace.id}`,
          label: "projects",
          kind: "folder",
          children: workspace.projects.map((project) => ({
            id: `project:${project.id}`,
            label: project.name,
            kind: "folder" as const,
            children: [
              { id: `project-readme:${project.id}`, label: "README.md", kind: "file" as const },
              { id: `project-mount:${project.id}`, label: "mount.json", kind: "file" as const },
            ],
          })),
        },
      ],
    },
    {
      id: "instances-root",
      label: "instances",
      kind: "folder",
      children: instances.map((instance) => ({
        id: `instance:${instance.id}`,
        label: `${instance.label} (${instance.status})`,
        kind: "file" as const,
      })),
    },
  ];
}

function buildLayoutSummaries() {
  return layouts.map((layout) => ({
    id: layout.id,
    name: layout.name,
    description: layout.description,
    windowCount: layout.windows.length,
    isActive: layout.id === state.currentLayoutId,
  }));
}

function buildWorkspaceSummaries() {
  const currentWorkspace = getCurrentWorkspace();
  return workspaceCatalog.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    subtitle: workspace.subtitle,
    projectCount: workspace.projects.length,
    isCurrent: workspace.id === currentWorkspace.id,
  }));
}

function buildWindowSummaries() {
  return runtimeWindows.map((window) => ({
    id: window.id,
    title: window.title,
    workspaceId: window.workspaceId,
    workspaceName: getWorkspaceById(window.workspaceId).name,
    isActive: window.id === state.currentWindowId,
  }));
}

function snapshot() {
  ensureRuntimeState();
  const currentLayout = getCurrentLayout();
  const currentWindow = getCurrentWindow();
  const currentWorkspace = getCurrentWorkspace();
  const mainTabs = currentWindow.mainTabIds.map((tabId) => buildTab(tabId, currentWorkspace, currentLayout, currentWindow));
  const sideTabs = currentWindow.sideTabIds.map((tabId) => buildTab(tabId, currentWorkspace, currentLayout, currentWindow));
  const instances = collectInstances(currentWorkspace);

  return {
    shellTitle: "Bunny Dash",
    subtitle: "Local shell for Bunny Ears fleets and carrots.",
    permissions: Array.from(permissions),
    cloudLabel: "Bunny Cloud",
    cloudStatus: "Developer preview foundation from colab-cloud.",
    commandHint: process.platform === "darwin" ? "cmd+p" : "ctrl+p",
    topActions: [
      { id: "palette", label: "Command Palette" },
      { id: "resume", label: "Resume Last State" },
      { id: "bunny", label: "Pop Out Bunny" },
      { id: "cloud", label: "Bunny Cloud" },
    ],
    currentLayout: {
      id: currentLayout.id,
      name: currentLayout.name,
      description: currentLayout.description,
    },
    currentWorkspace: {
      id: currentWorkspace.id,
      name: currentWorkspace.name,
      subtitle: currentWorkspace.subtitle,
    },
    currentWindow: {
      id: currentWindow.id,
      title: currentWindow.title,
      currentMainTabId: currentWindow.currentMainTabId,
      currentSideTabId: currentWindow.currentSideTabId,
    },
    layouts: buildLayoutSummaries(),
    workspaces: buildWorkspaceSummaries(),
    layoutWindows: buildWindowSummaries(),
    tree: buildTree(),
    mainTabs,
    sideTabs,
    state,
    sessionSummary: {
      updatedAt: sessionSnapshot.updatedAt,
      label: `Last captured ${formatTimestamp(sessionSnapshot.updatedAt)}`,
    },
    stats: [
      { label: "Layout", value: `${runtimeWindows.length} windows` },
      { label: "Workspace", value: `${currentWorkspace.projects.length} projects` },
      { label: "Instances", value: `${instances.length} connected` },
    ],
  };
}

function setCommandQuery(value: string) {
  state.commandQuery = value;
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
  const layout = getLayoutById(layoutId);
  runtimeWindows = cloneWindows(layout.windows);
  state.currentLayoutId = layout.id;
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
  runtimeWindows = cloneWindows(sessionSnapshot.windows);
  state.currentLayoutId = sessionSnapshot.currentLayoutId;
  state.currentWindowId = sessionSnapshot.currentWindowId;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  ensureRuntimeState();
  await saveState();
  syncTray();
  emitSnapshot();
  log("resumed last state");
}

async function updateCurrentLayout() {
  const currentLayout = getCurrentLayout();
  currentLayout.windows = cloneWindows(runtimeWindows);
  await saveState();
  syncTray();
  emitSnapshot();
  log(`updated layout: ${currentLayout.name}`);
}

async function switchWorkspace(workspaceId: string) {
  const workspace = getWorkspaceById(workspaceId);
  const currentWindow = getCurrentWindow();
  currentWindow.workspaceId = workspace.id;
  state.activeTreeNodeId = `workspace-overview:${workspace.id}`;
  await saveState();
  syncTray();
  emitSnapshot();
  log(`workspace switched to ${workspace.name}`);
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
    setMainTab("layout");
  } else if (nodeId.startsWith("workspace-overview:")) {
    setMainTab("workspace");
  } else if (nodeId === "session-overview") {
    setSideTab("session");
  } else if (nodeId.startsWith("window:")) {
    await selectLayoutWindow(nodeId.replace("window:", ""));
    setSideTab("windows");
    return;
  } else if (nodeId.startsWith("project:")) {
    setMainTab("projects");
  } else if (nodeId.startsWith("project-readme:")) {
    setMainTab("workspace");
  } else if (nodeId.startsWith("project-mount:")) {
    setMainTab("projects");
  } else if (nodeId.startsWith("instance:")) {
    setMainTab("instances");
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
          label: layout.id === state.currentLayoutId ? `• ${layout.name}` : layout.name,
          action: `layout:${layout.id}`,
        })),
      },
      {
        type: "normal",
        label: `Switch Workspace (${currentWorkspace.name})`,
        action: "noop-workspace",
        submenu: workspaceCatalog.map((workspace) => ({
          type: "normal",
          label: workspace.id === currentWorkspace.id ? `• ${workspace.name}` : workspace.name,
          action: `workspace:${workspace.id}`,
        })),
      },
      { type: "divider" },
      { type: "normal", label: "Stop Bunny Dash", action: "stop" },
    ],
  });
}

self.onmessage = async (event) => {
  const message = event.data as any;

  if (message.type === "init") {
    permissions = new Set(message.context.permissions || []);
    statePath = message.context.statePath;
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
    switch (message.method) {
      case "getSnapshot": {
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "toggleSidebar": {
        state.sidebarCollapsed = !state.sidebarCollapsed;
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "togglePalette": {
        state.commandPaletteOpen = !state.commandPaletteOpen;
        if (!state.commandPaletteOpen) {
          state.commandQuery = "";
        }
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "setCommandQuery": {
        setCommandQuery(String(message.params?.query || ""));
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "selectNode": {
        await selectNode(String(message.params?.nodeId || ""));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "focusMainTab": {
        setMainTab(String(message.params?.tabId || getCurrentWindow().currentMainTabId) as WindowTabId);
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "focusSideTab": {
        setSideTab(String(message.params?.tabId || getCurrentWindow().currentSideTabId) as WindowTabId);
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "toggleBunnyPopover": {
        state.bunnyPopoverOpen = !state.bunnyPopoverOpen;
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "openCloudPanel": {
        ensureMainTab("cloud");
        ensureSideTab("cloud");
        state.activeTreeNodeId = `layout-overview:${state.currentLayoutId}`;
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "applyLayout": {
        await applyLayout(String(message.params?.layoutId || state.currentLayoutId));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "switchWorkspace": {
        await switchWorkspace(String(message.params?.workspaceId || getCurrentWorkspace().id));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "selectLayoutWindow": {
        await selectLayoutWindow(String(message.params?.windowId || state.currentWindowId));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "resumeLastState": {
        await resumeLastState();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "updateCurrentLayout": {
        await updateCurrentLayout();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      default:
        post({ type: "response", requestId: message.requestId, success: false, error: `Unknown method: ${message.method}` });
        break;
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
