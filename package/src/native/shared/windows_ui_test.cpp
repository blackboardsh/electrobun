#include <algorithm>
#include <cassert>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

#include "windows_dialog_options.h"
#include "windows_dpi.h"
#include "windows_resource_paths.h"
#include "windows_utf.h"
#include <commctrl.h>

#ifdef _WIN32

static LRESULT CALLBACK testWindowProc(
    HWND hwnd,
    UINT message,
    WPARAM wParam,
    LPARAM lParam
) {
    return DefWindowProcW(hwnd, message, wParam, lParam);
}

struct TaskDialogProbe {
    DWORD processId = 0;
    std::wstring title;
    std::vector<std::wstring> labels;
    std::atomic<unsigned> labelsSeen{0};
    std::atomic<bool> clicked{false};
    std::atomic<HWND> dialog{nullptr};
};

static BOOL CALLBACK probeTaskDialogChild(HWND child, LPARAM context) {
    auto* probe = reinterpret_cast<TaskDialogProbe*>(context);
    wchar_t text[256] = {};
    GetWindowTextW(child, text, static_cast<int>(std::size(text)));
    for (size_t index = 0; index < probe->labels.size(); ++index) {
        if (probe->labels[index] == text) {
            probe->labelsSeen.fetch_or(1u << index);
        }
    }
    return TRUE;
}

static BOOL CALLBACK probeTaskDialogWindow(HWND window, LPARAM context) {
    auto* probe = reinterpret_cast<TaskDialogProbe*>(context);
    DWORD processId = 0;
    GetWindowThreadProcessId(window, &processId);
    if (processId != probe->processId) return TRUE;

    wchar_t title[256] = {};
    GetWindowTextW(window, title, static_cast<int>(std::size(title)));
    if (probe->title != title) return TRUE;

    probe->dialog.store(window);
    EnumChildWindows(window, probeTaskDialogChild, context);
    const unsigned expectedMask = (1u << probe->labels.size()) - 1u;
    if (probe->labelsSeen.load() == expectedMask) {
        probe->clicked.store(true);
        SendMessageW(
            window,
            TDM_CLICK_BUTTON,
            electrobun::windowsTaskDialogButtonId(1),
            0);
        return FALSE;
    }
    return TRUE;
}

