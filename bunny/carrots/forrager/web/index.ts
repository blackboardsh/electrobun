import { createCarrotClient } from "../../../ears/src/carrot-runtime/view";

const client = createCarrotClient();
const label = document.getElementById("label") as HTMLHeadingElement;
const body = document.getElementById("body") as HTMLParagraphElement;
const cycleButton = document.getElementById("cycle") as HTMLButtonElement;

client.on("boot", async () => {
  const snapshot = await client.invoke<any>("boot");
  render(snapshot);
});

client.on("status", (payload) => {
  render(payload as any);
});

cycleButton.addEventListener("click", async () => {
  const snapshot = await client.invoke<any>("cycle");
  render(snapshot);
});

function render(snapshot: { label: string; body: string }) {
  label.textContent = snapshot.label;
  body.textContent = snapshot.body;
}
