import { createCarrotClient } from "../../../ears/src/carrot-runtime/view";

const client = createCarrotClient();
const count = document.getElementById("count") as HTMLHeadingElement;
const updatedAt = document.getElementById("updated-at") as HTMLSpanElement;
const permissions = document.getElementById("permissions") as HTMLSpanElement;
const incrementButton = document.getElementById("increment") as HTMLButtonElement;
const notifyButton = document.getElementById("notify") as HTMLButtonElement;
const resetButton = document.getElementById("reset") as HTMLButtonElement;

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

async function bootstrap() {
  const snapshot = await client.invoke<any>("getSnapshot").catch(() => null);
  if (snapshot) render(snapshot);
}

function render(snapshot: { count: number; lastUpdatedAt: string | null; permissions: string[] }) {
  count.textContent = String(snapshot.count);
  updatedAt.textContent = snapshot.lastUpdatedAt
    ? new Date(snapshot.lastUpdatedAt).toLocaleString()
    : "Never";
  permissions.textContent = snapshot.permissions.join(", ");
}
