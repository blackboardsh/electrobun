// dcomp_compositor.h — DirectComposition GPU surface compositor for Windows
//
// Replaces UpdateLayeredWindow (CPU pixel copy) with zero-copy GPU compositing
// using DirectComposition + DXGI swap chain. This matches the macOS CAMetalLayer
// compositing pattern used in Electrobun for native GPU rendering.
//
// Phase 2: Prove the compositing pipeline with a solid color render.
// Phase 3: D3D11 triangle + WGPU child visual in DComp tree.
// Phase 4: Layer WebView2 composition controller into the visual tree.

#pragma once

#include <dcomp.h>
#include <dxgi1_2.h>
#include <dxgi1_4.h>
#include <d3d11.h>
#include <d3d11_4.h>
#include <d3d11on12.h>
#include <d3d12.h>
#include <d3dcompiler.h>
#include <wrl.h>
#include <cstdio>
#include <cmath>
#include <mutex>

#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "d3d12.lib")
#pragma comment(lib, "d3dcompiler.lib")

#include <versionhelpers.h>
#include <WebView2.h>

using Microsoft::WRL::ComPtr;

// Feature gate: DirectComposition requires Windows 8.1+.
// Note: IsWindows8Point1OrGreater() requires an app manifest to report correctly.
// Without a manifest, Windows lies about the version. We use RtlGetVersion instead
// which always returns the true OS version.
static bool isDCompAvailable() {
    static int cached = -1;
    if (cached >= 0) return cached == 1;

    // RtlGetVersion is not affected by manifests — always returns the real version.
    typedef LONG (WINAPI *RtlGetVersionPtr)(OSVERSIONINFOEXW*);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (ntdll) {
        auto fn = (RtlGetVersionPtr)GetProcAddress(ntdll, "RtlGetVersion");
        if (fn) {
            OSVERSIONINFOEXW osInfo = {};
            osInfo.dwOSVersionInfoSize = sizeof(osInfo);
            if (fn(&osInfo) == 0) {
                // Windows 8.1 = 6.3, Windows 10/11 = 10.0
                bool ok = (osInfo.dwMajorVersion > 6) ||
                          (osInfo.dwMajorVersion == 6 && osInfo.dwMinorVersion >= 3);
                printf("[DComp] OS version: %lu.%lu.%lu — DComp %s\n",
                       osInfo.dwMajorVersion, osInfo.dwMinorVersion,
                       osInfo.dwBuildNumber, ok ? "available" : "not available");
                cached = ok ? 1 : 0;
                return ok;
            }
        }
    }

    // Fallback: assume available on modern Windows
    printf("[DComp] Could not detect OS version, assuming DComp available\n");
    cached = 1;
    return true;
}

// ============================================================================
// HLSL shaders for Phase 3 triangle rendering via D3D11
// ============================================================================

static const char* kDCompVertexShader = R"(
struct VSInput {
    float2 pos : POSITION;
    float4 col : COLOR;
};
struct VSOutput {
    float4 pos : SV_Position;
    float4 col : COLOR;
};
VSOutput main(VSInput input) {
    VSOutput output;
    output.pos = float4(input.pos, 0.0, 1.0);
    output.col = input.col;
    return output;
}
)";

static const char* kDCompPixelShader = R"(
struct PSInput {
    float4 pos : SV_Position;
    float4 col : COLOR;
};
float4 main(PSInput input) : SV_Target {
    // Premultiply alpha for DirectComposition
    return float4(input.col.rgb * input.col.a, input.col.a);
}
)";

// Triangle vertices: position (x, y) + color (r, g, b, a)
struct DCompVertex {
    float x, y;
    float r, g, b, a;
};