int main(int argc, char** argv) {
    const std::string mixedUtf8 =
        "Bulgarian: \xD0\x91\xD1\x8A\xD0\xBB\xD0\xB3\xD0\xB0\xD1\x80\xD1\x81\xD0\xBA\xD0\xB8; "
        "Greek: \xCE\x95\xCE\xBB\xCE\xBB\xCE\xB7\xCE\xBD\xCE\xB9\xCE\xBA\xCE\xAC; "
        "CJK: \xE6\xB5\x8B\xE8\xAF\x95; caf\xC3\xA9; \xF0\x9F\xA7\xAA";
    std::wstring wideMixed;
    assert(electrobun::utf8ToWide(mixedUtf8, wideMixed));
    std::string roundTrip;
    assert(electrobun::wideToUtf8(wideMixed, roundTrip));
    assert(roundTrip == mixedUtf8);

    assert(electrobun::logicalToPhysicalPixel(800, 144) == 1200);
    assert(electrobun::physicalToLogicalPixel(1200, 144) == 800);
    const RECT dpr150Overlay =
        electrobun::logicalToPhysicalRect(100, 40, 800, 600, 144);
    assert(dpr150Overlay.left == 150);
    assert(dpr150Overlay.top == 60);
    assert(dpr150Overlay.right == 1350);
    assert(dpr150Overlay.bottom == 960);
    const RECT dpr200Overlay =
        electrobun::logicalToPhysicalRect(100, 40, 800, 600, 192);
    assert(dpr200Overlay.left == 200);
    assert(dpr200Overlay.top == 80);
    assert(dpr200Overlay.right == 1800);
    assert(dpr200Overlay.bottom == 1280);
    const RECT fractionalRect =
        electrobun::logicalToPhysicalRect(1, 1, 2, 2, 120);
    assert(fractionalRect.left == 1);
    assert(fractionalRect.top == 1);
    assert(fractionalRect.right == 4);
    assert(fractionalRect.bottom == 4);
    const RECT mixedMonitorPhysical =
        electrobun::logicalToPhysicalRect(-160, -80, 320, 240, 120);
    const RECT mixedMonitorLogical =
        electrobun::physicalToLogicalRect(mixedMonitorPhysical, 120);
    assert(mixedMonitorLogical.left == -160);
    assert(mixedMonitorLogical.top == -80);
    assert(mixedMonitorLogical.right == 160);
    assert(mixedMonitorLogical.bottom == 160);

    std::vector<electrobun::WindowsLogicalMonitor> syntheticMonitors(3);
    auto& leftMonitor = syntheticMonitors[0];
    leftMonitor.physicalBounds = {-3840, 0, 0, 2160};
    leftMonitor.physicalWorkArea = leftMonitor.physicalBounds;
    leftMonitor.dpi = 192;

    auto& primaryMonitor = syntheticMonitors[1];
    primaryMonitor.physicalBounds = {0, 0, 1920, 1080};
    primaryMonitor.physicalWorkArea = {0, 0, 1920, 1040};
    primaryMonitor.dpi = 96;
    primaryMonitor.primary = true;

    auto& rightMonitor = syntheticMonitors[2];
    rightMonitor.physicalBounds = {1920, 0, 5760, 2160};
    rightMonitor.physicalWorkArea = {1920, 80, 5760, 2080};
    rightMonitor.dpi = 192;

    electrobun::layoutWindowsLogicalMonitors(syntheticMonitors);
    assert(leftMonitor.logicalBounds.left == -1920);
    assert(leftMonitor.logicalBounds.top == 0);
    assert(leftMonitor.logicalBounds.right == primaryMonitor.logicalBounds.left);
    assert(leftMonitor.logicalBounds.bottom == 1080);
    assert(primaryMonitor.logicalBounds.left == 0);
    assert(primaryMonitor.logicalBounds.top == 0);
    assert(primaryMonitor.logicalBounds.right == 1920);
    assert(primaryMonitor.logicalBounds.bottom == 1080);
    assert(rightMonitor.logicalBounds.left == primaryMonitor.logicalBounds.right);
    assert(rightMonitor.logicalBounds.top == 0);
    assert(rightMonitor.logicalBounds.right == 3840);
    assert(rightMonitor.logicalBounds.bottom == 1080);
    assert(rightMonitor.logicalWorkArea.left == 1920);
    assert(rightMonitor.logicalWorkArea.top == 40);
    assert(rightMonitor.logicalWorkArea.right == 3840);
    assert(rightMonitor.logicalWorkArea.bottom == 1040);

    const auto assertPointRoundTrip = [](
        const electrobun::WindowsLogicalMonitor& monitor,
        const POINT& physical,
        const POINT& expectedLogical
    ) {
        const POINT logical = electrobun::physicalScreenPointToLogical(
            physical.x, physical.y, monitor);
        assert(logical.x == expectedLogical.x);
        assert(logical.y == expectedLogical.y);
        const POINT roundTrip = electrobun::logicalScreenPointToPhysical(
            logical.x, logical.y, monitor);
        assert(roundTrip.x == physical.x);
        assert(roundTrip.y == physical.y);
    };
    assertPointRoundTrip(primaryMonitor, {960, 540}, {960, 540});
    assertPointRoundTrip(leftMonitor, {-1920, 1080}, {-960, 540});
    assertPointRoundTrip(rightMonitor, {3840, 1080}, {2880, 540});

    const auto assertRectRoundTrip = [](
        const electrobun::WindowsLogicalMonitor& monitor,
        const RECT& physical,
        const RECT& expectedLogical
    ) {
        const POINT logicalOrigin = electrobun::physicalScreenPointToLogical(
            physical.left, physical.top, monitor);
        const RECT logical = {
            logicalOrigin.x,
            logicalOrigin.y,
            logicalOrigin.x + electrobun::physicalToLogicalSize(
                physical.right - physical.left, monitor.dpi),
            logicalOrigin.y + electrobun::physicalToLogicalSize(
                physical.bottom - physical.top, monitor.dpi),
        };
        assert(logical.left == expectedLogical.left);
        assert(logical.top == expectedLogical.top);
        assert(logical.right == expectedLogical.right);
        assert(logical.bottom == expectedLogical.bottom);

        const RECT roundTrip = electrobun::logicalToPhysicalScreenRect(
            logical.left,
            logical.top,
            logical.right - logical.left,
            logical.bottom - logical.top,
            monitor);
        assert(roundTrip.left == physical.left);
        assert(roundTrip.top == physical.top);
        assert(roundTrip.right == physical.right);
        assert(roundTrip.bottom == physical.bottom);
    };
    assertRectRoundTrip(
        primaryMonitor, {120, 80, 520, 380}, {120, 80, 520, 380});
    assertRectRoundTrip(
        leftMonitor,
        {-3600, 200, -2800, 1000},
        {-1800, 100, -1400, 500});
    assertRectRoundTrip(
        rightMonitor,
        {2160, 120, 2960, 720},
        {2040, 60, 2440, 360});

    const std::filesystem::path syntheticExecutable =
        L"C:\\Users\\\u5c71\u7530\\Electrobun\\bin\\launcher.exe";
    assert(electrobun::windowsResourcesDirectoryFromExecutable(
               syntheticExecutable) ==
           std::filesystem::path(
               L"C:\\Users\\\u5c71\u7530\\Electrobun\\Resources"));

    const DWORD temporaryRootCapacity = GetTempPathW(0, nullptr);
    assert(temporaryRootCapacity > 0);
    std::vector<wchar_t> temporaryRoot(temporaryRootCapacity + 1);
    const DWORD temporaryRootLength = GetTempPathW(
        static_cast<DWORD>(temporaryRoot.size()), temporaryRoot.data());
    assert(temporaryRootLength > 0 &&
           temporaryRootLength < temporaryRoot.size());
    const std::filesystem::path pathTestRoot =
        std::filesystem::path(temporaryRoot.data()) /
        (L"electrobun-\u8d44\u6e90-" + std::to_wstring(GetCurrentProcessId()));
    std::filesystem::path longDirectory = pathTestRoot;
    while (longDirectory.native().size() < 300) {
        longDirectory /=
            L"long-resource-segment-\u0442\u0435\u0441\u0442-0123456789";
    }
    const std::filesystem::path longFile =
        longDirectory / L"\u5185\u5bb9-\u0434\u0430\u043d\u043d\u044b\u0435.txt";
    std::error_code filesystemError;
    std::filesystem::create_directories(
        electrobun::windowsExtendedLengthPath(longDirectory), filesystemError);
    assert(!filesystemError);
    {
        std::ofstream output(
            electrobun::windowsExtendedLengthPath(longFile),
            std::ios::binary);
        assert(output.is_open());
        output << mixedUtf8;
        assert(output.good());
    }
    assert(electrobun::windowsRegularFileExists(longFile));
    std::string resourceContents;
    assert(electrobun::readWindowsBinaryFile(longFile, resourceContents));
    assert(resourceContents == mixedUtf8);
    assert(electrobun::windowsPathForLog(longFile).find("\xE8\xB5\x84\xE6\xBA\x90") !=
           std::string::npos);
    std::filesystem::remove_all(
        electrobun::windowsExtendedLengthPath(pathTestRoot), filesystemError);
    assert(!filesystemError);

    wchar_t truncated[3] = {};
    assert(electrobun::copyUtf8ToWideBuffer(
        "A\xF0\x9F\xA7\xAA" "B", truncated));
    assert(std::wstring(truncated) == L"A");
    wchar_t exactEmoji[4] = {};
    assert(electrobun::copyUtf8ToWideBuffer("A\xF0\x9F\xA7\xAA", exactEmoji));
    assert(std::wstring(exactEmoji).size() == 3);

    HMENU menu = CreatePopupMenu();
    assert(menu != NULL);
    assert(electrobun::appendMenuUtf8(menu, MF_STRING, 42, mixedUtf8));
    wchar_t menuText[256] = {};
    assert(GetMenuStringW(menu, 42, menuText, 256, MF_BYCOMMAND) > 0);
    assert(std::wstring(menuText) == wideMixed);
    const std::string replacement = "\xE6\x96\x87\xE4\xBB\xB6";
    assert(electrobun::modifyMenuUtf8(menu, 42, MF_BYCOMMAND, 42, replacement));
    assert(GetMenuStringW(menu, 42, menuText, 256, MF_BYCOMMAND) > 0);
    assert(std::wstring(menuText) == L"\u6587\u4ef6");
    DestroyMenu(menu);

    const wchar_t* className = L"ElectrobunWindowsUnicodeTestClass";
    WNDCLASSW windowClass = {};
    windowClass.lpfnWndProc = testWindowProc;
    windowClass.hInstance = GetModuleHandleW(nullptr);
    windowClass.lpszClassName = className;
    const ATOM atom = RegisterClassW(&windowClass);
    assert(atom != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS);
    HWND window = CreateWindowExW(
        0,
        className,
        L"",
        0,
        0,
        0,
        0,
        0,
        nullptr,
        nullptr,
        windowClass.hInstance,
        nullptr);
    assert(window != NULL);
    assert(electrobun::setWindowTextUtf8(window, mixedUtf8));
    std::vector<wchar_t> windowTitle(
        static_cast<size_t>(GetWindowTextLengthW(window)) + 1);
    assert(GetWindowTextW(
        window,
        windowTitle.data(),
        static_cast<int>(windowTitle.size())) > 0);
    assert(std::wstring(windowTitle.data()) == wideMixed);
    DestroyWindow(window);
    UnregisterClassW(className, windowClass.hInstance);

    std::vector<std::wstring> labels;
    assert(electrobun::parseWindowsDialogButtonLabels(
        "  \xD0\xA1\xD0\xBE\xD1\x85\xD1\x80\xD0\xB0\xD0\xBD\xD0\xB8\xD1\x82\xD1\x8C,"
        "\xE5\x8F\x96\xE6\xB6\x88, Cancel  ",
        labels));
    assert(labels.size() == 3);
    assert(labels[0] == L"\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c");
    assert(labels[1] == L"\u53d6\u6d88");
    assert(labels[2] == L"Cancel");
    assert(electrobun::normalizeWindowsDialogDefaultId(1, labels.size()) == 1);
    assert(electrobun::normalizeWindowsDialogDefaultId(9, labels.size()) == 0);
    assert(electrobun::windowsTaskDialogButtonIndex(
        electrobun::windowsTaskDialogButtonId(1), labels.size(), 2) == 1);
    assert(electrobun::windowsTaskDialogButtonIndex(
        IDCANCEL, labels.size(), 2) == 2);
    assert(electrobun::windowsTaskDialogButtonIndex(
        IDCANCEL, labels.size(), -1) == -1);

    labels = {L"stale"};
    assert(!electrobun::parseWindowsDialogButtonLabels(
        std::string("\xff", 1), labels));
    assert(labels.empty());
    assert(electrobun::parseWindowsDialogButtonLabels("", labels));
    assert(labels == std::vector<std::wstring>{L"OK"});

    std::wstring invalidOutput = L"stale";
    assert(!electrobun::utf8ToWide(std::string("\xff", 1), invalidOutput));
    assert(invalidOutput.empty());
    std::string invalidWideOutput = "stale";
    assert(!electrobun::wideToUtf8(
        std::wstring(1, static_cast<wchar_t>(0xD800)), invalidWideOutput));
    assert(invalidWideOutput.empty());

    if (argc == 2) {
        std::wstring dllPath;
        assert(electrobun::utf8ToWide(argv[1], dllPath));
        HMODULE module = LoadLibraryW(dllPath.c_str());
        if (!module) {
            std::fprintf(stderr, "LoadLibraryW failed: %lu\n", GetLastError());
            return 2;
        }

        using CaptureScreenRegionFn = bool (*)(
            double, double, uint32_t, uint32_t, uint8_t*, uint64_t);
        auto captureScreenRegion = reinterpret_cast<CaptureScreenRegionFn>(
            GetProcAddress(module, "captureScreenRegion"));
        if (!captureScreenRegion) {
            std::fprintf(stderr, "captureScreenRegion export is unavailable\n");
            FreeLibrary(module);
            return 11;
        }

        uint8_t pixel[4] = {};
        if (captureScreenRegion(0, 0, 0, 1, pixel, sizeof(pixel)) ||
            captureScreenRegion(0, 0, 1, 0, pixel, sizeof(pixel)) ||
            captureScreenRegion(0, 0, 1, 1, nullptr, sizeof(pixel)) ||
            captureScreenRegion(0, 0, 1, 1, pixel, sizeof(pixel) - 1) ||
            captureScreenRegion(0, 0, 1, 1, pixel, sizeof(pixel) + 1)) {
            std::fprintf(stderr, "captureScreenRegion accepted invalid output\n");
            FreeLibrary(module);
            return 12;
        }

        const auto displays = electrobun::windowsLogicalMonitors();
        const auto primary = std::find_if(
            displays.begin(), displays.end(), [](const auto& display) {
                return display.primary;
            });
        if (primary == displays.end()) {
            std::fprintf(stderr, "No primary display is available\n");
            FreeLibrary(module);
            return 13;
        }
        const double logicalX = primary->logicalBounds.left +
            (primary->logicalBounds.right - primary->logicalBounds.left) / 2;
        const double logicalY = primary->logicalBounds.top +
            (primary->logicalBounds.bottom - primary->logicalBounds.top) / 2;
        if (!captureScreenRegion(
                logicalX, logicalY, 1, 1, pixel, sizeof(pixel)) ||
            pixel[3] != 255) {
            std::fprintf(stderr, "captureScreenRegion pixel capture failed\n");
            FreeLibrary(module);
            return 14;
        }

        const std::wstring testAsarPath =
            electrobun::getEnvironmentVariableWide(L"ELECTROBUN_TEST_ASAR_PATH");
        if (!testAsarPath.empty()) {
            using AsarOpenFn = void* (*)(const char*);
            using AsarReadFileFn = uint8_t* (*)(
                void*, const char*, uint64_t*);
            using AsarFreeBufferFn = void (*)(uint8_t*, uint64_t);
            using AsarCloseFn = void (*)(void*);
            auto asarOpen = reinterpret_cast<AsarOpenFn>(
                GetProcAddress(module, "asar_open"));
            auto asarReadFile = reinterpret_cast<AsarReadFileFn>(
                GetProcAddress(module, "asar_read_file"));
            auto asarFreeBuffer = reinterpret_cast<AsarFreeBufferFn>(
                GetProcAddress(module, "asar_free_buffer"));
            auto asarClose = reinterpret_cast<AsarCloseFn>(
                GetProcAddress(module, "asar_close"));
            if (!asarOpen || !asarReadFile || !asarFreeBuffer || !asarClose) {
                std::fprintf(stderr, "ASAR exports are unavailable\n");
                FreeLibrary(module);
                return 8;
            }

            std::string utf8AsarPath;
            assert(electrobun::wideToUtf8(testAsarPath, utf8AsarPath));
            void* archive = asarOpen(utf8AsarPath.c_str());
            if (!archive) {
                std::fprintf(stderr, "Could not open Unicode ASAR path\n");
                FreeLibrary(module);
                return 9;
            }
            uint64_t contentSize = 0;
            uint8_t* content = asarReadFile(
                archive, "views/index.html", &contentSize);
            const std::string expected =
                "ASAR Unicode resource: caf\xC3\xA9 / \xE6\xB5\x8B\xE8\xAF\x95";
            const bool asarReadSucceeded = content &&
                std::string(
                    reinterpret_cast<const char*>(content), contentSize) ==
                    expected;
            if (content) asarFreeBuffer(content, contentSize);
            asarClose(archive);
            if (!asarReadSucceeded) {
                std::fprintf(stderr, "Could not read Unicode ASAR resource\n");
                FreeLibrary(module);
                return 10;
            }
        }

        ACTCTXW activationConfig = {};
        activationConfig.cbSize = sizeof(activationConfig);
        activationConfig.dwFlags =
            ACTCTX_FLAG_HMODULE_VALID | ACTCTX_FLAG_RESOURCE_NAME_VALID;
        activationConfig.hModule = module;
        activationConfig.lpResourceName = MAKEINTRESOURCEW(2);
        HANDLE activationContext = CreateActCtxW(&activationConfig);
        if (activationContext == INVALID_HANDLE_VALUE) {
            std::fprintf(stderr, "CreateActCtxW failed: %lu\n", GetLastError());
            FreeLibrary(module);
            return 3;
        }

        ULONG_PTR activationCookie = 0;
        if (!ActivateActCtx(activationContext, &activationCookie)) {
            std::fprintf(stderr, "ActivateActCtx failed: %lu\n", GetLastError());
            ReleaseActCtx(activationContext);
            FreeLibrary(module);
            return 4;
        }
        HMODULE commonControls = LoadLibraryW(L"comctl32.dll");
        const bool hasTaskDialog = commonControls &&
            GetProcAddress(commonControls, "TaskDialogIndirect") != nullptr;
        if (commonControls) FreeLibrary(commonControls);
        DeactivateActCtx(0, activationCookie);
        ReleaseActCtx(activationContext);
        if (!hasTaskDialog) {
            std::fprintf(stderr, "TaskDialogIndirect is unavailable\n");
            FreeLibrary(module);
            return 5;
        }

        using ShowMessageBoxFn = int (*)(
            const char*,
            const char*,
            const char*,
            const char*,
            const char*,
            int,
            int);
        auto showMessageBox = reinterpret_cast<ShowMessageBoxFn>(
            GetProcAddress(module, "showMessageBox"));
        if (!showMessageBox) {
            std::fprintf(stderr, "showMessageBox export is unavailable\n");
            FreeLibrary(module);
            return 6;
        }

        TaskDialogProbe probe;
        probe.processId = GetCurrentProcessId();
        probe.title = L"Electrobun Dialog \u6d4b\u8bd5";
        probe.labels = {
            L"\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c",
            L"\u53d6\u6d88",
            L"\u0391\u03ba\u03cd\u03c1\u03c9\u03c3\u03b7",
        };
        std::thread dialogDriver([&probe]() {
            for (int attempt = 0; attempt < 200 && !probe.clicked.load(); ++attempt) {
                EnumWindows(probeTaskDialogWindow, reinterpret_cast<LPARAM>(&probe));
                Sleep(25);
            }
            if (!probe.clicked.load()) {
                HWND dialog = probe.dialog.load();
                if (dialog) PostMessageW(dialog, WM_CLOSE, 0, 0);
            }
        });
        const int result = showMessageBox(
            "question",
            "Electrobun Dialog \xE6\xB5\x8B\xE8\xAF\x95",
            "Unicode custom buttons",
            "TaskDialogIndirect integration regression",
            "\xD0\xA1\xD0\xBE\xD1\x85\xD1\x80\xD0\xB0\xD0\xBD\xD0\xB8\xD1\x82\xD1\x8C,"
            "\xE5\x8F\x96\xE6\xB6\x88,"
            "\xCE\x91\xCE\xBA\xCF\x8D\xCF\x81\xCF\x89\xCF\x83\xCE\xB7",
            1,
            2);
        dialogDriver.join();
        if (result != 1 || !probe.clicked.load()) {
            std::fprintf(
                stderr,
                "TaskDialog integration failed: result=%d labels=0x%x clicked=%d\n",
                result,
                probe.labelsSeen.load(),
                probe.clicked.load() ? 1 : 0);
            FreeLibrary(module);
            return 7;
        }
        FreeLibrary(module);
    }
    return 0;
}

#endif
