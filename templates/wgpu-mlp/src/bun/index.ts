import {
  BrowserView,
  BrowserWindow,
  Screen,
  type RPCSchema,
  webgpu,
} from "electrobun/bun";

console.log("wgpu-mlp starting");
webgpu.install();

const display = Screen.getPrimaryDisplay();
const workArea = display.workArea;

const SIZE = 16;
const INPUT_LEN = SIZE * SIZE;
const CLASS_COUNT = 10;
const BufferUsage = {
  MapRead: 0x00000001,
  MapWrite: 0x00000002,
  CopySrc: 0x00000004,
  CopyDst: 0x00000008,
  Index: 0x00000010,
  Vertex: 0x00000020,
  Uniform: 0x00000040,
  Storage: 0x00000080,
  Indirect: 0x00000100,
  QueryResolve: 0x00000200,
};

function build7SegTemplates() {
  const templates: Float32Array[] = [];
  const grid = (fill = 0) => new Float32Array(INPUT_LEN).fill(fill);

  const drawRect = (
    buf: Float32Array,
    x: number,
    y: number,
    w: number,
    h: number,
    val = 1,
  ) => {
    for (let iy = y; iy < y + h; iy += 1) {
      for (let ix = x; ix < x + w; ix += 1) {
        if (ix < 0 || iy < 0 || ix >= SIZE || iy >= SIZE) continue;
        buf[iy * SIZE + ix] = val;
      }
    }
  };

  const segments = [
    { x: 3, y: 1, w: 10, h: 2 }, // top
    { x: 2, y: 3, w: 2, h: 5 }, // upper left
    { x: 12, y: 3, w: 2, h: 5 }, // upper right
    { x: 3, y: 8, w: 10, h: 2 }, // middle
    { x: 2, y: 10, w: 2, h: 5 }, // lower left
    { x: 12, y: 10, w: 2, h: 5 }, // lower right
    { x: 3, y: 14, w: 10, h: 2 }, // bottom
  ];

  const digitSegments = [
    [0, 1, 2, 4, 5, 6], // 0
    [2, 5], // 1
    [0, 2, 3, 4, 6], // 2
    [0, 2, 3, 5, 6], // 3
    [1, 2, 3, 5], // 4
    [0, 1, 3, 5, 6], // 5
    [0, 1, 3, 4, 5, 6], // 6
    [0, 2, 5], // 7
    [0, 1, 2, 3, 4, 5, 6], // 8
    [0, 1, 2, 3, 5, 6], // 9
  ];

  for (let d = 0; d < 10; d += 1) {
    const buf = grid();
    for (const seg of digitSegments[d]!) {
      const s = segments[seg]!;
      drawRect(buf, s.x, s.y, s.w, s.h, 1);
    }
    templates.push(buf);
  }

  return templates;
}

const templates = build7SegTemplates();
const templateMatrix = new Float32Array(CLASS_COUNT * INPUT_LEN);
const templateNorms = new Float32Array(CLASS_COUNT);
for (let i = 0; i < CLASS_COUNT; i += 1) {
  templateMatrix.set(templates[i]!, i * INPUT_LEN);
  let energy = 0;
  for (let j = 0; j < INPUT_LEN; j += 1) {
    const v = templates[i]![j]!;
    energy += v * v;
  }
  templateNorms[i] = Math.sqrt(energy) || 1;
}

function cpuClassify(input: Float32Array) {
  let inputEnergy = 0;
  for (let i = 0; i < INPUT_LEN; i += 1) {
    const v = input[i]!;
    inputEnergy += v * v;
  }
  const inputNorm = Math.sqrt(inputEnergy) || 1;
  let best = -Infinity;
  let bestIdx = 0;
  const scores: number[] = [];
  for (let i = 0; i < CLASS_COUNT; i += 1) {
    let sum = 0;
    const offset = i * INPUT_LEN;
    for (let j = 0; j < INPUT_LEN; j += 1) {
      sum += input[j]! * templateMatrix[offset + j]!;
    }
    const score = sum / (templateNorms[i]! * inputNorm);
    scores.push(score);
    if (score > best) {
      best = score;
      bestIdx = i;
    }
  }
  return { prediction: bestIdx, scores };
}

const GPU_ENABLED = true;
let gpuReady = false;
let gpuInitPromise: Promise<void> | null = null;
let device: any = null;
let pipeline: any = null;
let bindGroup: any = null;
let inputBuffer: any = null;
let templateBuffer: any = null;
let outputBuffer: any = null;
let readBuffer: any = null;
let inFlight = false;
let pendingInput: Float32Array | null = null;

const shaderCode = `
@group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
@group(0) @binding(1) var<storage, read> templateBuf: array<f32>;
@group(0) @binding(2) var<storage, read_write> outputBuf: array<f32>;

const LEN: u32 = ${INPUT_LEN}u;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= ${CLASS_COUNT}u) { return; }
  var sum: f32 = 0.0;
  let base = idx * LEN;
  for (var i: u32 = 0u; i < LEN; i = i + 1u) {
    sum = sum + inputBuf[i] * templateBuf[base + i];
  }
  outputBuf[idx] = sum;
}
`;

