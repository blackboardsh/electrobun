import Electrobun, { Electroview } from "electrobun/view";
import type { CarrotPermissionConsentRequest } from "../carrot-runtime/types";

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
  sourceKind: "prototype" | "local" | "artifact";
  sourceLabel: string | null;
  lastBuildError: string | null;
  logTail: string[];
};

type DashboardState = {
  installRoot: string;
  carrots: CarrotInfo[];
  pendingConsent: CarrotPermissionConsentRequest | null;
};

type DashboardRPC = {
  bun: {
    requests: {
      getDashboard: {
        params: {};
        response: DashboardState;
      };
      installCarrotSourceFromDisk: {
        params: {};
        response: { ok: boolean; id?: string; error?: string; reason?: string };
      };
      installCarrotArtifactFromDisk: {
        params: {};
        response: { ok: boolean; id?: string; error?: string; reason?: string };
      };
      reinstallCarrot: {
        params: { id: string };
        response: { ok: boolean; id?: string; error?: string; reason?: string };
      };
      respondToConsent: {
        params: { requestId: string; approved: boolean };
        response: { ok: boolean; id?: string; error?: string; reason?: string };
      };
      uninstallCarrot: {
        params: { id: string };
        response: { ok: boolean; error?: string; reason?: string };
      };
      revealCarrot: {
        params: { id: string };
        response: { ok: boolean };
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
const installSourceButton = document.getElementById("install-carrot-source") as HTMLButtonElement;
const installArtifactButton = document.getElementById("install-carrot-artifact") as HTMLButtonElement;
const consentBackdrop = document.getElementById("consent-backdrop") as HTMLDivElement;
const consentTitle = document.getElementById("consent-title") as HTMLElement;
const consentMessage = document.getElementById("consent-message") as HTMLElement;
const consentVersion = document.getElementById("consent-version") as HTMLElement;
const consentSource = document.getElementById("consent-source") as HTMLElement;
const consentIsolation = document.getElementById("consent-isolation") as HTMLElement;
const consentHostList = document.getElementById("consent-host-list") as HTMLDivElement;
const consentBunList = document.getElementById("consent-bun-list") as HTMLDivElement;
const consentChangedSection = document.getElementById("consent-changed-section") as HTMLDivElement;
const consentChangedList = document.getElementById("consent-changed-list") as HTMLDivElement;
const consentCancelButton = document.getElementById("consent-cancel") as HTMLButtonElement;
const consentApproveButton = document.getElementById("consent-approve") as HTMLButtonElement;

let currentConsentRequestId: string | null = null;
let consentPending = false;

const rpc = Electroview.defineRPC<DashboardRPC>({
  maxRequestTime: 300000,
  handlers: {
    requests: {},
    messages: { dashboardChanged: (state) => render(state) },
  },
});

const electroview = new Electrobun.Electroview({ rpc });

installSourceButton.addEventListener("click", async () => {
  await electroview.rpc!.request.installCarrotSourceFromDisk({});
});

installArtifactButton.addEventListener("click", async () => {
  await electroview.rpc!.request.installCarrotArtifactFromDisk({});
});

consentCancelButton.addEventListener("click", async () => {
  await respondToConsent(false);
});

consentApproveButton.addEventListener("click", async () => {
  await respondToConsent(true);
});

void bootstrap();

async function bootstrap() {
  const state = await electroview.rpc!.request.getDashboard({});
  render(state);
}

function render(state: DashboardState) {
  carrotCount.textContent = `${state.carrots.length} Carrots`;
  installRoot.textContent = state.installRoot;

  renderConsent(state.pendingConsent);

  if (state.carrots.length === 0) {
    const empty = document.createElement("article");
    empty.className = "carrot-card empty-card";
    empty.innerHTML = `
      <h2>No Carrots Installed</h2>
      <p class="description">Install a local Carrot source folder, prepared artifact, <code>.tar.zst</code>, or <code>update.json</code>.</p>
    `;
    grid.replaceChildren(empty);
    return;
  }

  grid.replaceChildren(...state.carrots.map(renderCarrot));
}

function renderConsent(consent: CarrotPermissionConsentRequest | null) {
  currentConsentRequestId = consent?.requestId ?? null;
  consentPending = false;

  if (!consent) {
    consentBackdrop.dataset.open = "false";
    consentBackdrop.setAttribute("aria-hidden", "true");
    consentChangedSection.hidden = true;
    consentHostList.replaceChildren();
    consentBunList.replaceChildren();
    consentChangedList.replaceChildren();
    consentCancelButton.disabled = false;
    consentApproveButton.disabled = false;
    consentApproveButton.textContent = "Approve";
    return;
  }

  consentBackdrop.dataset.open = "true";
  consentBackdrop.setAttribute("aria-hidden", "false");
  consentTitle.textContent = `${consent.carrotName} wants these permissions`;
  consentMessage.textContent = consent.message;
  consentVersion.textContent = consent.version;
  consentSource.textContent = consent.sourceLabel;
  consentIsolation.textContent = formatIsolation(consent.isolation);
  consentApproveButton.textContent = consent.confirmLabel;

  consentHostList.replaceChildren(...renderPermissionChips(consent.hostPermissions, "host"));
  consentBunList.replaceChildren(...renderPermissionChips(consent.bunPermissions, "bun"));

  if (consent.changedPermissions.length > 0) {
    consentChangedSection.hidden = false;
    consentChangedList.replaceChildren(
      ...renderPermissionChips(consent.changedPermissions, "tag"),
    );
  } else {
    consentChangedSection.hidden = true;
    consentChangedList.replaceChildren();
  }
}

function renderCarrot(carrot: CarrotInfo) {
  const card = document.createElement("article");
  card.className = "carrot-card";

  const logs = carrot.logTail.length
    ? carrot.logTail.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")
    : '<li class="log-empty">No runtime logs yet.</li>';

  const sourceMeta = carrot.sourceLabel
    ? `<div class="meta-row"><span>${carrot.sourceKind === "artifact" ? "Artifact" : "Source"}</span><strong class="path-text">${escapeHtml(carrot.sourceLabel)}</strong></div>`
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

  const reinstallLabel =
    carrot.sourceKind === "local"
      ? carrot.devMode
        ? "Rebuild"
        : "Reinstall"
      : carrot.sourceKind === "artifact"
        ? "Reinstall"
        : "Unavailable";

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
      <button class="secondary" data-action="reinstall" ${carrot.sourceKind === "prototype" ? "disabled" : ""}>${reinstallLabel}</button>
      <button class="secondary" data-action="reveal">Reveal</button>
      <button class="secondary danger" data-action="uninstall">Uninstall</button>
    </div>
  `;

  const launchButton = card.querySelector('[data-action="launch"]') as HTMLButtonElement;
  const stopButton = card.querySelector('[data-action="stop"]') as HTMLButtonElement;
  const openButton = card.querySelector('[data-action="open"]') as HTMLButtonElement;
  const reinstallButton = card.querySelector('[data-action="reinstall"]') as HTMLButtonElement;
  const revealButton = card.querySelector('[data-action="reveal"]') as HTMLButtonElement;
  const uninstallButton = card.querySelector('[data-action="uninstall"]') as HTMLButtonElement;

  launchButton.addEventListener("click", async () => {
    await electroview.rpc!.request.launchCarrot({ id: carrot.id });
  });

  stopButton.addEventListener("click", async () => {
    await electroview.rpc!.request.stopCarrot({ id: carrot.id });
  });

  openButton.addEventListener("click", async () => {
    await electroview.rpc!.request.openCarrot({ id: carrot.id });
  });

  reinstallButton.addEventListener("click", async () => {
    await electroview.rpc!.request.reinstallCarrot({ id: carrot.id });
  });

  revealButton.addEventListener("click", async () => {
    await electroview.rpc!.request.revealCarrot({ id: carrot.id });
  });

  uninstallButton.addEventListener("click", async () => {
    await electroview.rpc!.request.uninstallCarrot({ id: carrot.id });
  });

  return card;
}

async function respondToConsent(approved: boolean) {
  if (!currentConsentRequestId || consentPending) {
    return;
  }

  consentPending = true;
  consentCancelButton.disabled = true;
  consentApproveButton.disabled = true;

  try {
    await electroview.rpc!.request.respondToConsent({
      requestId: currentConsentRequestId,
      approved,
    });
  } finally {
    consentPending = false;
  }
}

function renderPermissionChips(values: string[], kind: "host" | "bun" | "tag") {
  const normalizedValues = values.length > 0 ? values : ["none"];
  return normalizedValues.map((value) => {
    const chip = document.createElement("span");
    chip.className = `permission-chip consent-chip ${kind}-chip`;
    chip.textContent = formatPermissionValue(value);
    return chip;
  });
}

function formatPermissionValue(value: string) {
  switch (value) {
    case "windows":
      return "host.windows";
    case "tray":
      return "host.tray";
    case "notifications":
      return "host.notifications";
    case "storage":
      return "host.storage";
    case "read":
      return "bun.read";
    case "write":
      return "bun.write";
    case "env":
      return "bun.env";
    case "run":
      return "bun.run";
    case "ffi":
      return "bun.ffi";
    case "addons":
      return "bun.addons";
    case "worker":
      return "bun.worker";
    default:
      return value;
  }
}

function formatIsolation(value: string) {
  return value.replace("-", " ");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
