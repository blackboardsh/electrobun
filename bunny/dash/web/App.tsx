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
    id: "marketing-day",
    name: "Marketing Day",
    description: "",
  },
  currentWorkspace: {
    id: "marketing",
    name: "Marketing",
    subtitle: "",
  },
  currentWindow: {
    id: "campaign-planning",
    title: "Campaign Planning",
    currentMainTabId: "projects",
    currentSideTabId: "windows",
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
    currentLayoutId: "marketing-day",
    currentWindowId: "campaign-planning",
    activeTreeNodeId: "project:campaign-site",
  },
};

export function App() {
  const [snapshot, setSnapshot] = createStore<Snapshot>(initialSnapshot);
  const [ready, setReady] = createSignal(false);

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
          onToggleSidebar={() => invoke("toggleSidebar")}
          onOpenPalette={() => invoke("togglePalette")}
          onResumeLastState={() => invoke("resumeLastState")}
          onToggleBunny={() => invoke("toggleBunnyPopover")}
          onOpenCloud={() => invoke("openCloudPanel")}
        />

        <section class="dash-workspace">
          <Show when={!snapshot.state.sidebarCollapsed}>
            <aside class="dash-sidebar">
              <SidebarSection title="Layouts" subtitle="Personal saved window state">
                <button class="sidebar-action-button" onClick={() => invoke("resumeLastState")}>
                  Resume Last State
                </button>
                <button class="sidebar-action-button secondary" onClick={() => invoke("updateCurrentLayout")}>
                  Update Current Layout
                </button>
                <For each={snapshot.layouts}>
                  {(layout) => (
                    <button
                      class={`sidebar-list-item${layout.isActive ? " active" : ""}`}
                      onClick={() => invoke("applyLayout", { layoutId: layout.id })}
                    >
                      <strong>{layout.name}</strong>
                      <span>{layout.windowCount} windows</span>
                    </button>
                  )}
                </For>
              </SidebarSection>

              <SidebarSection title="Workspaces" subtitle="Shared project scope">
                <For each={snapshot.workspaces}>
                  {(workspace) => (
                    <button
                      class={`sidebar-list-item${workspace.isCurrent ? " active" : ""}`}
                      onClick={() => invoke("switchWorkspace", { workspaceId: workspace.id })}
                    >
                      <strong>{workspace.name}</strong>
                      <span>{workspace.projectCount} projects</span>
                    </button>
                  )}
                </For>
              </SidebarSection>

              <SidebarSection title="Explorer" subtitle={snapshot.currentWorkspace.subtitle}>
                <div class="dash-tree-scroll">
                  <Tree
                    nodes={snapshot.tree}
                    activeNodeId={snapshot.state.activeTreeNodeId}
                    onSelect={(nodeId) => invoke("selectNode", { nodeId })}
                  />
                </div>
              </SidebarSection>
            </aside>
          </Show>

          <section class="dash-center">
            <div class="dash-stats-row">
              <For each={snapshot.stats}>
                {(stat) => (
                  <div class="dash-stat-card">
                    <div class="dash-stat-label">{stat.label}</div>
                    <div class="dash-stat-value">{stat.value}</div>
                  </div>
                )}
              </For>
            </div>

            <div class="dash-window-strip">
              <div class="window-strip-meta">
                <span class="window-strip-label">{snapshot.currentLayout.name}</span>
                <span class="window-strip-description">{snapshot.currentLayout.description}</span>
              </div>
              <div class="window-strip-tabs">
                <For each={snapshot.layoutWindows}>
                  {(window) => (
                    <button
                      class={`window-strip-tab${window.isActive ? " active" : ""}`}
                      onClick={() => invoke("selectLayoutWindow", { windowId: window.id })}
                    >
                      <strong>{window.title}</strong>
                      <span>{window.workspaceName}</span>
                    </button>
                  )}
                </For>
              </div>
              <div class="window-strip-actions">
                <button class="window-strip-button" onClick={() => invoke("resumeLastState")}>
                  Resume Last State
                </button>
                <button class="window-strip-button secondary" onClick={() => invoke("updateCurrentLayout")}>
                  Update Layout
                </button>
              </div>
            </div>

            <div class="dash-pane-row">
              <Pane
                title={mainTab()?.title ?? "Bunny Dash"}
                body={mainTab()?.body ?? ""}
                tabs={snapshot.mainTabs}
                activeTabId={snapshot.currentWindow.currentMainTabId}
                onSelect={(tabId) => invoke("focusMainTab", { tabId })}
              />
              <Pane
                title={sideTab()?.title ?? snapshot.cloudLabel}
                body={sideTab()?.body ?? snapshot.cloudStatus}
                tabs={snapshot.sideTabs}
                activeTabId={snapshot.currentWindow.currentSideTabId}
                onSelect={(tabId) => invoke("focusSideTab", { tabId })}
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
                Long term this becomes the privileged local bridge for attaching local surfaces,
                opening remote sessions, and exposing deeper machine integrations than the browser client.
              </p>
            </div>
          </div>
        </Show>
      </main>
    </Show>
  );
}

