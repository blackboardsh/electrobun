import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { createCarrotClient } from "bunny-ears/view";

type TreeNode = {
  id: string;
  label: string;
  kind: "folder" | "file";
  children?: TreeNode[];
};

type Tab = {
  id: string;
  title: string;
  kind: string;
  icon: string;
  body: string;
};

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
  state: {
    sidebarCollapsed: boolean;
    commandPaletteOpen: boolean;
    bunnyPopoverOpen: boolean;
    commandQuery: string;
    currentLayoutId: string;
    currentWindowId: string;
    activeTreeNodeId: string;
  };
};

type CommandResult = {
  id: string;
  title: string;
  meta: string;
  action: "selectNode" | "applyLayout" | "switchWorkspace" | "selectLayoutWindow" | "resumeLastState";
};

type DialogState =
  | {
      kind: "create-workspace";
      title: string;
      fields: {
        name: string;
        subtitle: string;
      };
    }
  | {
      kind: "add-project";
      title: string;
      fields: {
        name: string;
        path: string;
      };
    }
  | {
      kind: "save-layout";
      title: string;
      fields: {
        name: string;
        description: string;
      };
    };

const client = createCarrotClient();

const initialSnapshot: Snapshot = {
  shellTitle: "Bunny Dash",
  subtitle: "Local shell for Bunny Ears fleets and carrots.",
  permissions: [],
  cloudLabel: "Bunny Cloud",
  cloudStatus: "Developer preview foundation from colab-cloud.",
  commandHint: "cmd+p",
  topActions: [],
  currentLayout: {
    id: "current-session",
    name: "Current Session",
    description: "",
  },
  currentWorkspace: {
    id: "local-workspace",
    name: "Local Workspace",
    subtitle: "",
  },
  currentWindow: {
    id: "main",
    title: "Main",
    currentMainTabId: "workspace",
    currentSideTabId: "session",
  },
  layouts: [],
  workspaces: [],
  layoutWindows: [],
  sessionSummary: {
    updatedAt: Date.now(),
    label: "",
  },
  tree: [],
  mainTabs: [],
  sideTabs: [],
  stats: [],
  state: {
    sidebarCollapsed: false,
    commandPaletteOpen: false,
    bunnyPopoverOpen: false,
    commandQuery: "",
    currentLayoutId: "current-session",
    currentWindowId: "main",
    activeTreeNodeId: "workspace-overview:local-workspace",
  },
};

const QUICK_ACCESS = [
  {
    id: "browser" as const,
    label: "Web Browser",
    icon: "views://assets/file-icons/webkit-logo.svg",
  },
  {
    id: "terminal" as const,
    label: "Terminal",
    icon: "views://assets/file-icons/terminal.svg",
  },
  {
    id: "agent" as const,
    label: "AI Chat",
    icon: "views://assets/file-icons/agent.svg",
  },
];

