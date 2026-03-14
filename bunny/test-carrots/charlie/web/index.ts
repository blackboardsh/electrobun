import { createCarrotClient } from "bunny-ears/view";

const client = createCarrotClient();
const count = document.getElementById("count") as HTMLHeadingElement;
const updatedAt = document.getElementById("updated-at") as HTMLSpanElement;
const permissions = document.getElementById("permissions") as HTMLSpanElement;
const incrementButton = document.getElementById("increment") as HTMLButtonElement;
const notifyButton = document.getElementById("notify") as HTMLButtonElement;
const resetButton = document.getElementById("reset") as HTMLButtonElement;
const probeFsButton = document.getElementById("probe-fs") as HTMLButtonElement;
const probeEnvButton = document.getElementById("probe-env") as HTMLButtonElement;
const probeSpawnButton = document.getElementById("probe-spawn") as HTMLButtonElement;
const probeFfiButton = document.getElementById("probe-ffi") as HTMLButtonElement;
const probeFsResult = document.getElementById("probe-fs-result") as HTMLSpanElement;
const probeEnvResult = document.getElementById("probe-env-result") as HTMLSpanElement;
const probeSpawnResult = document.getElementById("probe-spawn-result") as HTMLSpanElement;
const probeFfiResult = document.getElementById("probe-ffi-result") as HTMLSpanElement;

void bootstrap();

client.on("boot", async () => {
  permissions.textContent = client.bootInfo?.permissions.join(", ") || "none";
  const snapshot = await client.invoke<any>("getSnapshot");
  render(snapshot);
});

client.on("state", (payload) => {
  render(payload as any);
});

incrementButton.addEventListener("click", async () => {
  const snapshot = await client.invoke<any>("increment");
  render(snapshot);
});

notifyButton.addEventListener("click", async () => {
  const snapshot = await client.invoke<any>("notify");
  render(snapshot);
});

resetButton.addEventListener("click", async () => {
  const snapshot = await client.invoke<any>("reset");
  render(snapshot);
});

probeFsButton.addEventListener("click", async () => {
  const snapshot = await client.invoke<any>("probeFs");
  render(snapshot);
});

probeEnvButton.addEventListener("click", async () => {
  const snapshot = await client.invoke<any>("probeEnv");
  render(snapshot);
});

probeSpawnButton.addEventListener("click", async () => {
  const snapshot = await client.invoke<any>("probeSpawn");
  render(snapshot);
});

probeFfiButton.addEventListener("click", async () => {
  const snapshot = await client.invoke<any>("probeFFI");
  render(snapshot);
});

async function bootstrap() {
  const snapshot = await client.invoke<any>("getSnapshot").catch(() => null);
  if (snapshot) render(snapshot);
}

function render(snapshot: {
  count: number;
  lastUpdatedAt: string | null;
  permissions: string[];
  probes?: Record<string, string>;
}) {
  count.textContent = String(snapshot.count);
  updatedAt.textContent = snapshot.lastUpdatedAt
    ? new Date(snapshot.lastUpdatedAt).toLocaleString()
    : "Never";
  permissions.textContent = snapshot.permissions.join(", ");
  probeFsResult.textContent = snapshot.probes?.read || "Not run";
  probeEnvResult.textContent = snapshot.probes?.env || "Not run";
  probeSpawnResult.textContent = snapshot.probes?.run || "Not run";
  probeFfiResult.textContent = snapshot.probes?.ffi || "Not run";
}
