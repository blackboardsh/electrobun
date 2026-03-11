import { existsSync } from "node:fs";

type TreeNode = {
  id: string;
  label: string;
  kind: "folder" | "file";
  children?: TreeNode[];
};

type Tab = {
  id: string;
  title: string;
  kind: "editor" | "fleet" | "cloud" | "notes";
  icon: string;
  body: string;
};

type DashState = {
  sidebarCollapsed: boolean;
  commandPaletteOpen: boolean;
  bunnyPopoverOpen: boolean;
  activeTreeNodeId: string;
  activeMainTabId: string;
  activeSideTabId: string;
  commandQuery: string;
};

const defaultTree: TreeNode[] = [
  {
    id: "workspace",
    label: "workspace",
    kind: "folder",
    children: [
      { id: "roadmap", label: "roadmap.md", kind: "file" },
      { id: "instances", label: "instances.json", kind: "file" },
      { id: "cloud", label: "bunny-cloud.ts", kind: "file" },
      { id: "shell", label: "bunny-dash.ts", kind: "file" },
    ],
  },
  {
    id: "fleet",
    label: "fleet",
    kind: "folder",
    children: [
      {
        id: "host-machine",
        label: "host-machine",
        kind: "folder",
        children: [
          { id: "dash-local", label: "bunny-dash.carrot", kind: "file" },
          { id: "git-local", label: "git.carrot", kind: "file" },
          { id: "codex-local", label: "colab-pty.carrot", kind: "file" }
        ]
      },
      {
        id: "vm-local",
        label: "local-vm-01",
        kind: "folder",
        children: [
          { id: "browser-remote", label: "browser-session.carrot", kind: "file" },
          { id: "tts-remote", label: "audio-tts.carrot", kind: "file" }
        ]
      }
    ]
  }
];

const defaultMainTabs: Tab[] = [
  {
    id: "shell",
    title: "bunny-dash.ts",
    kind: "editor",
    icon: "TS",
    body: `export const bunnyDash = {
  shell: "web-first",
  surfaces: ["local", "remote"],
  fleet: ["host", "local-vm-01", "cloud-vm-01"],
  commandPalette: "cmd+p",
  cloud: "bunny cloud"
};`,
  },
  {
    id: "roadmap",
    title: "roadmap.md",
    kind: "editor",
    icon: "MD",
    body: `# Bunny Dash

- local install into Bunny Ears
- remote fleet control
- streamed browser surfaces
- agent and tool routing without ssh
- carrot-aware workspace shell`,
  },
  {
    id: "instances",
    title: "instances.json",
    kind: "fleet",
    icon: "{}",
    body: `{
  "instances": [
    { "name": "host-machine", "status": "online", "carrots": 8 },
    { "name": "local-vm-01", "status": "online", "carrots": 4 },
    { "name": "cloud-vm-01", "status": "headless", "carrots": 3 }
  ]
}`,
  },
  {
    id: "cloud",
    title: "bunny-cloud.ts",
    kind: "cloud",
    icon: "CL",
    body: `export const bunnyCloud = {
  auth: true,
  relay: "planned",
  fleet: "planned",
  browserDash: true,
  settingsSync: "colab-cloud reference"
};`,
  },
];

const defaultSideTabs: Tab[] = [
  {
    id: "fleet-side",
    title: "Fleet",
    kind: "fleet",
    icon: "FT",
    body: `host-machine\n- bunny-dash\n- git\n- colab-pty\n\nlocal-vm-01\n- browser-session\n- audio-tts`,
  },
  {
    id: "cloud-side",
    title: "Bunny Cloud",
    kind: "cloud",
    icon: "BC",
    body: `Status: developer preview foundation\nSource: colab-cloud\nNext: auth, relay, fleet orchestration, hosted Bunny Dash`,
  },
  {
    id: "notes-side",
    title: "Notes",
    kind: "notes",
    icon: "NT",
    body: `Bunny Dash is the daily shell.\nBunny Ears stays minimal and recoverable.\nCarrots run the workloads on the ground.`,
  },
];

let statePath = "";
let permissions = new Set<string>();
let state: DashState = {
  sidebarCollapsed: false,
  commandPaletteOpen: false,
  bunnyPopoverOpen: false,
  activeTreeNodeId: "shell",
  activeMainTabId: "shell",
  activeSideTabId: "fleet-side",
  commandQuery: "",
};

function post(message: unknown) {
  self.postMessage(message);
}

function log(message: string) {
  post({ type: "action", action: "log", payload: { message } });
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

async function saveState() {
  if (!canPersist()) return;
  await Bun.write(statePath, JSON.stringify(state, null, 2));
}

async function loadState() {
  if (!canPersist() || !existsSync(statePath)) return;
  try {
    const loaded = await Bun.file(statePath).json();
    state = {
      ...state,
      ...loaded,
    };
  } catch (error) {
    log(`dash state load failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function snapshot() {
  return {
    shellTitle: "Bunny Dash",
    subtitle: "Local shell for Bunny Ears fleets and carrots.",
    permissions: Array.from(permissions),
    cloudLabel: "Bunny Cloud",
    cloudStatus: "Developer preview foundation from colab-cloud.",
    commandHint: process.platform === "darwin" ? "cmd+p" : "ctrl+p",
    topActions: [
      { id: "palette", label: "Command Palette" },
      { id: "bunny", label: "Pop Out Bunny" },
      { id: "cloud", label: "Bunny Cloud" },
    ],
    tree: defaultTree,
    mainTabs: defaultMainTabs,
    sideTabs: defaultSideTabs,
    state,
    stats: [
      { label: "Instances", value: "3 online" },
      { label: "Carrots", value: "15 installed" },
      { label: "Relay", value: "colab-cloud reference" },
    ],
  };
}

function selectNode(nodeId: string) {
  state.activeTreeNodeId = nodeId;
  if (defaultMainTabs.some((tab) => tab.id === nodeId)) {
    state.activeMainTabId = nodeId;
  }
}

function setCommandQuery(value: string) {
  state.commandQuery = value;
}

self.onmessage = async (event) => {
  const message = event.data;

  if (message.type === "init") {
    permissions = new Set(message.context.permissions || []);
    statePath = message.context.statePath;
    await loadState();
    post({ type: "ready" });
    emitSnapshot();
    log("bunny dash worker initialized");
    return;
  }

  if (message.type === "event") {
    if (message.name === "boot") {
      emitSnapshot();
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
        selectNode(String(message.params?.nodeId || "shell"));
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "focusMainTab": {
        state.activeMainTabId = String(message.params?.tabId || state.activeMainTabId);
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "focusSideTab": {
        state.activeSideTabId = String(message.params?.tabId || state.activeSideTabId);
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
        state.activeMainTabId = "cloud";
        state.activeSideTabId = "cloud-side";
        state.activeTreeNodeId = "cloud";
        await saveState();
        emitSnapshot();
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
