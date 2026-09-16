// dcomp_compositor.h — DirectComposition GPU surface compositor for Windows
//
// Provides zero-copy GPU compositing using DirectComposition + DXGI swap chain.
// This matches the macOS CAMetalLayer compositing pattern used in Electrobun
// for native GPU rendering.
//
// Usage: initMinimal() to create DComp visual tree, then initSwapChainFromDevice()
// once Dawn's D3D11On12 device is available. Frames are presented via
// zeroCopyPresent() or presentOnly().

#pragma once

#include <dcomp.h>
#include <dxgi1_2.h>
#include <dxgi1_4.h>
#include <d3d11.h>
#include <d3d11_4.h>
#include <d3d11on12.h>
#include <d3d12.h>
#include <wrl.h>
#include <cstdio>

#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "d3d12.lib")

#include <versionhelpers.h>

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
                // OS version check done
                cached = ok ? 1 : 0;
                return ok;
            }
        }
    }

    // Fallback: assume available on modern Windows
    // Could not detect OS version, assuming DComp available
    cached = 1;
    return true;
}

class DCompCompositor {
public:
    // Minimal init: DComp visual tree only, no rendering device or swap chain.
    // The swap chain is created later via initSwapChainFromDevice() once Dawn's
    // D3D11On12 device is available.
    bool initMinimal(HWND hwnd, int width, int height) {
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

        // Minimal init done
        initialized = true;
        return true;
    }

    // Create a swap chain on an external D3D11 device (e.g., Dawn's D3D11On12).
    // Call after initMinimal() + Dawn device creation.
    bool initSwapChainFromDevice(ID3D11Device* externalDevice, int width, int height) {
        if (!initialized || !dcompDevice || !rootVisual) return false;
        if (!externalDevice) return false;

        // Store the external device for blit/present operations
        externalD3dDevice = externalDevice;
        externalDevice->GetImmediateContext(&externalD3dContext);

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
        // Swap chain created
        return true;
    }

    // Zero-copy present: copy source D3D11 texture to swap chain back buffer.
    // sourceTexture must be on the same D3D11 device as the swap chain.
    bool zeroCopyPresent(ID3D11Texture2D* sourceTexture) {
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
        if (!swapChain || !dcompDevice) return false;

        HRESULT hr = swapChain->Present(0, 0);
        if (FAILED(hr)) return false;

        return SUCCEEDED(dcompDevice->Commit());
    }

    bool resize(int newWidth, int newHeight) {
        if (!initialized || !swapChain) return false;
        if (newWidth <= 0 || newHeight <= 0) return false;
        if (newWidth == surfaceWidth && newHeight == surfaceHeight) return true;

        surfaceWidth = newWidth;
        surfaceHeight = newHeight;

        auto* ctx = externalD3dContext ? externalD3dContext.Get() : d3dContext.Get();
        if (ctx) {
            ctx->ClearState();
            ctx->Flush();
        }

        HRESULT hr = swapChain->ResizeBuffers(
            2, surfaceWidth, surfaceHeight,
            DXGI_FORMAT_B8G8R8A8_UNORM, 0);
        if (FAILED(hr)) {
            printf("[DComp] ResizeBuffers failed: 0x%08lx\n", hr);
            return false;
        }

        dcompDevice->Commit();
        return true;
    }

    // Enable native resize tracking: subclass the target HWND to intercept
    // WM_SIZE and auto-resize the swap chain without TS FFI round-trip.
    void enableNativeResize() {
        if (!initialized || !targetHwnd || nativeResizeHooked) return;

        // Store this pointer for the subclass callback
        SetPropA(targetHwnd, "DCompCompositor", (HANDLE)this);

        SetWindowSubclass(targetHwnd, resizeSubclassProc, 1, (DWORD_PTR)this);
        nativeResizeHooked = true;
        // Native resize hook installed
    }

    void disableNativeResize() {
        if (!nativeResizeHooked || !targetHwnd) return;
        RemoveWindowSubclass(targetHwnd, resizeSubclassProc, 1);
        RemovePropA(targetHwnd, "DCompCompositor");
        nativeResizeHooked = false;
    }

    void shutdown() {
        if (!initialized) return;

        // Remove native resize hook
        disableNativeResize();

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
        // Shutdown complete
    }

    // Accessors
    bool isInitialized() const { return initialized; }
    bool isZeroCopyMode() const { return zeroCopyMode; }
    IDXGISwapChain1* getSwapChain() const { return swapChain.Get(); }
    IDCompositionDevice* getDCompDevice() const { return dcompDevice.Get(); }
    HWND getTargetHwnd() const { return targetHwnd; }
    ID3D11DeviceContext* getExternalD3dContext() const { return externalD3dContext.Get(); }
    ID3D11Device* getExternalD3dDevice() const { return externalD3dDevice.Get(); }

private:
    HWND targetHwnd = NULL;
    int surfaceWidth = 0;
    int surfaceHeight = 0;
    bool initialized = false;

    // D3D11 (fallback device for DComp init)
    ComPtr<ID3D11Device> d3dDevice;
    ComPtr<ID3D11DeviceContext> d3dContext;

    // DXGI
    ComPtr<IDXGIFactory2> dxgiFactory;
    ComPtr<IDXGISwapChain1> swapChain;

    // DirectComposition visual tree
    ComPtr<IDCompositionDevice> dcompDevice;
    ComPtr<IDCompositionTarget> dcompTarget;
    ComPtr<IDCompositionVisual> rootVisual;

    // External D3D11 device (D3D11On12 from Dawn, for zero-copy bridge)
    ComPtr<ID3D11Device> externalD3dDevice;
    ComPtr<ID3D11DeviceContext> externalD3dContext;

    // Zero-copy mode: swap chain created on Dawn's D3D11On12 device
    bool zeroCopyMode = false;

    // Native resize hook
    bool nativeResizeHooked = false;

    // Native subclass — handles WM_SIZE for auto-resize of swap chain.
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

        return DefSubclassProc(hwnd, msg, wParam, lParam);
    }
};