export function App() {
  const [snapshot, setSnapshot] = createStore<Snapshot>(initialSnapshot);
  const [ready, setReady] = createSignal(false);
  const [dialog, setDialog] = createSignal<DialogState | null>(null);
  const [sidebarQuery, setSidebarQuery] = createSignal("");
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = createSignal(false);

  const mainTab = createMemo(() => {
    return (
      snapshot.mainTabs.find((tab) => tab.id === snapshot.currentWindow.currentMainTabId) ??
      snapshot.mainTabs[0]
    );
  });

  const sideTab = createMemo(() => {
    return (
      snapshot.sideTabs.find((tab) => tab.id === snapshot.currentWindow.currentSideTabId) ??
      snapshot.sideTabs[0]
    );
  });

  const workspaceTree = createMemo(() => {
    const workspaceNode = snapshot.tree.find(
      (node) => node.id === `workspace:${snapshot.currentWorkspace.id}`,
    );
    return filterTreeNodes(workspaceNode?.children ?? [], sidebarQuery().trim().toLowerCase());
  });

  const openFileNodes = createMemo(() => {
    return flattenTree(workspaceTree()).filter((node) => node.id.startsWith("fsfile:"));
  });

  const commandResults = createMemo<CommandResult[]>(() => {
    const query = snapshot.state.commandQuery.trim().toLowerCase();
    const candidates: CommandResult[] = [
      ...snapshot.layouts.map((layout) => ({
        id: layout.id,
        title: layout.name,
        meta: `layout · ${layout.windowCount} windows`,
        action: "applyLayout" as const,
      })),
      ...snapshot.workspaces.map((workspace) => ({
        id: workspace.id,
        title: workspace.name,
        meta: `workspace · ${workspace.projectCount} projects`,
        action: "switchWorkspace" as const,
      })),
      ...snapshot.layoutWindows.map((window) => ({
        id: window.id,
        title: window.title,
        meta: `window · ${window.workspaceName}`,
        action: "selectLayoutWindow" as const,
      })),
      ...snapshot.mainTabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        meta: `tab · ${tab.kind}`,
        action: "selectNode" as const,
      })),
      ...flattenTree(snapshot.tree).map((node) => ({
        id: node.id,
        title: node.label,
        meta: `tree · ${node.kind}`,
        action: "selectNode" as const,
      })),
      {
        id: "resume-last-state",
        title: "Resume Last State",
        meta: snapshot.sessionSummary.label,
        action: "resumeLastState",
      },
    ];

    if (!query) {
      return candidates.slice(0, 12);
    }

    return candidates
      .filter((item) => `${item.title} ${item.meta}`.toLowerCase().includes(query))
      .slice(0, 12);
  });

  async function refresh() {
    const next = await client.invoke<Snapshot>("getSnapshot").catch(() => null);
    if (next) {
      setSnapshot(next);
      setReady(true);
    }
  }

  async function invoke(method: string, params?: unknown) {
    await client.invoke(method, params);
  }

  async function handleCommandResult(result: CommandResult) {
    switch (result.action) {
      case "applyLayout":
        await invoke("applyLayout", { layoutId: result.id });
        break;
      case "switchWorkspace":
        await invoke("switchWorkspace", { workspaceId: result.id });
        break;
      case "selectLayoutWindow":
        await invoke("selectLayoutWindow", { windowId: result.id });
        break;
      case "resumeLastState":
        await invoke("resumeLastState");
        break;
      case "selectNode":
      default:
        await invoke("selectNode", { nodeId: result.id });
        break;
    }

    if (snapshot.state.commandPaletteOpen) {
      await invoke("togglePalette");
    }
  }

  function handleCreateWorkspace() {
    setDialog({
      kind: "create-workspace",
      title: "Create Workspace",
      fields: {
        name: "",
        subtitle: "Shared project scope for Bunny Dash.",
      },
    });
    setWorkspaceMenuOpen(false);
  }

  function handleAddProjectFolder() {
    setDialog({
      kind: "add-project",
      title: `Add Project Folder to ${snapshot.currentWorkspace.name}`,
      fields: {
        name: "",
        path: "",
      },
    });
  }

  function handleSaveLayout() {
    setDialog({
      kind: "save-layout",
      title: "Save Layout",
      fields: {
        name: `${snapshot.currentWorkspace.name} Layout`,
        description: "Saved from the current Bunny Dash session.",
      },
    });
    setWorkspaceMenuOpen(false);
  }

  function closeDialog() {
    setDialog(null);
  }

  async function submitDialog() {
    const currentDialog = dialog();
    if (!currentDialog) return;

    if (currentDialog.kind === "create-workspace") {
      if (!currentDialog.fields.name.trim()) return;
      await invoke("createWorkspace", {
        name: currentDialog.fields.name.trim(),
        subtitle: currentDialog.fields.subtitle.trim(),
      });
    } else if (currentDialog.kind === "add-project") {
      const path = currentDialog.fields.path.trim();
      const name = currentDialog.fields.name.trim();
      if (!path || !name) return;
      await invoke("addProjectMount", {
        workspaceId: snapshot.currentWorkspace.id,
        name,
        path,
      });
    } else if (currentDialog.kind === "save-layout") {
      if (!currentDialog.fields.name.trim()) return;
      await invoke("saveLayout", {
        name: currentDialog.fields.name.trim(),
        description: currentDialog.fields.description.trim(),
      });
    }

    closeDialog();
  }

  function updateDialogField(field: string, value: string) {
    const currentDialog = dialog();
    if (!currentDialog) return;
    setDialog({
      ...currentDialog,
      fields: {
        ...currentDialog.fields,
        [field]: value,
      },
    } as DialogState);
  }

  async function handleKeyDown(event: KeyboardEvent) {
    const commandPressed = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p";
    if (commandPressed) {
      event.preventDefault();
      await invoke("togglePalette");
      return;
    }

    if (event.key === "Escape") {
      if (snapshot.state.commandPaletteOpen) {
        event.preventDefault();
        await invoke("togglePalette");
        return;
      }

      if (snapshot.state.bunnyPopoverOpen) {
        event.preventDefault();
        await invoke("toggleBunnyPopover");
      }

      setWorkspaceMenuOpen(false);
    }
  }

  onMount(() => {
    client.on("boot", async () => {
      await refresh();
    });

    client.on("snapshot", (payload) => {
      setSnapshot(payload as Snapshot);
      setReady(true);
    });

    void refresh();
    document.addEventListener("keydown", handleKeyDown);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <Show when={ready()} fallback={<div class="app-loading">Launching Bunny Dash…</div>}>
      <main class="dash-root">
        <TopBar
          snapshot={snapshot}
          workspaceMenuOpen={workspaceMenuOpen()}
          onToggleSidebar={() => void invoke("toggleSidebar")}
          onOpenPalette={() => void invoke("togglePalette")}
          onToggleWorkspaceMenu={() => setWorkspaceMenuOpen((value) => !value)}
          onToggleBunny={() => void invoke("toggleBunnyPopover")}
          onOpenCloud={() => void invoke("openCloudPanel")}
        />

        <section class="dash-shell electrobun-webkit-app-region-no-drag">
          <Show when={!snapshot.state.sidebarCollapsed}>
            <aside class="dash-sidebar electrobun-webkit-app-region-no-drag">
              <div class="dash-findall-row">
                <input
                  class="dash-findall-input"
                  placeholder="Find All"
                  value={sidebarQuery()}
                  onInput={(event) => setSidebarQuery(event.currentTarget.value)}
                />
                <button class="dash-findall-toggle" onClick={() => void invoke("togglePalette")}>
                  <img src="views://assets/file-icons/browser-script.svg" alt="Search" />
                </button>
              </div>

              <SidebarCategory title="Quick Access">
                <For each={QUICK_ACCESS}>
                  {(item) => (
                    <button
                      class="dash-quick-access"
                      onClick={() => void invoke("openQuickAccess", { tabId: item.id })}
                    >
                      <img src={item.icon} alt="" />
                      <span>{item.label}</span>
                    </button>
                  )}
                </For>
              </SidebarCategory>

              <Show when={openFileNodes().length > 0}>
                <SidebarCategory title="Open Files">
                  <For each={openFileNodes().slice(0, 12)}>
                    {(node) => (
                      <button
                        class={`dash-open-file${node.id === snapshot.state.activeTreeNodeId ? " active" : ""}`}
                        onClick={() => void invoke("selectNode", { nodeId: node.id })}
                      >
                        <img src={iconForNode(node)} alt="" />
                        <span>{node.label}</span>
                      </button>
                    )}
                  </For>
                </SidebarCategory>
              </Show>

              <SidebarCategory
                title="Projects"
                actionLabel="+"
                onAction={handleAddProjectFolder}
              >
                <Show
                  when={workspaceTree().length > 0}
                  fallback={<div class="dash-sidebar-empty">No project folders yet.</div>}
                >
                  <Tree
                    nodes={workspaceTree()}
                    activeNodeId={snapshot.state.activeTreeNodeId}
                    onSelect={(nodeId) => void invoke("selectNode", { nodeId })}
                  />
                </Show>
              </SidebarCategory>
            </aside>
          </Show>

          <section class="dash-workbench electrobun-webkit-app-region-no-drag">
            <Show when={workspaceMenuOpen()}>
              <div class="dash-workspace-menu electrobun-webkit-app-region-no-drag">
                <button class="dash-menu-item" onClick={handleCreateWorkspace}>New Workspace</button>
                <button class="dash-menu-item" onClick={handleSaveLayout}>Save Layout</button>
                <button class="dash-menu-item" onClick={() => void invoke("resumeLastState")}>Resume Last State</button>
                <div class="dash-menu-divider" />
                <For each={snapshot.workspaces}>
                  {(workspace) => (
                    <button
                      class={`dash-menu-item${workspace.isCurrent ? " active" : ""}`}
                      onClick={() => {
                        void invoke("switchWorkspace", { workspaceId: workspace.id });
                        setWorkspaceMenuOpen(false);
                      }}
                    >
                      {workspace.name}
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <div class="dash-window-bar electrobun-webkit-app-region-no-drag">
              <For each={snapshot.layoutWindows}>
                {(window) => (
                  <button
                    class={`dash-window-chip${window.isActive ? " active" : ""}`}
                    onClick={() => void invoke("selectLayoutWindow", { windowId: window.id })}
                  >
                    {window.title}
                  </button>
                )}
              </For>
            </div>

            <div class="dash-pane-row electrobun-webkit-app-region-no-drag">
              <Pane
                title={mainTab()?.title ?? "Workspace"}
                body={mainTab()?.body ?? ""}
                tabs={snapshot.mainTabs}
                activeTabId={snapshot.currentWindow.currentMainTabId}
                onSelect={(tabId) => void invoke("focusMainTab", { tabId })}
              />
              <Pane
                title={sideTab()?.title ?? "Session"}
                body={sideTab()?.body ?? ""}
                tabs={snapshot.sideTabs}
                activeTabId={snapshot.currentWindow.currentSideTabId}
                onSelect={(tabId) => void invoke("focusSideTab", { tabId })}
                compact
              />
            </div>
          </section>
        </section>

        <StatusBar snapshot={snapshot} />

        <Show when={snapshot.state.commandPaletteOpen}>
          <div
            class="command-overlay electrobun-webkit-app-region-no-drag"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                void invoke("togglePalette");
              }
            }}
          >
            <div class="command-panel">
              <input
                class="command-input"
                value={snapshot.state.commandQuery}
                onInput={(event) => void invoke("setCommandQuery", { query: event.currentTarget.value })}
                placeholder="Layout, workspace, tab, window, or project"
              />
              <div class="command-results">
                <For each={commandResults()}>
                  {(result) => (
                    <button class="command-result" onClick={() => void handleCommandResult(result)}>
                      <span>{result.title}</span>
                      <small>{result.meta}</small>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Show>

        <Show when={snapshot.state.bunnyPopoverOpen}>
          <div
            class="bunny-popover electrobun-webkit-app-region-no-drag"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                void invoke("toggleBunnyPopover");
              }
            }}
          >
            <div class="bunny-popover-card">
              <div class="bunny-popover-title">Pop Out Bunny</div>
              <p>
                This becomes the privileged local bridge for local surfaces, remote sessions,
                and deeper Bunny Dash integrations than the browser client.
              </p>
            </div>
          </div>
        </Show>

        <Show when={dialog()}>
          {(currentDialog) => (
            <div
              class="dash-dialog-overlay electrobun-webkit-app-region-no-drag"
              onClick={(event) => {
                if (event.target === event.currentTarget) {
                  closeDialog();
                }
              }}
            >
              <div class="dash-dialog-card">
                <div class="dash-dialog-title">{currentDialog().title}</div>
                <div class="dash-dialog-body">
                  <Show when={currentDialog().kind === "create-workspace"}>
                    <div class="dash-form-grid">
                      <label class="dash-form-field">
                        <span>Name</span>
                        <input
                          value={currentDialog().fields.name}
                          onInput={(event) => updateDialogField("name", event.currentTarget.value)}
                          placeholder="Workspace name"
                        />
                      </label>
                      <label class="dash-form-field">
                        <span>Subtitle</span>
                        <input
                          value={currentDialog().fields.subtitle}
                          onInput={(event) => updateDialogField("subtitle", event.currentTarget.value)}
                          placeholder="Shared project scope"
                        />
                      </label>
                    </div>
                  </Show>
                  <Show when={currentDialog().kind === "add-project"}>
                    <div class="dash-form-grid">
                      <label class="dash-form-field">
                        <span>Project name</span>
                        <input
                          value={currentDialog().fields.name}
                          onInput={(event) => updateDialogField("name", event.currentTarget.value)}
                          placeholder="project-name"
                        />
                      </label>
                      <label class="dash-form-field">
                        <span>Folder path</span>
                        <input
                          value={currentDialog().fields.path}
                          onInput={(event) => updateDialogField("path", event.currentTarget.value)}
                          placeholder="/path/to/project"
                        />
                      </label>
                    </div>
                  </Show>
                  <Show when={currentDialog().kind === "save-layout"}>
                    <div class="dash-form-grid">
                      <label class="dash-form-field">
                        <span>Name</span>
                        <input
                          value={currentDialog().fields.name}
                          onInput={(event) => updateDialogField("name", event.currentTarget.value)}
                          placeholder="Layout name"
                        />
                      </label>
                      <label class="dash-form-field">
                        <span>Description</span>
                        <input
                          value={currentDialog().fields.description}
                          onInput={(event) => updateDialogField("description", event.currentTarget.value)}
                          placeholder="Saved layout description"
                        />
                      </label>
                    </div>
                  </Show>
                </div>
                <div class="dash-dialog-actions">
                  <button class="dash-dialog-button secondary" onClick={closeDialog}>
                    Cancel
                  </button>
                  <button class="dash-dialog-button" onClick={() => void submitDialog()}>
                    Save
                  </button>
                </div>
              </div>
            </div>
          )}
        </Show>
      </main>
    </Show>
  );
}

