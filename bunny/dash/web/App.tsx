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
  tree: TreeNode[];
  mainTabs: Tab[];
  sideTabs: Tab[];
  stats: Array<{ label: string; value: string }>;
  state: {
    sidebarCollapsed: boolean;
    commandPaletteOpen: boolean;
    bunnyPopoverOpen: boolean;
    activeTreeNodeId: string;
    activeMainTabId: string;
    activeSideTabId: string;
    commandQuery: string;
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
  tree: [],
  mainTabs: [],
  sideTabs: [],
  stats: [],
  state: {
    sidebarCollapsed: false,
    commandPaletteOpen: false,
    bunnyPopoverOpen: false,
    activeTreeNodeId: "shell",
    activeMainTabId: "shell",
    activeSideTabId: "fleet-side",
    commandQuery: "",
  },
};

export function App() {
  const [snapshot, setSnapshot] = createStore<Snapshot>(initialSnapshot);
  const [ready, setReady] = createSignal(false);

  const mainTab = createMemo(() => {
    return snapshot.mainTabs.find((tab) => tab.id === snapshot.state.activeMainTabId) ?? snapshot.mainTabs[0];
  });
  const sideTab = createMemo(() => {
    return snapshot.sideTabs.find((tab) => tab.id === snapshot.state.activeSideTabId) ?? snapshot.sideTabs[0];
  });
  const commandResults = createMemo(() => {
    const query = snapshot.state.commandQuery.trim().toLowerCase();
    const candidates = [
      ...snapshot.mainTabs.map((tab) => ({ id: tab.id, title: tab.title, meta: tab.kind })),
      ...flattenTree(snapshot.tree).map((node) => ({ id: node.id, title: node.label, meta: node.kind })),
    ];

    if (!query) {
      return candidates.slice(0, 10);
    }

    return candidates
      .filter((item) => `${item.title} ${item.meta}`.toLowerCase().includes(query))
      .slice(0, 10);
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
          onToggleBunny={() => invoke("toggleBunnyPopover")}
          onOpenCloud={() => invoke("openCloudPanel")}
        />

        <section class="dash-workspace">
          <Show when={!snapshot.state.sidebarCollapsed}>
            <aside class="dash-sidebar">
              <div class="dash-sidebar-header">
                <div>
                  <div class="dash-sidebar-title">Explorer</div>
                  <div class="dash-sidebar-subtitle">Bunny Dash local workspace</div>
                </div>
              </div>
              <div class="dash-tree-scroll">
                <Tree nodes={snapshot.tree} activeNodeId={snapshot.state.activeTreeNodeId} onSelect={(nodeId) => invoke("selectNode", { nodeId })} />
              </div>
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

            <div class="dash-pane-row">
              <Pane
                title={mainTab()?.title ?? "Bunny Dash"}
                body={mainTab()?.body ?? ""}
                paneId="main"
                tabs={snapshot.mainTabs}
                activeTabId={snapshot.state.activeMainTabId}
                onSelect={(tabId) => invoke("focusMainTab", { tabId })}
              />
              <Pane
                title={sideTab()?.title ?? snapshot.cloudLabel}
                body={sideTab()?.body ?? snapshot.cloudStatus}
                paneId="side"
                tabs={snapshot.sideTabs}
                activeTabId={snapshot.state.activeSideTabId}
                onSelect={(tabId) => invoke("focusSideTab", { tabId })}
              />
            </div>
          </section>
        </section>

        <StatusBar snapshot={snapshot} />

        <Show when={snapshot.state.commandPaletteOpen}>
          <div class="command-overlay electrobun-webkit-app-region-no-drag" onClick={(event) => {
            if (event.target === event.currentTarget) {
              void invoke("togglePalette");
            }
          }}>
            <div class="command-panel">
              <input
                class="command-input"
                value={snapshot.state.commandQuery}
                onInput={(event) => void invoke("setCommandQuery", { query: event.currentTarget.value })}
                placeholder="Jump to file, tab, or instance"
              />
              <div class="command-results">
                <For each={commandResults()}>
                  {(result) => (
                    <button
                      class="command-result"
                      onClick={async () => {
                        await invoke("selectNode", { nodeId: result.id });
                        await invoke("togglePalette");
                      }}
                    >
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
          <div class="bunny-popover electrobun-webkit-app-region-no-drag" onClick={(event) => {
            if (event.target === event.currentTarget) {
              void invoke("toggleBunnyPopover");
            }
          }}>
            <div class="bunny-popover-card">
              <div class="bunny-popover-title">Pop Out Bunny</div>
              <p>
                Privileged local Bunny Dash mode will eventually attach local surfaces,
                open remote sessions, and expose deeper machine integrations than the browser client.
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
  onToggleBunny: () => void;
  onOpenCloud: () => void;
}) {
  return (
    <div class="dash-topbar electrobun-webkit-app-region-drag">
      <div class="dash-topbar-left electrobun-webkit-app-region-no-drag">
        <button class="topbar-square" onClick={props.onToggleSidebar} title="Toggle sidebar">
          ≡
        </button>
        <button class="topbar-square" onClick={props.onOpenPalette} title="Command palette">
          {props.snapshot.commandHint}
        </button>
      </div>

      <div class="dash-topbar-center">
        <div class="dash-brand">{props.snapshot.shellTitle}</div>
        <div class="dash-subbrand">{props.snapshot.subtitle}</div>
      </div>

      <div class="dash-topbar-right electrobun-webkit-app-region-no-drag">
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

function StatusBar(props: { snapshot: Snapshot }) {
  return (
    <div class="dash-statusbar electrobun-webkit-app-region-no-drag">
      <div class="status-left">
        <span>win: 1</span>
        <span>|</span>
        <span>tabs: {props.snapshot.mainTabs.length + props.snapshot.sideTabs.length}</span>
      </div>
      <div class="status-right">
        <span>Bunny Cloud: online</span>
        <span>|</span>
        <span>Bun worker permissions: {props.snapshot.permissions.length}</span>
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
        {(node) => (
          <TreeNodeView node={node} depth={0} activeNodeId={props.activeNodeId} onSelect={props.onSelect} />
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
        style={{ "padding-left": `${12 + props.depth * 14}px` }}
        onClick={() => props.onSelect(props.node.id)}
      >
        <span class="dash-tree-icon">{props.node.kind === "folder" ? "▸" : "•"}</span>
        <span>{props.node.label}</span>
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
  paneId: string;
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
