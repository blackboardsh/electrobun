# DirectComposition Benchmark Results

## Test Environment
- **OS**: Windows 11 Pro
- **GPU**: (fill in)
- **CPU**: (fill in)
- **Electrobun**: v1.16.0 (fork: devallibus/electrobun-dcomp)
- **Branch**: feat/win-directcomposition
- **Scene**: gametau battlestation (A130 Defense)

## Benchmark Table

| Config | Renderer | Surface | Frame time (ms) | FPS | CPU (%) | Notes |
|--------|----------|---------|-----------------|-----|---------|-------|
| WebView canvas | WebGLRenderer | `<canvas>` in WebView2 | - | - | - | Baseline HTML-only |
| WGPU GpuWindow | WebGPURenderer | Native DX12 (HWND) | - | - | - | Current best path |
| WGPU + DComp (NEW) | WebGPURenderer | DirectComposition | - | - | - | This PR |
| UpdateLayeredWindow (OLD) | WebGPURenderer | Software composite | - | - | - | Legacy path |
| DComp D3D11 triangle | D3D11 | DComp swap chain | - | - | - | Phase 3 proof |

## Phase 2: Solid Color Test
- [ ] `dcompInitForView` succeeds
- [ ] Solid color appears via DXGI swap chain composited by DirectComposition
- [ ] No `UpdateLayeredWindow` calls in this path

## Phase 3: Triangle Test
- [ ] `dcompInitTrianglePipeline` succeeds
- [ ] `dcompStartRenderLoop` shows rotating triangle at 60 FPS
- [ ] Frame time logged every second via `[DComp] Frame N, last frame: X.XXms`

## Phase 4: WebView2 + WGPU Layering
- [ ] Experimental only: composition-hosted WebView2 path is enabled
- [ ] `dcompSetupLayeredTree` builds visual tree
- [ ] `dcompAttachWebView2` binds a composition controller via `put_RootVisualTarget`
- [ ] Resize synchronization works in the composition-hosted path

## Phase 5: Three.js Hybrid
- [ ] gametau battlestation scene renders via DirectComposition
- [ ] HTML HUD overlay in WebView2 layer
- [ ] Frame times comparable to or better than GpuWindow baseline

## How to Run Benchmarks

### Phase 2-3 (DComp standalone)
```typescript
import { DCompBridge } from "electrobun/bun";

// Phase 2: Solid color
DCompBridge.initForView(viewPtr, 800, 600);
DCompBridge.renderColor(0.2, 0.5, 0.8, 1.0); // Blue

// Phase 3: Triangle render loop
DCompBridge.initTrianglePipeline();
DCompBridge.startRenderLoop(); // 60 FPS rotating triangle
// ... wait ...
console.log("Frame time:", DCompBridge.getLastFrameTimeMs(), "ms");
console.log("Frame count:", DCompBridge.getFrameCount());
DCompBridge.stopRenderLoop();
```

### Phase 5 (Three.js hybrid)
```typescript
// Stable path: pre-init the DComp back layer before BrowserWindow creation.
DCompBridge.enableMode(960, 960);

// BrowserWindow/WebView2 still uses the standard child-HWND controller path.
const win = new BrowserWindow({
  title: "Benchmark",
  frame: { width: 960, height: 960, x: 100, y: 100 },
  transparent: true,
  url: "views://mainview/index.html",
});

// 2. Run battlestation scene against DComp surface
const scene = createDefenseSceneGpu(win, theme.scene);
// ... runtime loop ...

// 3. Measure frame times from your runtime loop / bridge stats
```