function TopBar(props: {
  snapshot: Snapshot;
  workspaceMenuOpen: boolean;
  onToggleSidebar: () => void;
  onOpenPalette: () => void;
  onToggleWorkspaceMenu: () => void;
  onToggleBunny: () => void;
  onOpenCloud: () => void;
}) {
  return (
    <div class="dash-topbar electrobun-webkit-app-region-drag">
      <div class="dash-topbar-left electrobun-webkit-app-region-no-drag">
        <button class="dash-sidebar-toggle" onClick={props.onToggleSidebar}>
          <img
            src={`views://assets/file-icons/sidebar-left${
              props.snapshot.state.sidebarCollapsed ? "" : "-filled"
            }.svg`}
            alt="Toggle sidebar"
          />
        </button>
        <button class="dash-workspace-button" onClick={props.onToggleWorkspaceMenu}>
          {props.snapshot.currentWorkspace.name}
        </button>
      </div>

      <div class="dash-topbar-spacer" />

      <div class="dash-topbar-right electrobun-webkit-app-region-no-drag">
        <button class="dash-command-pill" onClick={props.onOpenPalette}>
          {props.snapshot.commandHint}
        </button>
        <button class="dash-cloud-button" onClick={props.onOpenCloud}>
          <span>Bunny Cloud</span>
        </button>
        <div class="dash-bunny-shell">
          <button class="dash-bunny-button" onClick={props.onToggleBunny}>
            <img src="views://assets/bunny.png" alt="Pop Out Bunny" />
          </button>
        </div>
        <div class="dash-app-badge">
          <img src="views://assets/icon_32x32@2x.png" alt="Bunny Dash" />
          <span>bunny dash</span>
        </div>
      </div>
    </div>
  );
}