class DCompCompositor {
public:
    // Initialize DirectComposition pipeline on an existing HWND.
    // Creates: D3D11 device -> DXGI swap chain (for composition) -> DComp visual tree
    bool init(HWND targetHwnd, int width, int height) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!isDCompAvailable()) return false;

        this->targetHwnd = targetHwnd;
        this->surfaceWidth = width;
        this->surfaceHeight = height;

        // 1. Create D3D11 device (needed for DXGI swap chain creation)
        D3D_FEATURE_LEVEL featureLevel;
        UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        HRESULT hr = D3D11CreateDevice(
            nullptr,                    // Default adapter
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            flags,
            nullptr, 0,                 // Default feature levels
            D3D11_SDK_VERSION,
            &d3dDevice,
            &featureLevel,
            &d3dContext
        );
        if (FAILED(hr)) {
            printf("[DComp] D3D11CreateDevice failed: 0x%08lx\n", hr);
            return false;
        }
        printf("[DComp] D3D11 device created, feature level: 0x%x\n", featureLevel);
        enableMultithreadProtection(d3dContext.Get(), "primary");

        // 2. Get DXGI device from D3D11 device
        ComPtr<IDXGIDevice> dxgiDevice;
        hr = d3dDevice.As(&dxgiDevice);
        if (FAILED(hr)) {
            printf("[DComp] Failed to get IDXGIDevice: 0x%08lx\n", hr);
            return false;
        }

        // 3. Get DXGI factory via adapter chain
        ComPtr<IDXGIAdapter> dxgiAdapter;
        hr = dxgiDevice->GetAdapter(&dxgiAdapter);
        if (FAILED(hr)) {
            printf("[DComp] Failed to get DXGI adapter: 0x%08lx\n", hr);
            return false;
        }

        hr = dxgiAdapter->GetParent(IID_PPV_ARGS(&dxgiFactory));
        if (FAILED(hr)) {
            printf("[DComp] Failed to get DXGI factory: 0x%08lx\n", hr);
            return false;
        }

        // 4. Create swap chain FOR COMPOSITION (not for HWND)
        // This is the key difference: CreateSwapChainForComposition produces a swap
        // chain that can be set as content on a DirectComposition visual, enabling
        // zero-copy GPU-to-screen compositing without UpdateLayeredWindow.
        DXGI_SWAP_CHAIN_DESC1 scDesc = {};
        scDesc.Width = width;
        scDesc.Height = height;
        scDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        scDesc.SampleDesc.Count = 1;
        scDesc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        scDesc.BufferCount = 2;
        scDesc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
        scDesc.AlphaMode = DXGI_ALPHA_MODE_PREMULTIPLIED;

        hr = dxgiFactory->CreateSwapChainForComposition(
            d3dDevice.Get(), &scDesc, nullptr, &swapChain);
        if (FAILED(hr)) {
            printf("[DComp] CreateSwapChainForComposition failed: 0x%08lx\n", hr);
            return false;
        }
        printf("[DComp] Swap chain created for composition (%dx%d)\n", width, height);

        // 5. Create DirectComposition device from DXGI device
        hr = DCompositionCreateDevice(
            dxgiDevice.Get(),
            IID_PPV_ARGS(&dcompDevice));
        if (FAILED(hr)) {
            printf("[DComp] DCompositionCreateDevice failed: 0x%08lx\n", hr);
            return false;
        }

        // 6. Create composition target for the HWND
        // topmost=FALSE puts DComp content BEHIND child window content (WebView2),
        // so HTML renders on top with transparent areas showing the GPU content.
        hr = dcompDevice->CreateTargetForHwnd(targetHwnd, FALSE, &dcompTarget);
        if (FAILED(hr)) {
            printf("[DComp] CreateTargetForHwnd failed: 0x%08lx\n", hr);
            return false;
        }

        // 7. Create root visual and set swap chain as its content
        hr = dcompDevice->CreateVisual(&rootVisual);
        if (FAILED(hr)) {
            printf("[DComp] CreateVisual failed: 0x%08lx\n", hr);
            return false;
        }

        hr = rootVisual->SetContent(swapChain.Get());
        if (FAILED(hr)) {
            printf("[DComp] SetContent failed: 0x%08lx\n", hr);
            return false;
        }

        // 8. Wire the visual tree: target -> root visual -> swap chain
        hr = dcompTarget->SetRoot(rootVisual.Get());
        if (FAILED(hr)) {
            printf("[DComp] SetRoot failed: 0x%08lx\n", hr);
            return false;
        }

        hr = dcompDevice->Commit();
        if (FAILED(hr)) {
            printf("[DComp] Initial Commit failed: 0x%08lx\n", hr);
            return false;
        }

        printf("[DComp] DirectComposition pipeline initialized successfully\n");
        initialized = true;
        return true;
    }

    // ========================================================================
    // Zero-copy bridge: deferred swap chain init
    // ========================================================================

    // Minimal init: DComp visual tree only, no rendering device or swap chain.
    // The swap chain is created later via initSwapChainFromDevice() once Dawn's
    // D3D11On12 device is available.
    bool initMinimal(HWND hwnd, int width, int height) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!isDCompAvailable()) return false;

        this->targetHwnd = hwnd;
        this->surfaceWidth = width;
        this->surfaceHeight = height;

        // DCompositionCreateDevice2 with a DXGI device creates a DComp device
        // that can hold visuals/targets. We pass nullptr to create a device-less
        // compositor — swap chain content is attached later.
        //
        // Fallback: if nullptr doesn't work, we create a temporary D3D11 device
        // just for DComp init. The swap chain content can be replaced later.
        HRESULT hr = DCompositionCreateDevice2(nullptr, IID_PPV_ARGS(&dcompDevice));
        if (FAILED(hr)) {
            printf("[DComp] DCompositionCreateDevice2(null) failed: 0x%08lx, trying fallback\n", hr);

            // Fallback: create a lightweight D3D11 device just for DComp
            D3D_FEATURE_LEVEL featureLevel;
            hr = D3D11CreateDevice(
                nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                nullptr, 0, D3D11_SDK_VERSION,
                &d3dDevice, &featureLevel, &d3dContext);
            if (FAILED(hr)) {
                printf("[DComp] Fallback D3D11CreateDevice failed: 0x%08lx\n", hr);
                return false;
            }
            enableMultithreadProtection(d3dContext.Get(), "fallback");

            ComPtr<IDXGIDevice> dxgiDevice;
            hr = d3dDevice.As(&dxgiDevice);
            if (FAILED(hr)) return false;

            hr = DCompositionCreateDevice(dxgiDevice.Get(), IID_PPV_ARGS(&dcompDevice));
            if (FAILED(hr)) {
                printf("[DComp] Fallback DCompositionCreateDevice failed: 0x%08lx\n", hr);
                return false;
            }
        }

        hr = dcompDevice->CreateTargetForHwnd(hwnd, FALSE, &dcompTarget);
        if (FAILED(hr)) {
            printf("[DComp] CreateTargetForHwnd failed: 0x%08lx\n", hr);
            return false;
        }

        hr = dcompDevice->CreateVisual(&rootVisual);
        if (FAILED(hr)) {
            printf("[DComp] CreateVisual failed: 0x%08lx\n", hr);
            return false;
        }

        hr = dcompTarget->SetRoot(rootVisual.Get());
        if (FAILED(hr)) return false;

        hr = dcompDevice->Commit();
        if (FAILED(hr)) return false;

        printf("[DComp] Minimal init done (visual tree only, no swap chain)\n");
        initialized = true;
        return true;
    }

    // Create a swap chain on an external D3D11 device (e.g., Dawn's D3D11On12).
    // Call after initMinimal() + Dawn device creation.
    bool initSwapChainFromDevice(ID3D11Device* externalDevice, int width, int height) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!initialized || !dcompDevice || !rootVisual) return false;
        if (!externalDevice) return false;

        // Store the external device for blit/present operations
        externalD3dDevice = externalDevice;
        externalDevice->GetImmediateContext(&externalD3dContext);
        enableMultithreadProtection(externalD3dContext.Get(), "external");

        // Get DXGI factory from external device
        ComPtr<IDXGIDevice> dxgiDevice;
        HRESULT hr = externalDevice->QueryInterface(IID_PPV_ARGS(&dxgiDevice));
        if (FAILED(hr)) {
            printf("[DComp] External device QI for IDXGIDevice failed: 0x%08lx\n", hr);
            return false;
        }

        ComPtr<IDXGIAdapter> dxgiAdapter;
        hr = dxgiDevice->GetAdapter(&dxgiAdapter);
        if (FAILED(hr)) return false;

        ComPtr<IDXGIFactory2> factory;
        hr = dxgiAdapter->GetParent(IID_PPV_ARGS(&factory));
        if (FAILED(hr)) return false;

        // Create swap chain for composition on the external device
        DXGI_SWAP_CHAIN_DESC1 scDesc = {};
        scDesc.Width = width;
        scDesc.Height = height;
        scDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        scDesc.SampleDesc.Count = 1;
        scDesc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        scDesc.BufferCount = 2;
        scDesc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
        scDesc.AlphaMode = DXGI_ALPHA_MODE_PREMULTIPLIED;

        hr = factory->CreateSwapChainForComposition(
            externalDevice, &scDesc, nullptr, &swapChain);
        if (FAILED(hr)) {
            printf("[DComp] CreateSwapChainForComposition (external) failed: 0x%08lx\n", hr);
            return false;
        }

        // Set as root visual content
        hr = rootVisual->SetContent(swapChain.Get());
        if (FAILED(hr)) return false;

        hr = dcompDevice->Commit();
        if (FAILED(hr)) return false;

        surfaceWidth = width;
        surfaceHeight = height;
        zeroCopyMode = true;
        printf("[DComp] Swap chain created on external D3D11 device (%dx%d)\n", width, height);
        return true;
    }

    // Zero-copy present: copy source D3D11 texture to swap chain back buffer.
    // sourceTexture must be on the same D3D11 device as the swap chain.
    bool zeroCopyPresent(ID3D11Texture2D* sourceTexture) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!swapChain || !externalD3dContext) return false;

        ComPtr<ID3D11Texture2D> backBuffer;
        HRESULT hr = swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer));
        if (FAILED(hr)) {
            printf("[DComp] zeroCopyPresent: GetBuffer failed: 0x%08lx\n", hr);
            return false;
        }

        externalD3dContext->CopyResource(backBuffer.Get(), sourceTexture);

        hr = swapChain->Present(0, 0);
        if (FAILED(hr)) {
            printf("[DComp] zeroCopyPresent: Present failed: 0x%08lx\n", hr);
            return false;
        }

        return SUCCEEDED(dcompDevice->Commit());
    }

    // Just Present + Commit (when the copy was already done externally).
    bool presentOnly() {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!swapChain || !dcompDevice) return false;

        HRESULT hr = swapChain->Present(0, 0);
        if (FAILED(hr)) return false;

        return SUCCEEDED(dcompDevice->Commit());
    }

    bool isZeroCopyMode() const { return zeroCopyMode; }

    // Get the external D3D11 device context (for D3D11On12 acquire/release).
    ID3D11DeviceContext* getExternalD3dContext() const { return externalD3dContext.Get(); }
    ID3D11Device* getExternalD3dDevice() const { return externalD3dDevice.Get(); }

    // ========================================================================
    // Phase 2: Solid color render
    // ========================================================================

    // Render a solid color to the composition surface.
    // Color values are 0.0-1.0, alpha-premultiplied for DirectComposition.
    bool renderSolidColor(float r, float g, float b, float a) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!initialized || !swapChain || !d3dDevice) return false;

        ComPtr<ID3D11Texture2D> backBuffer;
        HRESULT hr = swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer));
        if (FAILED(hr)) return false;

        ComPtr<ID3D11RenderTargetView> rtv;
        hr = d3dDevice->CreateRenderTargetView(backBuffer.Get(), nullptr, &rtv);
        if (FAILED(hr)) return false;

        float clearColor[4] = { r * a, g * a, b * a, a };
        d3dContext->ClearRenderTargetView(rtv.Get(), clearColor);

        hr = swapChain->Present(1, 0);
        if (FAILED(hr)) return false;

        return SUCCEEDED(dcompDevice->Commit());
    }

    // ========================================================================
    // Phase 3: D3D11 triangle rendering through DComp swap chain
    // ========================================================================

    // Initialize the D3D11 rendering pipeline for triangle rendering.
    bool initTrianglePipeline() {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!initialized || !d3dDevice) return false;
        if (trianglePipelineReady) return true;

        // Compile vertex shader
        ComPtr<ID3DBlob> vsBlob, vsErrors;
        HRESULT hr = D3DCompile(
            kDCompVertexShader, strlen(kDCompVertexShader),
            "DCompVS", nullptr, nullptr,
            "main", "vs_5_0", 0, 0,
            &vsBlob, &vsErrors);
        if (FAILED(hr)) {
            if (vsErrors) printf("[DComp] VS compile error: %s\n", (char*)vsErrors->GetBufferPointer());
            return false;
        }

        hr = d3dDevice->CreateVertexShader(
            vsBlob->GetBufferPointer(), vsBlob->GetBufferSize(),
            nullptr, &vertexShader);
        if (FAILED(hr)) return false;

        // Compile pixel shader
        ComPtr<ID3DBlob> psBlob, psErrors;
        hr = D3DCompile(
            kDCompPixelShader, strlen(kDCompPixelShader),
            "DCompPS", nullptr, nullptr,
            "main", "ps_5_0", 0, 0,
            &psBlob, &psErrors);
        if (FAILED(hr)) {
            if (psErrors) printf("[DComp] PS compile error: %s\n", (char*)psErrors->GetBufferPointer());
            return false;
        }

        hr = d3dDevice->CreatePixelShader(
            psBlob->GetBufferPointer(), psBlob->GetBufferSize(),
            nullptr, &pixelShader);
        if (FAILED(hr)) return false;

        // Create input layout
        D3D11_INPUT_ELEMENT_DESC layout[] = {
            { "POSITION", 0, DXGI_FORMAT_R32G32_FLOAT,    0, 0,                            D3D11_INPUT_PER_VERTEX_DATA, 0 },
            { "COLOR",    0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, D3D11_APPEND_ALIGNED_ELEMENT, D3D11_INPUT_PER_VERTEX_DATA, 0 },
        };
        hr = d3dDevice->CreateInputLayout(
            layout, 2,
            vsBlob->GetBufferPointer(), vsBlob->GetBufferSize(),
            &inputLayout);
        if (FAILED(hr)) return false;

        // Create vertex buffer with a colored triangle
        DCompVertex vertices[] = {
            {  0.0f,  0.5f,  0.1f, 0.9f, 0.4f, 1.0f },  // Top — green
            {  0.5f, -0.5f,  0.9f, 0.1f, 0.1f, 1.0f },  // Right — red
            { -0.5f, -0.5f,  0.1f, 0.3f, 0.9f, 1.0f },  // Left — blue
        };

        D3D11_BUFFER_DESC vbDesc = {};
        vbDesc.ByteWidth = sizeof(vertices);
        vbDesc.Usage = D3D11_USAGE_DYNAMIC;
        vbDesc.BindFlags = D3D11_BIND_VERTEX_BUFFER;
        vbDesc.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;

        D3D11_SUBRESOURCE_DATA initData = {};
        initData.pSysMem = vertices;

        hr = d3dDevice->CreateBuffer(&vbDesc, &initData, &vertexBuffer);
        if (FAILED(hr)) return false;

        // Create blend state for premultiplied alpha
        D3D11_BLEND_DESC blendDesc = {};
        blendDesc.RenderTarget[0].BlendEnable = TRUE;
        blendDesc.RenderTarget[0].SrcBlend = D3D11_BLEND_ONE;
        blendDesc.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
        blendDesc.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
        blendDesc.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE;
        blendDesc.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
        blendDesc.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
        blendDesc.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;

        hr = d3dDevice->CreateBlendState(&blendDesc, &blendState);
        if (FAILED(hr)) return false;

        printf("[DComp] Triangle pipeline initialized\n");
        trianglePipelineReady = true;
        return true;
    }

    // Render a single frame of the triangle to the DComp swap chain.
    // angle controls rotation (radians). Pass 0 for static triangle.
    bool renderTriangle(float angle) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!trianglePipelineReady || !swapChain || !d3dDevice) return false;

        // Update vertex positions with rotation
        float cosA = cosf(angle);
        float sinA = sinf(angle);

        DCompVertex baseVerts[] = {
            {  0.0f,  0.5f,  0.1f, 0.9f, 0.4f, 1.0f },
            {  0.5f, -0.5f,  0.9f, 0.1f, 0.1f, 1.0f },
            { -0.5f, -0.5f,  0.1f, 0.3f, 0.9f, 1.0f },
        };

        // Rotate vertices
        D3D11_MAPPED_SUBRESOURCE mapped;
        HRESULT hr = d3dContext->Map(vertexBuffer.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped);
        if (FAILED(hr)) return false;

        DCompVertex* verts = (DCompVertex*)mapped.pData;
        for (int i = 0; i < 3; i++) {
            float x = baseVerts[i].x;
            float y = baseVerts[i].y;
            verts[i].x = x * cosA - y * sinA;
            verts[i].y = x * sinA + y * cosA;
            verts[i].r = baseVerts[i].r;
            verts[i].g = baseVerts[i].g;
            verts[i].b = baseVerts[i].b;
            verts[i].a = baseVerts[i].a;
        }
        d3dContext->Unmap(vertexBuffer.Get(), 0);

        // Get back buffer
        ComPtr<ID3D11Texture2D> backBuffer;
        hr = swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer));
        if (FAILED(hr)) return false;

        ComPtr<ID3D11RenderTargetView> rtv;
        hr = d3dDevice->CreateRenderTargetView(backBuffer.Get(), nullptr, &rtv);
        if (FAILED(hr)) return false;

        // Set up pipeline
        d3dContext->OMSetRenderTargets(1, rtv.GetAddressOf(), nullptr);

        float blendFactor[4] = { 0, 0, 0, 0 };
        d3dContext->OMSetBlendState(blendState.Get(), blendFactor, 0xFFFFFFFF);

        D3D11_VIEWPORT viewport = {};
        viewport.Width = (float)surfaceWidth;
        viewport.Height = (float)surfaceHeight;
        viewport.MaxDepth = 1.0f;
        d3dContext->RSSetViewports(1, &viewport);

        // Clear to transparent (premultiplied alpha)
        float clearColor[4] = { 0.05f, 0.05f, 0.1f, 1.0f };
        d3dContext->ClearRenderTargetView(rtv.Get(), clearColor);

        // Draw triangle
        d3dContext->IASetInputLayout(inputLayout.Get());
        d3dContext->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);

        UINT stride = sizeof(DCompVertex);
        UINT offset = 0;
        d3dContext->IASetVertexBuffers(0, 1, vertexBuffer.GetAddressOf(), &stride, &offset);

        d3dContext->VSSetShader(vertexShader.Get(), nullptr, 0);
        d3dContext->PSSetShader(pixelShader.Get(), nullptr, 0);

        d3dContext->Draw(3, 0);

        // Present and commit
        hr = swapChain->Present(1, 0);
        if (FAILED(hr)) return false;

        return SUCCEEDED(dcompDevice->Commit());
    }

    // ========================================================================
    // WGPU Bridge: blit raw pixels to the DComp swap chain
    // ========================================================================

    // Accept raw BGRA pixel data and write it to the DComp swap chain.
    // Called once per frame from the Three.js render loop after WGPU readback.
    // pixelData must be width*height*4 bytes, BGRA format (matching swap chain).
    bool blitFromPixels(const void* pixelData, int width, int height) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!initialized || !swapChain || !d3dDevice || !d3dContext) return false;
        if (!pixelData || width <= 0 || height <= 0) return false;

        // Resize swap chain if dimensions changed
        if (width != surfaceWidth || height != surfaceHeight) {
            if (!resize(width, height)) {
                return false;
            }
        }

        // Get back buffer
        ComPtr<ID3D11Texture2D> backBuffer;
        HRESULT hr = swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer));
        if (FAILED(hr)) {
            printf("[DComp] blitFromPixels: GetBuffer failed: 0x%08lx\n", hr);
            return false;
        }

        // Upload pixel data directly to the back buffer
        UINT rowPitch = width * 4;
        d3dContext->UpdateSubresource(
            backBuffer.Get(),
            0,          // subresource
            nullptr,    // full texture
            pixelData,
            rowPitch,   // bytes per row
            0           // depth pitch (unused for 2D)
        );

        // Present without vsync — DComp handles frame scheduling
        hr = swapChain->Present(0, 0);
        if (FAILED(hr)) {
            printf("[DComp] blitFromPixels: Present failed: 0x%08lx\n", hr);
            return false;
        }

        hr = dcompDevice->Commit();
        if (FAILED(hr)) {
            printf("[DComp] blitFromPixels: Commit failed: 0x%08lx\n", hr);
            return false;
        }

        return true;
    }

    // ========================================================================
    // Phase 3: WGPU child visual support (Option C)
    // ========================================================================

    // Create a child HWND suitable for WGPU surface creation, positioned within
    // the DComp target window. WGPU creates its surface from this child HWND
    // normally — the child HWND content appears in the DComp target window.
    HWND createWGPUChildHwnd(int x, int y, int w, int h) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!initialized || !targetHwnd) return NULL;

        // Register a minimal window class for the WGPU child
        static bool classRegistered = false;
        if (!classRegistered) {
            WNDCLASSA wc = {};
            wc.lpfnWndProc = DefWindowProcA;
            wc.hInstance = GetModuleHandle(NULL);
            wc.lpszClassName = "DCompWGPUChild";
            RegisterClassA(&wc);
            classRegistered = true;
        }

        HWND child = CreateWindowExA(
            0,
            "DCompWGPUChild",
            "",
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            x, y, w, h,
            targetHwnd,
            NULL,
            GetModuleHandle(NULL),
            NULL
        );

        if (child) {
            wgpuChildHwnd = child;
            printf("[DComp] Created WGPU child HWND=%p at (%d,%d %dx%d)\n", child, x, y, w, h);
        } else {
            printf("[DComp] Failed to create WGPU child HWND\n");
        }
        return child;
    }

    // ========================================================================
    // Phase 4: WebView2 + WGPU compositing via visual tree
    // ========================================================================

    // Build the full DComp visual tree for layered compositing:
    //
    //   DirectComposition Device
    //   +-- Composition Target (main HWND)
    //       +-- Root Visual
    //           +-- WGPU Visual (GPU content, back layer)
    //           |   +-- content: WGPU swap chain or child HWND surface
    //           +-- WebView2 Visual (HTML UI, front layer, transparent BG)
    //               +-- content: WebView2 composition surface
    //
    // Call after init() and after WebView2 creation.
    bool setupLayeredVisualTree(
        IDXGISwapChain1* wgpuSwapChain,   // WGPU layer content (can be nullptr for child HWND mode)
        IUnknown* webview2Surface           // WebView2 composition surface (from ICoreWebView2CompositionController)
    ) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!initialized || !dcompDevice) return false;

        HRESULT hr;

        layeredTreeActive = false;
        wgpuVisual.Reset();
        webview2Visual.Reset();
        wgpuClip.Reset();
        webview2Clip.Reset();

        // Create WGPU visual (back layer)
        hr = dcompDevice->CreateVisual(&wgpuVisual);
        if (FAILED(hr)) {
            printf("[DComp] CreateVisual (WGPU) failed: 0x%08lx\n", hr);
            return false;
        }
        hr = dcompDevice->CreateRectangleClip(&wgpuClip);
        if (FAILED(hr)) {
            printf("[DComp] CreateRectangleClip (WGPU) failed: 0x%08lx\n", hr);
            return false;
        }
        hr = wgpuVisual->SetClip(wgpuClip.Get());
        if (FAILED(hr)) {
            printf("[DComp] SetClip (WGPU) failed: 0x%08lx\n", hr);
            return false;
        }
        updateVisualClip(wgpuClip.Get(), (float)surfaceWidth, (float)surfaceHeight);

        // Set WGPU content: either a swap chain or leave empty for child HWND mode
        if (wgpuSwapChain) {
            hr = wgpuVisual->SetContent(wgpuSwapChain);
            if (FAILED(hr)) {
                printf("[DComp] SetContent (WGPU swap chain) failed: 0x%08lx\n", hr);
                return false;
            }
        }

        // Create WebView2 visual (front layer, rendered on top)
        hr = dcompDevice->CreateVisual(&webview2Visual);
        if (FAILED(hr)) {
            printf("[DComp] CreateVisual (WebView2) failed: 0x%08lx\n", hr);
            return false;
        }
        hr = dcompDevice->CreateRectangleClip(&webview2Clip);
        if (FAILED(hr)) {
            printf("[DComp] CreateRectangleClip (WebView2) failed: 0x%08lx\n", hr);
            return false;
        }
        hr = webview2Visual->SetClip(webview2Clip.Get());
        if (FAILED(hr)) {
            printf("[DComp] SetClip (WebView2) failed: 0x%08lx\n", hr);
            return false;
        }
        updateVisualClip(webview2Clip.Get(), (float)surfaceWidth, (float)surfaceHeight);

        if (webview2Surface) {
            hr = webview2Visual->SetContent(webview2Surface);
            if (FAILED(hr)) {
                printf("[DComp] SetContent (WebView2 surface) failed: 0x%08lx\n", hr);
                return false;
            }
        }

        // Remove existing root content and rebuild visual tree
        rootVisual->SetContent(nullptr);

        // Add WGPU visual first (back layer)
        hr = rootVisual->AddVisual(wgpuVisual.Get(), TRUE, nullptr);
        if (FAILED(hr)) {
            printf("[DComp] AddVisual (WGPU) failed: 0x%08lx\n", hr);
            return false;
        }

        // Add WebView2 visual on top (front layer)
        hr = rootVisual->AddVisual(webview2Visual.Get(), TRUE, wgpuVisual.Get());
        if (FAILED(hr)) {
            printf("[DComp] AddVisual (WebView2) failed: 0x%08lx\n", hr);
            return false;
        }

        hr = dcompDevice->Commit();
        if (FAILED(hr)) {
            printf("[DComp] Commit (layered tree) failed: 0x%08lx\n", hr);
            return false;
        }

        printf("[DComp] Layered visual tree: WGPU (back) + WebView2 (front)\n");
        layeredTreeActive = true;
        return true;
    }

    // Set/update the WebView2 composition surface on the WebView2 visual.
    bool setWebView2Content(IUnknown* surface) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!webview2Visual) return false;
        HRESULT hr = webview2Visual->SetContent(surface);
        if (FAILED(hr)) return false;
        return SUCCEEDED(dcompDevice->Commit());
    }

    // Set/update the WGPU swap chain on the WGPU visual.
    bool setWGPUContent(IDXGISwapChain1* wgpuSwapChain) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!wgpuVisual) return false;
        HRESULT hr = wgpuVisual->SetContent(wgpuSwapChain);
        if (FAILED(hr)) return false;
        return SUCCEEDED(dcompDevice->Commit());
    }

    bool attachWebView2Controller(ICoreWebView2CompositionController* ctrl) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!initialized || !dcompDevice || !webview2Visual || !ctrl) return false;
        HRESULT hr = ctrl->put_RootVisualTarget(webview2Visual.Get());
        if (FAILED(hr)) {
            printf("[DComp] put_RootVisualTarget failed: 0x%08lx\n", hr);
            return false;
        }
        compController = ctrl;
        hr = dcompDevice->Commit();
        if (FAILED(hr)) {
            printf("[DComp] Commit (attach WebView2) failed: 0x%08lx\n", hr);
            return false;
        }
        printf("[DComp] WebView2 composition controller attached to visual tree\n");
        return true;
    }

    // Update visual positions and sizes (for resize synchronization).
    bool updateVisualBounds(
        float wgpuX, float wgpuY, float wgpuW, float wgpuH,
        float wv2X, float wv2Y, float wv2W, float wv2H
    ) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!initialized) return false;
        HRESULT hr;

        if (wgpuVisual) {
            wgpuVisual->SetOffsetX(wgpuX);
            wgpuVisual->SetOffsetY(wgpuY);
            updateVisualClip(wgpuClip.Get(), wgpuW, wgpuH);
        }

        if (webview2Visual) {
            webview2Visual->SetOffsetX(wv2X);
            webview2Visual->SetOffsetY(wv2Y);
            updateVisualClip(webview2Clip.Get(), wv2W, wv2H);
        }

        hr = dcompDevice->Commit();
        return SUCCEEDED(hr);
    }

    // Check if the layered visual tree is active.
    bool isLayeredTreeActive() const { return layeredTreeActive; }

    // Get the DComp visual for WebView2 (for cursor/input routing).
    IDCompositionVisual* getWebView2Visual() const { return webview2Visual.Get(); }
    IDCompositionVisual* getWGPUVisual() const { return wgpuVisual.Get(); }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    // Enable bridge mode: skip render-on-resize (WGPU blitFromPixels handles it)
    void setBridgeMode(bool enabled) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        bridgeMode = enabled;
        printf("[DComp] Bridge mode %s\n", enabled ? "enabled" : "disabled");
    }

    bool isBridgeMode() const { return bridgeMode; }

    bool resize(int newWidth, int newHeight) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!initialized || !swapChain) return false;
        if (newWidth <= 0 || newHeight <= 0) return false;
        if (newWidth == surfaceWidth && newHeight == surfaceHeight) return true;

        auto* ctx = externalD3dContext ? externalD3dContext.Get() : d3dContext.Get();
        if (ctx) {
            ctx->ClearState();
            ctx->Flush();
        }

        HRESULT hr = swapChain->ResizeBuffers(
            2, newWidth, newHeight,
            DXGI_FORMAT_B8G8R8A8_UNORM, 0);
        if (FAILED(hr)) {
            printf("[DComp] ResizeBuffers failed: 0x%08lx\n", hr);
            return false;
        }

        surfaceWidth = newWidth;
        surfaceHeight = newHeight;
        updateVisualClip(wgpuClip.Get(), (float)newWidth, (float)newHeight);
        updateVisualClip(webview2Clip.Get(), (float)newWidth, (float)newHeight);

        // In bridge mode, skip the immediate render — the next blitFromPixels
        // call will fill the swap chain with the correct WGPU content.
        if (bridgeMode) {
            dcompDevice->Commit();
            return true;
        }

        // Non-bridge mode: render a frame immediately after resize to avoid blank gap
        if (trianglePipelineReady) {
            renderTriangle(renderAngle);
        } else {
            ComPtr<ID3D11Texture2D> bb;
            if (SUCCEEDED(swapChain->GetBuffer(0, IID_PPV_ARGS(&bb)))) {
                ComPtr<ID3D11RenderTargetView> rtv;
                if (SUCCEEDED(d3dDevice->CreateRenderTargetView(bb.Get(), nullptr, &rtv))) {
                    float c[4] = { 0.05f, 0.05f, 0.1f, 1.0f };
                    d3dContext->ClearRenderTargetView(rtv.Get(), c);
                    swapChain->Present(0, 0);
                }
            }
        }

        dcompDevice->Commit();
        return true;
    }

    // Enable native resize tracking: subclass the target HWND to intercept
    // WM_SIZE and auto-resize the swap chain without TS FFI round-trip.
    void enableNativeResize() {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!initialized || !targetHwnd || nativeResizeHooked) return;

        // Store this pointer for the subclass callback
        SetPropA(targetHwnd, "DCompCompositor", (HANDLE)this);

        SetWindowSubclass(targetHwnd, resizeSubclassProc, 1, (DWORD_PTR)this);
        nativeResizeHooked = true;
        printf("[DComp] Native resize hook installed\n");
    }

    void disableNativeResize() {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!nativeResizeHooked || !targetHwnd) return;
        RemoveWindowSubclass(targetHwnd, resizeSubclassProc, 1);
        RemovePropA(targetHwnd, "DCompCompositor");
        nativeResizeHooked = false;
    }

    void shutdown() {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!initialized) return;

        // Stop render loop
        stopRenderLoop();

        // Remove native resize hook
        disableNativeResize();

        // Destroy WGPU child
        if (wgpuChildHwnd && IsWindow(wgpuChildHwnd)) {
            DestroyWindow(wgpuChildHwnd);
            wgpuChildHwnd = NULL;
        }

        // Release Phase 4 layered visuals
        wgpuClip.Reset();
        webview2Clip.Reset();
        webview2Visual.Reset();
        wgpuVisual.Reset();
        layeredTreeActive = false;

        // Release triangle pipeline
        blendState.Reset();
        vertexBuffer.Reset();
        inputLayout.Reset();
        pixelShader.Reset();
        vertexShader.Reset();
        trianglePipelineReady = false;

        // Release DComp
        if (dcompTarget) dcompTarget->SetRoot(nullptr);
        if (dcompDevice) dcompDevice->Commit();

        rootVisual.Reset();
        dcompTarget.Reset();
        dcompDevice.Reset();
        swapChain.Reset();

        // Release external device (zero-copy bridge)
        externalD3dContext.Reset();
        externalD3dDevice.Reset();
        zeroCopyMode = false;

        d3dContext.Reset();
        d3dDevice.Reset();
        dxgiFactory.Reset();

        initialized = false;
        printf("[DComp] Shutdown complete\n");
    }

    bool isInitialized() const { return initialized; }

    // ========================================================================
    // Render loop (60 FPS timer-driven, matching Electrobun's WGPU test pattern)
    // ========================================================================

    void startRenderLoop() {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (renderLoopActive) return;
        renderLoopActive = true;
        renderAngle = 0.0f;
        // 16ms timer ≈ 60 FPS
        renderTimerId = SetTimer(NULL, 0, 16, renderTimerProc);
        printf("[DComp] Render loop started (timer=%llu)\n", (unsigned long long)renderTimerId);
    }

    void stopRenderLoop() {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!renderLoopActive) return;
        renderLoopActive = false;
        if (renderTimerId) {
            KillTimer(NULL, renderTimerId);
            renderTimerId = 0;
        }
        printf("[DComp] Render loop stopped\n");
    }

    bool isRenderLoopActive() const { return renderLoopActive; }

    // Accessors for integration
    IDCompositionDevice* getDCompDevice() const { return dcompDevice.Get(); }
    IDCompositionVisual* getRootVisual() const { return rootVisual.Get(); }
    IDXGISwapChain1* getSwapChain() const { return swapChain.Get(); }
    ID3D11Device* getD3DDevice() const { return d3dDevice.Get(); }
    HWND getTargetHwnd() const { return targetHwnd; }
    HWND getWGPUChildHwnd() const { return wgpuChildHwnd; }

    // Phase 4: Add a child visual to the composition tree
    bool addChildVisual(IDCompositionVisual* child) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!initialized || !rootVisual) return false;
        HRESULT hr = rootVisual->AddVisual(child, TRUE, nullptr);
        if (FAILED(hr)) {
            printf("[DComp] AddVisual failed: 0x%08lx\n", hr);
            return false;
        }
        return true;
    }

    bool commit() {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        if (!dcompDevice) return false;
        return SUCCEEDED(dcompDevice->Commit());
    }

    // Set the WebView2 composition controller for mouse input forwarding.
    // Called after CreateCoreWebView2CompositionController succeeds.
    void setCompositionController(ICoreWebView2CompositionController* ctrl) {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        compController = ctrl;
        printf("[DComp] WebView2 composition controller registered for input forwarding\n");
    }

    // Benchmark: measure frame time for the last rendered frame
    double getLastFrameTimeMs() const {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        return lastFrameTimeMs;
    }
    uint64_t getFrameCount() const {
        std::lock_guard<std::recursive_mutex> lock(stateMutex);
        return frameCount;
    }

