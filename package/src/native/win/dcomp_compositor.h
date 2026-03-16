// dcomp_compositor.h — DirectComposition GPU surface compositor for Windows
//
// Replaces UpdateLayeredWindow (CPU pixel copy) with zero-copy GPU compositing
// using DirectComposition + DXGI swap chain. This matches the macOS CAMetalLayer
// compositing pattern used in Electrobun for native GPU rendering.
//
// Phase 2: Prove the compositing pipeline with a solid color render.
// Phase 3: Replace D3D11 clear with WGPU triangle rendering.
// Phase 4: Layer WebView2 composition controller into the visual tree.

#pragma once

#include <dcomp.h>
#include <dxgi1_2.h>
#include <d3d11.h>
#include <wrl.h>
#include <cstdio>

#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3d11.lib")

using Microsoft::WRL::ComPtr;

class DCompCompositor {
public:
    // Initialize DirectComposition pipeline on an existing HWND.
    // Creates: D3D11 device -> DXGI swap chain (for composition) -> DComp visual tree
    bool init(HWND targetHwnd, int width, int height) {
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
        hr = dcompDevice->CreateTargetForHwnd(targetHwnd, TRUE, &dcompTarget);
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

    // Render a solid color to the composition surface (Phase 2 test).
    // Color values are 0.0-1.0, alpha-premultiplied for DirectComposition.
    bool renderSolidColor(float r, float g, float b, float a) {
        if (!initialized || !swapChain || !d3dDevice) return false;

        // Get back buffer from swap chain
        ComPtr<ID3D11Texture2D> backBuffer;
        HRESULT hr = swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer));
        if (FAILED(hr)) {
            printf("[DComp] GetBuffer failed: 0x%08lx\n", hr);
            return false;
        }

        // Create render target view for the back buffer
        ComPtr<ID3D11RenderTargetView> rtv;
        hr = d3dDevice->CreateRenderTargetView(backBuffer.Get(), nullptr, &rtv);
        if (FAILED(hr)) {
            printf("[DComp] CreateRenderTargetView failed: 0x%08lx\n", hr);
            return false;
        }

        // Clear to solid color (premultiplied alpha for DirectComposition)
        float clearColor[4] = { r * a, g * a, b * a, a };
        d3dContext->ClearRenderTargetView(rtv.Get(), clearColor);

        // Present and commit the composition
        hr = swapChain->Present(1, 0);
        if (FAILED(hr)) {
            printf("[DComp] Present failed: 0x%08lx\n", hr);
            return false;
        }

        hr = dcompDevice->Commit();
        if (FAILED(hr)) {
            printf("[DComp] Commit after present failed: 0x%08lx\n", hr);
            return false;
        }

        return true;
    }

    // Resize the composition surface (e.g. on window resize).
    bool resize(int newWidth, int newHeight) {
        if (!initialized || !swapChain) return false;
        if (newWidth <= 0 || newHeight <= 0) return false;

        surfaceWidth = newWidth;
        surfaceHeight = newHeight;

        // Release all references to back buffer before resizing
        d3dContext->ClearState();
        d3dContext->Flush();

        HRESULT hr = swapChain->ResizeBuffers(
            2, surfaceWidth, surfaceHeight,
            DXGI_FORMAT_B8G8R8A8_UNORM, 0);
        if (FAILED(hr)) {
            printf("[DComp] ResizeBuffers failed: 0x%08lx\n", hr);
            return false;
        }

        hr = dcompDevice->Commit();
        if (FAILED(hr)) {
            printf("[DComp] Commit after resize failed: 0x%08lx\n", hr);
            return false;
        }

        printf("[DComp] Resized to %dx%d\n", surfaceWidth, surfaceHeight);
        return true;
    }

    void shutdown() {
        if (!initialized) return;

        if (dcompTarget) dcompTarget->SetRoot(nullptr);
        if (dcompDevice) dcompDevice->Commit();

        rootVisual.Reset();
        dcompTarget.Reset();
        dcompDevice.Reset();
        swapChain.Reset();
        d3dContext.Reset();
        d3dDevice.Reset();
        dxgiFactory.Reset();

        initialized = false;
        printf("[DComp] Shutdown complete\n");
    }

    bool isInitialized() const { return initialized; }

    // Accessors for Phase 3+ (WGPU integration, visual tree layering)
    IDCompositionDevice* getDCompDevice() const { return dcompDevice.Get(); }
    IDCompositionVisual* getRootVisual() const { return rootVisual.Get(); }
    IDXGISwapChain1* getSwapChain() const { return swapChain.Get(); }
    ID3D11Device* getD3DDevice() const { return d3dDevice.Get(); }
    HWND getTargetHwnd() const { return targetHwnd; }

    // Phase 4: Add a child visual to the composition tree (for layering
    // WebView2 above/below WGPU content)
    bool addChildVisual(IDCompositionVisual* child) {
        if (!initialized || !rootVisual) return false;
        HRESULT hr = rootVisual->AddVisual(child, TRUE, nullptr);
        if (FAILED(hr)) {
            printf("[DComp] AddVisual failed: 0x%08lx\n", hr);
            return false;
        }
        return true;
    }

    bool commit() {
        if (!dcompDevice) return false;
        return SUCCEEDED(dcompDevice->Commit());
    }

private:
    HWND targetHwnd = NULL;
    int surfaceWidth = 0;
    int surfaceHeight = 0;
    bool initialized = false;

    // D3D11 (for creating DXGI swap chain + Phase 2 solid color render)
    ComPtr<ID3D11Device> d3dDevice;
    ComPtr<ID3D11DeviceContext> d3dContext;

    // DXGI
    ComPtr<IDXGIFactory2> dxgiFactory;
    ComPtr<IDXGISwapChain1> swapChain;

    // DirectComposition visual tree
    ComPtr<IDCompositionDevice> dcompDevice;
    ComPtr<IDCompositionTarget> dcompTarget;
    ComPtr<IDCompositionVisual> rootVisual;
};