function SidebarCategory(props: {
  title: string;
  children: any;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section class="dash-sidebar-category">
      <div class="dash-sidebar-category-header">
        <div class="dash-sidebar-category-title">{props.title}</div>
        <Show when={props.actionLabel && props.onAction}>
          <button class="dash-sidebar-category-action" onClick={props.onAction}>
            {props.actionLabel}
          </button>
        </Show>
      </div>
      <div class="dash-sidebar-category-body">{props.children}</div>
    </section>
  );
}

function StatusBar(props: { snapshot: Snapshot }) {
  const totalTabs = () => props.snapshot.mainTabs.length + props.snapshot.sideTabs.length;

  return (
    <div class="dash-statusbar electrobun-webkit-app-region-no-drag">
      <div class="dash-status-left">
        <span>win: {props.snapshot.layoutWindows.length}</span>
        <span>|</span>
        <span>tabs: {totalTabs()}</span>
      </div>
      <div class="dash-status-right">
        <span>{props.snapshot.sessionSummary.label}</span>
        <span>|</span>
        <span>{props.snapshot.permissions.length} grants</span>
        <span>|</span>
        <span>GoldfishDB</span>
      </div>
    </div>
  );
}

function Tree(props: {
  nodes: TreeNode[];
  activeNodeId: string;
  onSelect: (nodeId: string) => void;
}) {
  return (
    <div class="dash-tree">
      <For each={props.nodes}>
        {(node) => (
          <TreeNodeView
            node={node}
            depth={0}
            activeNodeId={props.activeNodeId}
            onSelect={props.onSelect}
          />
        )}
      </For>
    </div>
  );
}