private:
    HWND targetHwnd = NULL;
    int surfaceWidth = 0;
    int surfaceHeight = 0;
    bool initialized = false;

    // D3D11
    ComPtr<ID3D11Device> d3dDevice;
    ComPtr<ID3D11DeviceContext> d3dContext;

    // DXGI
    ComPtr<IDXGIFactory2> dxgiFactory;
    ComPtr<IDXGISwapChain1> swapChain;

    // DirectComposition visual tree
    ComPtr<IDCompositionDevice> dcompDevice;
    ComPtr<IDCompositionTarget> dcompTarget;
    ComPtr<IDCompositionVisual> rootVisual;

    // Phase 3: Triangle pipeline
    ComPtr<ID3D11VertexShader> vertexShader;
    ComPtr<ID3D11PixelShader> pixelShader;
    ComPtr<ID3D11InputLayout> inputLayout;
    ComPtr<ID3D11Buffer> vertexBuffer;
    ComPtr<ID3D11BlendState> blendState;
    bool trianglePipelineReady = false;

    // Phase 3: WGPU child HWND
    HWND wgpuChildHwnd = NULL;

    // Native resize hook
    bool nativeResizeHooked = false;

    // Bridge mode: WGPU provides frames via blitFromPixels, skip render-on-resize
    bool bridgeMode = false;

    // Zero-copy mode: swap chain created on Dawn's D3D11On12 device
    bool zeroCopyMode = false;

    // External D3D11 device (D3D11On12 from Dawn, for zero-copy bridge)
    ComPtr<ID3D11Device> externalD3dDevice;
    ComPtr<ID3D11DeviceContext> externalD3dContext;

    // WebView2 composition controller (for mouse input forwarding)
    ComPtr<ICoreWebView2CompositionController> compController;

    // Phase 4: Layered visual tree (WGPU + WebView2)
    ComPtr<IDCompositionVisual> wgpuVisual;
    ComPtr<IDCompositionVisual> webview2Visual;
    ComPtr<IDCompositionRectangleClip> wgpuClip;
    ComPtr<IDCompositionRectangleClip> webview2Clip;
    bool layeredTreeActive = false;

    // Render loop
    bool renderLoopActive = false;
    UINT_PTR renderTimerId = 0;
    float renderAngle = 0.0f;

    // Benchmark
    double lastFrameTimeMs = 0.0;
    uint64_t frameCount = 0;
    mutable std::recursive_mutex stateMutex;

    void enableMultithreadProtection(ID3D11DeviceContext* context, const char* label) {
        if (!context) return;
        ComPtr<ID3D11Multithread> multithread;
        HRESULT hr = context->QueryInterface(IID_PPV_ARGS(&multithread));
        if (SUCCEEDED(hr) && multithread) {
            multithread->SetMultithreadProtected(TRUE);
            printf("[DComp] Enabled D3D11 multithread protection for %s context\n", label);
        }
    }

    void updateVisualClip(IDCompositionRectangleClip* clip, float width, float height) {
        if (!clip) return;
        float clippedWidth = width > 0.0f ? width : 0.0f;
        float clippedHeight = height > 0.0f ? height : 0.0f;
        clip->SetLeft(0.0f);
        clip->SetTop(0.0f);
        clip->SetRight(clippedWidth);
        clip->SetBottom(clippedHeight);
    }

    // Native subclass — handles WM_SIZE and forwards mouse events to
    // WebView2 composition controller when in DComp mode.
    static LRESULT CALLBACK resizeSubclassProc(
        HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam,
        UINT_PTR subclassId, DWORD_PTR refData
    ) {
        auto* self = (DCompCompositor*)refData;

        if (msg == WM_SIZE && wParam != SIZE_MINIMIZED) {
            int w = LOWORD(lParam);
            int h = HIWORD(lParam);
            if (self && self->isInitialized() && !self->isZeroCopyMode() && w > 0 && h > 0) {
                self->resize(w, h);
            }
        }

        // Forward mouse events to the WebView2 composition controller
        // (composition controllers don't have their own HWND, so they need
        // explicit mouse input routing from the parent window)
        ComPtr<ICoreWebView2CompositionController> compController;
        if (self) {
            std::lock_guard<std::recursive_mutex> lock(self->stateMutex);
            compController = self->compController;
        }
        if (compController) {
            COREWEBVIEW2_MOUSE_EVENT_KIND mouseKind = (COREWEBVIEW2_MOUSE_EVENT_KIND)0;
            bool isMouse = true;

            switch (msg) {
                case WM_MOUSEMOVE:    mouseKind = COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE; break;
                case WM_LBUTTONDOWN:  mouseKind = COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN; break;
                case WM_LBUTTONUP:    mouseKind = COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP; break;
                case WM_LBUTTONDBLCLK: mouseKind = COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOUBLE_CLICK; break;
                case WM_RBUTTONDOWN:  mouseKind = COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN; break;
                case WM_RBUTTONUP:    mouseKind = COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP; break;
                case WM_MOUSEWHEEL:   mouseKind = COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL; break;
                case WM_MOUSELEAVE:   mouseKind = COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE; break;
                default: isMouse = false; break;
            }

            if (isMouse && mouseKind != (COREWEBVIEW2_MOUSE_EVENT_KIND)0) {
                POINT pt = { GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam) };
                COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS vkeys = COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE;
                if (wParam & MK_CONTROL) vkeys = (COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS)(vkeys | COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_CONTROL);
                if (wParam & MK_SHIFT)   vkeys = (COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS)(vkeys | COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_SHIFT);

                UINT mouseData = 0;
                if (msg == WM_MOUSEWHEEL) mouseData = GET_WHEEL_DELTA_WPARAM(wParam);

                compController->SendMouseInput(mouseKind, vkeys, mouseData, pt);
            }
        }

        return DefSubclassProc(hwnd, msg, wParam, lParam);
    }

    // Timer callback for render loop (static, dispatches to global compositor)
    static void CALLBACK renderTimerProc(HWND, UINT, UINT_PTR, DWORD) {
        // Access the global compositor (defined in nativeWrapper.cpp)
        extern DCompCompositor* g_dcompCompositor;
        auto* compositor = g_dcompCompositor;
        if (!compositor || !compositor->isInitialized()) return;

        auto start = std::chrono::high_resolution_clock::now();
        float angle = 0.0f;
        {
            std::lock_guard<std::recursive_mutex> lock(compositor->stateMutex);
            compositor->renderAngle += 0.02f;
            angle = compositor->renderAngle;
        }
        compositor->renderTriangle(angle);

        auto end = std::chrono::high_resolution_clock::now();
        uint64_t frameCountSnapshot = 0;
        double frameTimeMs =
            std::chrono::duration<double, std::milli>(end - start).count();
        {
            std::lock_guard<std::recursive_mutex> lock(compositor->stateMutex);
            compositor->lastFrameTimeMs = frameTimeMs;
            compositor->frameCount++;
            frameCountSnapshot = compositor->frameCount;
        }

        // Log every 60 frames (~1 second)
        if (frameCountSnapshot % 60 == 0) {
            printf("[DComp] Frame %llu, last frame: %.2fms\n",
                   (unsigned long long)frameCountSnapshot,
                   frameTimeMs);
        }
    }
};
