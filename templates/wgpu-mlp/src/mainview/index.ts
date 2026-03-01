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
const preview = document.getElementById("preview") as HTMLCanvasElement;
const previewCtx = preview.getContext("2d")!;
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
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#0f121a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  pred.textContent = "-";
  scoresEl.textContent = "";
  statusEl.textContent = "Cleared";
}

function normalize() {
  const size = 32;
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

  const raw: number[] = [];
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const r = image[i] ?? 0;
      const g = image[i + 1] ?? 0;
      const b = image[i + 2] ?? 0;
      const lum = (r + g + b) / 3 / 255;
      const norm = Math.max(0, (lum - bg) / Math.max(1e-3, 1 - bg));
      const val = Math.min(1, norm * 1.2);
      raw.push(val);
      if (val > 0.08) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return raw;
  }

  const boxW = Math.max(1, maxX - minX + 1);
  const boxH = Math.max(1, maxY - minY + 1);
  const target = Math.round(size * 0.75);
  const scale = target / Math.max(boxW, boxH);
  const dst = new Array<number>(size * size).fill(0);
  const cx = (minX + maxX + 1) / 2;
  const cy = (minY + maxY + 1) / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = raw[y * size + x]!;
      if (v <= 0) continue;
      const sx = (x - cx) * scale + size / 2;
      const sy = (y - cy) * scale + size / 2;
      const ix = Math.round(sx);
      const iy = Math.round(sy);
      if (ix < 0 || iy < 0 || ix >= size || iy >= size) continue;
      const idx = iy * size + ix;
      if (v > dst[idx]!) dst[idx] = v;
    }
  }
  const boosted = edgeBoost(dst, size);
  drawPreview(boosted, size);
  return boosted;
}

function edgeBoost(src: number[], size: number) {
  const out = new Array<number>(src.length).fill(0);
  const w = size;
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const i = y * w + x;
      const gx =
        -src[i - w - 1]! -
        2 * src[i - 1]! -
        src[i + w - 1]! +
        src[i - w + 1]! +
        2 * src[i + 1]! +
        src[i + w + 1]!;
      const gy =
        -src[i - w - 1]! -
        2 * src[i - w]! -
        src[i - w + 1]! +
        src[i + w - 1]! +
        2 * src[i + w]! +
        src[i + w + 1]!;
      const mag = Math.min(1, Math.sqrt(gx * gx + gy * gy));
      out[i] = Math.max(src[i]!, mag);
    }
  }
  return out;
}

function drawPreview(pixels: number[], size: number) {
  const img = previewCtx.createImageData(size, size);
  for (let i = 0; i < pixels.length; i += 1) {
    const v = Math.max(0, Math.min(1, pixels[i]!));
    const c = Math.round(v * 255);
    const o = i * 4;
    img.data[o] = c;
    img.data[o + 1] = c;
    img.data[o + 2] = c;
    img.data[o + 3] = 255;
  }
  const off = document.createElement("canvas");
  off.width = size;
  off.height = size;
  off.getContext("2d")!.putImageData(img, 0, 0);
  previewCtx.clearRect(0, 0, preview.width, preview.height);
  previewCtx.imageSmoothingEnabled = false;
  previewCtx.drawImage(off, 0, 0, preview.width, preview.height);
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