function TopBar(props: {
  snapshot: Snapshot;
  onToggleSidebar: () => void;
  onOpenPalette: () => void;
  onResumeLastState: () => void;
  onToggleBunny: () => void;
  onOpenCloud: () => void;
}) {
  return (
    <div class="dash-topbar electrobun-webkit-app-region-drag">
      <div class="dash-topbar-left electrobun-webkit-app-region-no-drag">
        <button class="topbar-square" onClick={props.onToggleSidebar} title="Toggle sidebar">
          ≡
        </button>
        <button class="topbar-square wide" onClick={props.onOpenPalette} title="Command palette">
          {props.snapshot.commandHint}
        </button>
      </div>

      <div class="dash-topbar-center">
        <div class="dash-brand">{props.snapshot.shellTitle}</div>
        <div class="dash-subbrand">
          {props.snapshot.currentLayout.name} · {props.snapshot.currentWorkspace.name}
        </div>
      </div>

      <div class="dash-topbar-right electrobun-webkit-app-region-no-drag">
        <button class="topbar-action" onClick={props.onResumeLastState}>
          Resume
        </button>
        <button class="topbar-bunny" onClick={props.onToggleBunny}>
          Pop Out Bunny
        </button>
        <button class="topbar-cloud" onClick={props.onOpenCloud}>
          Bunny Cloud
        </button>
      </div>
    </div>
  );
}

function SidebarSection(props: { title: string; subtitle: string; children: any }) {
  return (
    <section class="sidebar-section">
      <div class="sidebar-section-header">
        <div class="sidebar-section-title">{props.title}</div>
        <div class="sidebar-section-subtitle">{props.subtitle}</div>
      </div>
      <div class="sidebar-section-body">{props.children}</div>
    </section>
  );
}

function StatusBar(props: { snapshot: Snapshot }) {
  return (
    <div class="dash-statusbar electrobun-webkit-app-region-no-drag">
      <div class="status-left">
        <span>{props.snapshot.currentLayout.name}</span>
        <span>|</span>
        <span>{props.snapshot.currentWorkspace.name}</span>
        <span>|</span>
        <span>{props.snapshot.currentWindow.title}</span>
      </div>
      <div class="status-right">
        <span>{props.snapshot.sessionSummary.label}</span>
        <span>|</span>
        <span>{props.snapshot.permissions.length} grants</span>
        <span>|</span>
        <span>Bunny Dash dev preview</span>
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
        {(node) => <TreeNodeView node={node} depth={0} activeNodeId={props.activeNodeId} onSelect={props.onSelect} />}
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
        style={{ "padding-left": `${12 + props.depth * 14}px` }}
        onClick={() => props.onSelect(props.node.id)}
      >
        <span class="dash-tree-icon">{props.node.kind === "folder" ? "▸" : "•"}</span>
        <span>{props.node.label}</span>
      </button>
      <Show when={props.node.children?.length}>
        <For each={props.node.children}>
          {(child) => (
            <TreeNodeView node={child} depth={props.depth + 1} activeNodeId={props.activeNodeId} onSelect={props.onSelect} />
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
}) {
  return (
    <div class="dash-pane">
      <div class="dash-pane-topbar">
        <div class="dash-pane-tab-container">
          <For each={props.tabs}>
            {(tab) => (
              <button class={`dash-pane-tab${tab.id === props.activeTabId ? " active" : ""}`} onClick={() => props.onSelect(tab.id)}>
                <span class="dash-pane-tab-icon">{tab.icon}</span>
                <span class="dash-pane-tab-title">{tab.title}</span>
              </button>
            )}
          </For>
        </div>
        <div class="dash-pane-controls">
          <button class="dash-pane-control">+</button>
          <button class="dash-pane-control">↔</button>
          <button class="dash-pane-control">↕</button>
        </div>
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
