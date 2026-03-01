import Electrobun, { Electroview } from "electrobun/view";

type MlpRPC = {
  bun: {
    requests: {
      classifyStart: {
        params: { pixels: number[] };
        response: { accepted: boolean };
      };
    };
    messages: {
      classifyResult: {
        payload: {
          prediction: number;
          scores: number[];
          source: string;
        };
      };
    };
  };
  webview: {
    requests: {};
    messages: {};
  };
};

const rpc = Electroview.defineRPC<MlpRPC>({
  maxRequestTime: 30000,
  handlers: {
    requests: {},
    messages: {
      classifyResult: ({ prediction, scores, source }) => {
        pred.textContent = String(prediction);
        const lines = scores.map((s, i) => `${i}: ${s.toFixed(3)}`).join("\n");
        scoresEl.textContent = `${lines}\n(source: ${source})`;
        statusEl.textContent = "Ready";
      },
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

const canvas = document.getElementById("draw") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;
const brush = document.getElementById("brush") as HTMLInputElement;
const smooth = document.getElementById("smooth") as HTMLInputElement;
const pred = document.getElementById("pred") as HTMLSpanElement;
const scoresEl = document.getElementById("scores") as HTMLPreElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;

ctx.fillStyle = "#0f121a";
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.lineCap = "round";
ctx.lineJoin = "round";
ctx.strokeStyle = "#e6e8ee";

let drawing = false;
let last = { x: 0, y: 0 };
let debounce: ReturnType<typeof setTimeout> | null = null;

function clearCanvas() {
  ctx.fillStyle = "#0f121a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  pred.textContent = "-";
  scoresEl.textContent = "";
  statusEl.textContent = "Cleared";
}

function normalize() {
  const size = 16;
  const off = document.createElement("canvas");
  off.width = size;
  off.height = size;
  const offCtx = off.getContext("2d")!;
  offCtx.fillStyle = "#0f121a";
  offCtx.fillRect(0, 0, size, size);
  offCtx.drawImage(canvas, 0, 0, size, size);
  const image = offCtx.getImageData(0, 0, size, size).data;
  const sampleIndices = [
    0,
    (size - 1) * 4,
    (size * (size - 1)) * 4,
    (size * size - 1) * 4,
  ];
  let bg = 0;
  for (const idx of sampleIndices) {
    const r = image[idx] ?? 0;
    const g = image[idx + 1] ?? 0;
    const b = image[idx + 2] ?? 0;
    bg += (r + g + b) / 3 / 255;
  }
  bg /= sampleIndices.length;
  const pixels: number[] = [];
  for (let i = 0; i < image.length; i += 4) {
    const r = image[i] ?? 0;
    const g = image[i + 1] ?? 0;
    const b = image[i + 2] ?? 0;
    const lum = (r + g + b) / 3 / 255;
    const norm = Math.max(0, (lum - bg) / Math.max(1e-3, 1 - bg));
    pixels.push(Math.min(1, norm * 1.2));
  }
  return pixels;
}

async function classify() {
  const pixels = normalize();
  statusEl.textContent = "Running inference...";
  try {
    await electrobun.rpc!.request.classifyStart({ pixels });
  } catch (err) {
    statusEl.textContent = `Error: ${String(err)}`;
  }
}

function schedule() {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    classify();
  }, 220);
}

canvas.addEventListener("pointerdown", (evt) => {
  drawing = true;
  last = { x: evt.offsetX, y: evt.offsetY };
});

canvas.addEventListener("pointermove", (evt) => {
  if (!drawing) return;
  const x = evt.offsetX;
  const y = evt.offsetY;
  const radius = Number(brush.value);
  const smoothness = Number(smooth.value);
  ctx.lineWidth = radius;
  ctx.globalAlpha = 0.8 + 0.2 * smoothness;
  ctx.beginPath();
  ctx.moveTo(last.x, last.y);
  ctx.lineTo(x, y);
  ctx.stroke();
  last = { x, y };
  schedule();
});

canvas.addEventListener("pointerup", () => {
  drawing = false;
  schedule();
});

canvas.addEventListener("pointerleave", () => {
  drawing = false;
});

clearBtn.addEventListener("click", clearCanvas);

clearCanvas();