async function initGPU() {
  if (!GPU_ENABLED) return;
  console.log("[wgpu-mlp] initGPU starting");
  const adapter = await webgpu.navigator.requestAdapter();
  if (!adapter) {
    console.log("[wgpu-mlp] GPU adapter not available");
    return;
  }
  console.log("[wgpu-mlp] GPU adapter acquired");
  try {
    device = await adapter.requestDevice();
    if (!device) {
      console.log("[wgpu-mlp] GPU device request failed");
      return;
    }
    console.log("[wgpu-mlp] GPU device acquired");

    inputBuffer = device.createBuffer({
      size: INPUT_LEN * 4,
      usage: BufferUsage.Storage | BufferUsage.CopyDst,
    });
    templateBuffer = device.createBuffer({
      size: templateMatrix.byteLength,
      usage: BufferUsage.Storage | BufferUsage.CopyDst,
    });
    outputBuffer = device.createBuffer({
      size: CLASS_COUNT * 4,
      usage: BufferUsage.Storage | BufferUsage.CopySrc,
    });
    readBuffer = device.createBuffer({
      size: CLASS_COUNT * 4,
      usage: BufferUsage.MapRead | BufferUsage.CopyDst,
    });
    console.log("[wgpu-mlp] GPU buffers created");

    device.queue.writeBuffer(templateBuffer, 0, templateMatrix);
    console.log("[wgpu-mlp] GPU template uploaded");

    const module = device.createShaderModule({ code: shaderCode });
    pipeline = device.createComputePipeline({
      layout: "auto",
      compute: {
        module,
        entryPoint: "main",
      },
    });
    console.log("[wgpu-mlp] GPU pipeline created");

    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuffer } },
        { binding: 1, resource: { buffer: templateBuffer } },
        { binding: 2, resource: { buffer: outputBuffer } },
      ],
    });
    console.log("[wgpu-mlp] GPU bindGroup created");

    gpuReady = true;
    console.log("[wgpu-mlp] GPU compute ready");
  } catch (err) {
    console.log("[wgpu-mlp] GPU init failed", String(err));
    return;
  }
}

async function ensureGPU() {
  if (!GPU_ENABLED || gpuReady) return;
  if (!gpuInitPromise) {
    console.log("[wgpu-mlp] ensureGPU kicking off init");
  }
  if (!gpuInitPromise) {
    gpuInitPromise = initGPU().catch(() => {});
  }
  await gpuInitPromise;
}

async function gpuClassify(input: Float32Array) {
  if (!gpuReady) return null;
  if (inFlight) {
    pendingInput = input;
    return null;
  }
  inFlight = true;
  device.queue.writeBuffer(inputBuffer, 0, input);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(CLASS_COUNT);
  pass.end();
  encoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, CLASS_COUNT * 4);
  const cmd = encoder.finish();
  device.queue.submit([cmd]);

  await readBuffer.mapAsync();
  const mapped = readBuffer.getMappedRange(0, CLASS_COUNT * 4);
  const out = new Float32Array(mapped.slice(0));
  readBuffer.unmap();
  inFlight = false;
  if (pendingInput) {
    const next = pendingInput;
    pendingInput = null;
    queueMicrotask(() => {
      void gpuClassify(next);
    });
  }
  return out;
}

// RPC

type MlpRPC = {
  bun: RPCSchema<{
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
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {};
  }>;
};

const rpc = BrowserView.defineRPC<MlpRPC>({
  maxRequestTime: 30000,
  handlers: {
    requests: {
      classifyStart: async ({ pixels }) => {
        const input = new Float32Array(INPUT_LEN);
        for (let i = 0; i < INPUT_LEN; i += 1) {
          input[i] = pixels[i] ?? 0;
        }
        queueMicrotask(async () => {
          let inputEnergy = 0;
          for (let i = 0; i < INPUT_LEN; i += 1) {
            const v = input[i]!;
            inputEnergy += v * v;
          }
          const inputNorm = Math.sqrt(inputEnergy) || 1;

          let source = "cpu";
          let scores = cpuClassify(input).scores;
          await ensureGPU();
          if (gpuReady) {
            try {
              const gpuScores = await gpuClassify(input);
              if (gpuScores && gpuScores.length === CLASS_COUNT) {
                scores = Array.from(
                  gpuScores,
                  (v, i) => v / (templateNorms[i]! * inputNorm),
                );
                source = "gpu";
              } else {
                throw new Error("gpu scores unavailable");
              }
            } catch {
              source = "cpu";
            }
          }

          let best = 0;
          let bestVal = -Infinity;
          for (let i = 0; i < scores.length; i += 1) {
            if (scores[i]! > bestVal) {
              bestVal = scores[i]!;
              best = i;
            }
          }

          try {
            rpc.send.classifyResult({ prediction: best, scores, source });
          } catch {
            // ignore send errors
          }
        });

        return { accepted: true };
      },
    },
    messages: {},
  },
});
const win = new BrowserWindow({
  title: "WGPU MLP Digit Demo",
  url: "views://mainview/index.html",
  frame: { width: 720, height: 640, x: workArea.x + 80, y: workArea.y + 60 },
  rpc,
});

win.focus();

console.log("WGPU MLP demo ready");