function TreeNodeView(props: {
  node: TreeNode;
  depth: number;
  activeNodeId: string;
  onSelect: (nodeId: string) => void;
}) {
  return (
    <div>
      <button
        class={`dash-tree-row${props.node.id === props.activeNodeId ? " active" : ""}`}
        style={{ "padding-left": `${16 + props.depth * 14}px` }}
        onClick={() => props.onSelect(props.node.id)}
      >
        <img class="dash-tree-icon" src={iconForNode(props.node)} alt="" />
        <span class="dash-tree-label">{props.node.label}</span>
      </button>
      <Show when={props.node.children?.length}>
        <For each={props.node.children}>
          {(child) => (
            <TreeNodeView
              node={child}
              depth={props.depth + 1}
              activeNodeId={props.activeNodeId}
              onSelect={props.onSelect}
            />
          )}
        </For>
      </Show>
    </div>
  );
}

function Pane(props: {
  title: string;
  body: string;
  tabs: Tab[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
  compact?: boolean;
}) {
  return (
    <div class={`dash-pane${props.compact ? " compact" : ""} electrobun-webkit-app-region-no-drag`}>
      <div class="dash-pane-tabbar electrobun-webkit-app-region-no-drag">
        <For each={props.tabs}>
          {(tab) => (
            <button
              class={`dash-pane-tab${tab.id === props.activeTabId ? " active" : ""}`}
              onClick={() => props.onSelect(tab.id)}
            >
              <span class="dash-pane-tab-icon">{tab.icon}</span>
              <span class="dash-pane-tab-title">{tab.title}</span>
            </button>
          )}
        </For>
      </div>
      <div class="dash-pane-body">
        <div class="dash-pane-title">{props.title}</div>
        <pre>{props.body}</pre>
      </div>
    </div>
  );
}

function flattenTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...(node.children ? flattenTree(node.children) : [])]);
}

function filterTreeNodes(nodes: TreeNode[], query: string): TreeNode[] {
  if (!query) {
    return nodes;
  }

  const filtered: TreeNode[] = [];
  for (const node of nodes) {
    const childMatches = filterTreeNodes(node.children ?? [], query);
    if (node.label.toLowerCase().includes(query) || childMatches.length > 0) {
      filtered.push({
        ...node,
        children: childMatches,
      });
    }
  }
  return filtered;
}

function iconForNode(node: TreeNode) {
  if (node.kind === "folder") {
    return "views://assets/file-icons/folder.svg";
  }

  const lower = node.label.toLowerCase();
  if (lower.endsWith(".tsx") || lower.endsWith(".ts")) {
    return "views://assets/file-icons/tsx.svg";
  }
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) {
    return "views://assets/file-icons/js.svg";
  }
  if (lower.endsWith(".css")) {
    return "views://assets/file-icons/css.svg";
  }
  if (lower.endsWith(".json")) {
    return "views://assets/file-icons/json.svg";
  }
  if (lower.endsWith(".md")) {
    return "views://assets/file-icons/markdown.svg";
  }
  return "views://assets/file-icons/txt.svg";
}
