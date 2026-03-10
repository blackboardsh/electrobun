import Electrobun, { Electroview } from "electrobun/view";

type CarrotInfo = {
  id: string;
  name: string;
  description: string;
  version: string;
  mode: "window" | "background";
  permissions: string[];
  status: "stopped" | "starting" | "running";
  installStatus: "installed" | "broken";
  devMode: boolean;
  sourcePath: string | null;
  lastBuildError: string | null;
  logTail: string[];
};

type DashboardState = {
  installRoot: string;
  carrots: CarrotInfo[];
};

type DashboardRPC = {
  bun: {
    requests: {
      getDashboard: {
        params: {};
        response: DashboardState;
      };
      installCarrotFromDisk: {
        params: {};
        response: { ok: boolean; id?: string; error?: string; reason?: string };
      };
      rebuildCarrot: {
        params: { id: string };
        response: { ok: boolean; error?: string };
      };
      launchCarrot: {
        params: { id: string };
        response: { ok: boolean };
      };
      stopCarrot: {
        params: { id: string };
        response: { ok: boolean };
      };
      openCarrot: {
        params: { id: string };
        response: { ok: boolean };
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      dashboardChanged: DashboardState;
    };
  };
};

const grid = document.getElementById("carrot-grid") as HTMLDivElement;
const carrotCount = document.getElementById("carrot-count") as HTMLElement;
const installRoot = document.getElementById("install-root") as HTMLElement;
const installButton = document.getElementById("install-carrot") as HTMLButtonElement;

const rpc = Electroview.defineRPC<DashboardRPC>({
  maxRequestTime: 10000,
  handlers: {
    requests: {},
    messages: { dashboardChanged: (state) => render(state) },
  },
});

const electroview = new Electrobun.Electroview({ rpc });

installButton.addEventListener("click", async () => {
  await electroview.rpc!.request.installCarrotFromDisk({});
});

void bootstrap();

async function bootstrap() {
  const state = await electroview.rpc!.request.getDashboard({});
  render(state);
}

function render(state: DashboardState) {
  carrotCount.textContent = `${state.carrots.length} Carrots`;
  installRoot.textContent = state.installRoot;

  if (state.carrots.length === 0) {
    const empty = document.createElement("article");
    empty.className = "carrot-card empty-card";
    empty.innerHTML = `
      <h2>No Carrots Installed</h2>
      <p class="description">Install a local Carrot source folder and Bunny Ears will build it into its runtime store.</p>
    `;
    grid.replaceChildren(empty);
    return;
  }

  grid.replaceChildren(...state.carrots.map(renderCarrot));
}

function renderCarrot(carrot: CarrotInfo) {
  const card = document.createElement("article");
  card.className = "carrot-card";

  const logs = carrot.logTail.length
    ? carrot.logTail.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")
    : '<li class="log-empty">No runtime logs yet.</li>';

  const sourceMeta = carrot.sourcePath
    ? `<div class="meta-row"><span>Source</span><strong class="path-text">${escapeHtml(carrot.sourcePath)}</strong></div>`
    : "";
  const buildError = carrot.lastBuildError
    ? `<div class="build-error">${escapeHtml(carrot.lastBuildError)}</div>`
    : "";
  const modeChips = [
    carrot.devMode ? '<span class="permission-chip dev-chip">dev mode</span>' : "",
    carrot.installStatus === "broken"
      ? '<span class="permission-chip broken-chip">build issue</span>'
      : "",
  ].join("");

  card.innerHTML = `
    <div class="card-head">
      <div>
        <h2>${escapeHtml(carrot.name)}</h2>
        <p class="description">${escapeHtml(carrot.description)}</p>
      </div>
      <span class="status-pill ${carrot.status}">${carrot.status}</span>
    </div>

    <div class="meta-list">
      <div class="meta-row"><span>Mode</span><strong>${carrot.mode}</strong></div>
      <div class="meta-row"><span>Version</span><strong>${carrot.version}</strong></div>
      <div class="meta-row"><span>Identifier</span><strong>${carrot.id}</strong></div>
      ${sourceMeta}
    </div>

    <div class="permission-wrap">
      ${modeChips}
      ${carrot.permissions.map((permission) => `<span class="permission-chip">${escapeHtml(permission)}</span>`).join("")}
    </div>

    ${buildError}
    <ul class="log-list">${logs}</ul>

    <div class="button-row">
      <button class="primary" data-action="launch">${carrot.status === "running" ? "Restart" : "Launch"}</button>
      <button class="secondary" data-action="stop" ${carrot.status === "stopped" ? "disabled" : ""}>Stop</button>
      <button class="secondary" data-action="open" ${carrot.mode !== "window" ? "disabled" : ""}>Open Window</button>
      <button class="secondary" data-action="rebuild" ${carrot.devMode ? "" : "disabled"}>Rebuild</button>
    </div>
  `;

  const launchButton = card.querySelector('[data-action="launch"]') as HTMLButtonElement;
  const stopButton = card.querySelector('[data-action="stop"]') as HTMLButtonElement;
  const openButton = card.querySelector('[data-action="open"]') as HTMLButtonElement;
  const rebuildButton = card.querySelector('[data-action="rebuild"]') as HTMLButtonElement;

  launchButton.addEventListener("click", async () => {
    await electroview.rpc!.request.launchCarrot({ id: carrot.id });
  });

  stopButton.addEventListener("click", async () => {
    await electroview.rpc!.request.stopCarrot({ id: carrot.id });
  });

  openButton.addEventListener("click", async () => {
    await electroview.rpc!.request.openCarrot({ id: carrot.id });
  });

  rebuildButton.addEventListener("click", async () => {
    await electroview.rpc!.request.rebuildCarrot({ id: carrot.id });
  });

  return card;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
