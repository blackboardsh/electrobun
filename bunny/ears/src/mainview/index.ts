import Electrobun, { Electroview } from "electrobun/view";

type CarrotInfo = {
  id: string;
  name: string;
  description: string;
  version: string;
  mode: "window" | "background";
  permissions: string[];
  status: "stopped" | "starting" | "running";
  logTail: string[];
};

type DashboardRPC = {
  bun: {
    requests: {
      getDashboard: {
        params: {};
        response: { carrots: CarrotInfo[] };
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
      dashboardChanged: { carrots: CarrotInfo[] };
    };
  };
};

const grid = document.getElementById("carrot-grid") as HTMLDivElement;
const carrotCount = document.getElementById("carrot-count") as HTMLElement;

const rpc = Electroview.defineRPC<DashboardRPC>({
  maxRequestTime: 10000,
  handlers: {
    requests: {},
    messages: {
      dashboardChanged: ({ carrots }) => render(carrots),
    },
  },
});

const electroview = new Electrobun.Electroview({ rpc });

void bootstrap();

async function bootstrap() {
  const { carrots } = await electroview.rpc!.request.getDashboard({});
  render(carrots);
}

function render(carrots: CarrotInfo[]) {
  carrotCount.textContent = `${carrots.length} Carrots`;
  grid.replaceChildren(...carrots.map(renderCarrot));
}

function renderCarrot(carrot: CarrotInfo) {
  const card = document.createElement("article");
  card.className = "carrot-card";

  const logs = carrot.logTail.length
    ? carrot.logTail.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")
    : '<li class="log-empty">No runtime logs yet.</li>';

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
    </div>

    <div class="permission-wrap">
      ${carrot.permissions.map((permission) => `<span class="permission-chip">${escapeHtml(permission)}</span>`).join("")}
    </div>

    <ul class="log-list">${logs}</ul>

    <div class="button-row">
      <button class="primary" data-action="launch">${carrot.status === "running" ? "Restart" : "Launch"}</button>
      <button class="secondary" data-action="stop" ${carrot.status === "stopped" ? "disabled" : ""}>Stop</button>
      <button class="secondary" data-action="open" ${carrot.mode !== "window" ? "disabled" : ""}>Open Window</button>
    </div>
  `;

  const launchButton = card.querySelector('[data-action="launch"]') as HTMLButtonElement;
  const stopButton = card.querySelector('[data-action="stop"]') as HTMLButtonElement;
  const openButton = card.querySelector('[data-action="open"]') as HTMLButtonElement;

  launchButton.addEventListener("click", async () => {
    await electroview.rpc!.request.launchCarrot({ id: carrot.id });
  });

  stopButton.addEventListener("click", async () => {
    await electroview.rpc!.request.stopCarrot({ id: carrot.id });
  });

  openButton.addEventListener("click", async () => {
    await electroview.rpc!.request.openCarrot({ id: carrot.id });
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
