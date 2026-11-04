#include "windows_ui_frame_schedule.h"

#include <cassert>
#include <cstdio>

namespace {

void testFrameSchedule() {
    electrobun::UIFrameSchedule schedule;
    assert(!schedule.ready());
    assert(schedule.activeFlight() == 0);
    assert(!schedule.queue(1));
    schedule.request();
    assert(schedule.ready());
    assert(!schedule.queue(0));
    assert(schedule.queue(1));
    assert(schedule.activeFlight() == 1);
    assert(!schedule.ready());
    assert(!schedule.queue(2));

    // An unrelated WM_PAINT before the queued wake must not consume its flight.
    assert(schedule.beginPaint() == 0);
    assert(schedule.beginTimer(1) == 0);
    assert(!schedule.finishPaint(1));
    assert(!schedule.acceptWake(2));
    assert(schedule.acceptWake(1));
    assert(schedule.beginTimer(2) == 0);
    assert(!schedule.acceptWake(1));
    assert(schedule.beginPaint() == 1);
    assert(schedule.beginPaint() == 0);
    assert(schedule.beginTimer(1) == 0);
    assert(!schedule.finishPaint(2));

    // Requests made during a frame coalesce, but survive its completion.
    for (unsigned count = 0; count < 100; ++count) schedule.request();
    assert(!schedule.ready());
    assert(schedule.finishPaint(1));
    assert(schedule.activeFlight() == 0);
    assert(schedule.ready());
    assert(!schedule.finishPaint(1));
    assert(schedule.queue(2));
    assert(schedule.acceptWake(2));
    assert(schedule.beginPaint() == 2);
    assert(schedule.finishPaint(2));
    assert(!schedule.ready());

    // Cancellation/retirement and token reuse must not let stale work mutate a
    // newer flight, whether the stale work is a wake, cancellation or finish.
    schedule.request();
    assert(schedule.queue(10));
    assert(schedule.cancel(10));
    assert(schedule.activeFlight() == 0);
    assert(schedule.beginTimer(10) == 0);
    schedule.request();
    assert(schedule.queue(11));
    assert(!schedule.acceptWake(10));
    assert(!schedule.cancel(10));
    assert(!schedule.finishPaint(10));
    assert(schedule.beginTimer(10) == 0);
    assert(schedule.acceptWake(11));
    assert(schedule.beginTimer(10) == 0);
    assert(schedule.activeFlight() == 11);
    assert(schedule.beginTimer(11) == 11);
    assert(schedule.beginTimer(11) == 0);
    assert(schedule.beginPaint() == 0);
    assert(schedule.finishPaint(11));

    // A retired attachment gets a fresh state and a globally fresh token.
    schedule = electrobun::UIFrameSchedule{};
    schedule.request();
    assert(schedule.queue(12));
    assert(!schedule.acceptWake(11));
    assert(!schedule.cancel(11));
    assert(!schedule.finishPaint(11));
    assert(schedule.acceptWake(12));

    // A paint notification consumed without rendering needs another flight.
    schedule.deferPaint();
    assert(schedule.ready());
    assert(!schedule.finishPaint(12));
    assert(schedule.queue(13));
    assert(!schedule.acceptWake(12));
    assert(schedule.acceptWake(13));
    assert(schedule.beginPaint() == 13);

    // A nested paint must not release the outer render's ownership. Its
    // requested follow-up becomes eligible only when the outer frame finishes.
    schedule.deferPaint();
    assert(!schedule.ready());
    assert(schedule.beginPaint() == 0);
    assert(schedule.finishPaint(13));
    assert(schedule.ready());
    assert(schedule.queue(14));
    schedule.deferPaint();
    assert(!schedule.ready());
    assert(schedule.beginPaint() == 0);
    assert(schedule.acceptWake(14));
    assert(schedule.beginPaint() == 14);
    assert(schedule.finishPaint(14));
    assert(schedule.ready());
}

#ifdef _WIN32

constexpr UINT legacyFrameMessage = WM_APP + 17;
constexpr UINT frameWakeMessage = WM_APP + 18;
constexpr ULONG_PTR oldClickToken = 0xEB150001;
constexpr ULONG_PTR paintClickToken = 0xEB150002;

struct FrameProbe {
    electrobun::UIFrameSchedule schedule;
    uint64_t nextToken = 1;
    bool postLegacyFrames = false;
    bool animate = false;
    unsigned legacyFrames = 0;
    unsigned wakes = 0;
    unsigned frames = 0;
    unsigned paintFrames = 0;
    unsigned timerFrames = 0;
    unsigned hiddenFrames = 0;
    ULONG_PTR clickToken = 0;
    unsigned downs = 0;
    unsigned ups = 0;
};

void queueFrame(HWND window, FrameProbe& probe) {
    if (!probe.schedule.ready()) return;
    const uint64_t token = probe.nextToken++;
    assert(probe.schedule.queue(token));
    assert(PostMessageW(window, frameWakeMessage, static_cast<WPARAM>(token), 0));
}

void requestFrame(HWND window, FrameProbe& probe) {
    probe.schedule.request();
    queueFrame(window, probe);
}

void renderFrame(HWND window, FrameProbe& probe, uint64_t token, bool timer) {
    if (token == 0) return;
    KillTimer(window, static_cast<UINT_PTR>(token));
    ++probe.frames;
    if (timer) ++probe.timerFrames;
    else ++probe.paintFrames;
    if (!IsWindowVisible(window) || IsIconic(GetAncestor(window, GA_ROOT))) {
        ++probe.hiddenFrames;
    }
    if (probe.animate) probe.schedule.request();
    assert(probe.schedule.finishPaint(token));
    queueFrame(window, probe);
}

LRESULT CALLBACK frameWindowProc(HWND window, UINT message, WPARAM wParam,
                                 LPARAM lParam) {
    if (message == WM_NCCREATE) {
        const auto* create = reinterpret_cast<const CREATESTRUCTW*>(lParam);
        SetWindowLongPtrW(window, GWLP_USERDATA,
                         reinterpret_cast<LONG_PTR>(create->lpCreateParams));
    }
    auto* probe = reinterpret_cast<FrameProbe*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (probe) {
        if (message == legacyFrameMessage) {
            ++probe->legacyFrames;
            if (probe->postLegacyFrames) assert(PostMessageW(window, legacyFrameMessage, 0, 0));
            return 0;
        }
        if (message == frameWakeMessage) {
            if (probe->schedule.acceptWake(static_cast<uint64_t>(wParam))) {
                ++probe->wakes;
                assert(electrobun::requestLowPriorityUIFrame(window, static_cast<uint64_t>(wParam)));
            }
            return 0;
        }
        if (message == WM_PAINT) {
            PAINTSTRUCT paint{};
            BeginPaint(window, &paint);
            EndPaint(window, &paint);
            renderFrame(window, *probe, probe->schedule.beginPaint(), false);
            return 0;
        }
        if (message == WM_TIMER) {
            renderFrame(window, *probe,
                        probe->schedule.beginTimer(static_cast<uint64_t>(wParam)), true);
            return 0;
        }
        if ((message == WM_LBUTTONDOWN || message == WM_LBUTTONUP) &&
            static_cast<ULONG_PTR>(GetMessageExtraInfo()) == probe->clickToken) {
            if (message == WM_LBUTTONDOWN) ++probe->downs;
            else ++probe->ups;
            return 0;
        }
    }
    return DefWindowProcW(window, message, wParam, lParam);
}

void dispatch(MSG& message) {
    assert(message.message != WM_QUIT);
    TranslateMessage(&message);
    DispatchMessageW(&message);
}

void drainMessages() {
    MSG message{};
    for (unsigned count = 0; PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE); ++count) {
        assert(count < 4096);
        dispatch(message);
    }
}

template <typename Condition>
bool pumpUntil(Condition&& condition, DWORD timeoutMs) {
    const ULONGLONG deadline = GetTickCount64() + timeoutMs;
    while (!condition() && GetTickCount64() < deadline) {
        MSG message{};
        if (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) dispatch(message);
        else Sleep(1);
    }
    return condition();
}

void injectClick(HWND window, FrameProbe& probe, ULONG_PTR token) {
    assert(GetForegroundWindow() == window);
    probe.clickToken = token;
    probe.downs = probe.ups = 0;
    INPUT clicks[2]{};
    clicks[0].type = clicks[1].type = INPUT_MOUSE;
    clicks[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    clicks[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
    clicks[0].mi.dwExtraInfo = clicks[1].mi.dwExtraInfo = token;
    const UINT injected = SendInput(2, clicks, sizeof(INPUT));
    if (injected != 2) SendInput(1, &clicks[1], sizeof(INPUT));
    assert(injected == 2);
    const ULONGLONG deadline = GetTickCount64() + 1000;
    while (!(HIWORD(GetQueueStatus(QS_MOUSEBUTTON)) & QS_MOUSEBUTTON)) {
        assert(GetTickCount64() < deadline && "SendInput never reached the hardware-input queue");
        Sleep(1);
    }
}

void testMouseUnderFrames(HWND window, FrameProbe& probe) {
    POINT target{40, 40};
    assert(ClientToScreen(window, &target));
    assert(SetCursorPos(target.x, target.y));
    drainMessages();
    assert(GetForegroundWindow() == window);
    probe.postLegacyFrames = true;
    assert(PostMessageW(window, legacyFrameMessage, 0, 0));
    injectClick(window, probe, oldClickToken);

    // Counterexample: ordinary GetMessage repeatedly retrieves posted frames
    // while a confirmed hardware click stays pending. No timing guess is
    // needed to distinguish this from slow individual render callbacks.
    const unsigned oldFrames = probe.legacyFrames;
    for (unsigned count = 0; count < 1024 && probe.legacyFrames - oldFrames < 256; ++count) {
        MSG message{};
        assert(GetMessageW(&message, nullptr, 0, 0) > 0);
        dispatch(message);
    }
    assert(probe.legacyFrames - oldFrames == 256);
    assert(probe.downs == 0 && probe.ups == 0);
    assert(HIWORD(GetQueueStatus(QS_MOUSEBUTTON)) & QS_MOUSEBUTTON);
    probe.postLegacyFrames = false;
    drainMessages();
    assert(probe.downs == 1 && probe.ups == 1);

    // Use a fresh, separately tagged hardware click for the production policy:
    // short posted wake -> OS-generated internal paint -> next wake. The same
    // unfiltered Windows message loop now services input before painting.
    probe.animate = true;
    requestFrame(window, probe);
    injectClick(window, probe, paintClickToken);
    const unsigned firstFrame = probe.frames;
    const unsigned firstPaint = probe.paintFrames;
    const unsigned firstTimer = probe.timerFrames;
    unsigned messages = 0;
    while (probe.ups == 0 && messages < 32) {
        MSG message{};
        assert(GetMessageW(&message, nullptr, 0, 0) > 0);
        dispatch(message);
        ++messages;
    }
    assert(probe.downs == 1 && probe.ups == 1);
    assert(probe.frames == firstFrame);
    assert(pumpUntil([&]() { return probe.frames >= firstFrame + 3; }, 1000));
    assert(probe.paintFrames >= firstPaint + 3);
    assert(probe.timerFrames == firstTimer);
    probe.animate = false;
    drainMessages();
    std::printf("Windows frame fairness: 256 posted render callbacks starved the old click; "
                "internal-paint scheduling delivered a fresh click in %u messages before rendering\n",
                messages);
}

void testHiddenFrameRecovery(HWND window, HWND parent, FrameProbe& probe, int hideCommand,
                             const char* description) {
    ShowWindow(parent, hideCommand);
    drainMessages();
    assert(!IsWindowVisible(window) || IsIconic(parent));
    const unsigned hiddenBefore = probe.hiddenFrames;
    const unsigned framesBefore = probe.frames;
    requestFrame(window, probe);
    // UI.nextFrame may be awaited before showing a window. Rendering must
    // complete while hidden/minimized; restoration cannot rescue the flight.
    assert(pumpUntil([&]() { return probe.frames > framesBefore; }, 1000));
    assert(probe.hiddenFrames > hiddenBefore);
    ShowWindow(parent, SW_RESTORE);
    SetForegroundWindow(parent);
    SetFocus(parent);

    // A completed deferred frame must not leave the scheduler wedged: a fresh
    // request should also reach a paint after the window becomes visible.
    const unsigned resumedFrames = probe.frames;
    requestFrame(window, probe);
    assert(pumpUntil([&]() { return probe.frames > resumedFrames; }, 1000));
    drainMessages();
    std::printf("Windows %s child frame: completed before restore; restored frames=%u\n",
                description, probe.frames - resumedFrames);
}

void acceptPostedWake(HWND window, FrameProbe& probe, uint64_t flight) {
    MSG wake{};
    assert(PeekMessageW(&wake, window, frameWakeMessage, frameWakeMessage, PM_REMOVE));
    assert(static_cast<uint64_t>(wake.wParam) == flight);
    dispatch(wake);
    assert(probe.schedule.activeFlight() == flight);
}

void testHideAfterWake(HWND window, HWND parent, FrameProbe& probe) {
    drainMessages();
    assert(IsWindowVisible(window) && !IsIconic(parent));
    const unsigned framesBefore = probe.frames;
    const unsigned hiddenBefore = probe.hiddenFrames;
    requestFrame(window, probe);
    // Only retrieve the wake, leaving its OS-generated paint unprocessed.
    // A watchdog armed only for already-hidden windows would miss this race.
    acceptPostedWake(window, probe, probe.schedule.activeFlight());
    assert(probe.frames == framesBefore);
    ShowWindow(parent, SW_HIDE);
    assert(!IsWindowVisible(window));
    assert(probe.frames == framesBefore);
    assert(pumpUntil([&]() { return probe.frames > framesBefore; }, 1000));
    assert(probe.hiddenFrames > hiddenBefore);
    ShowWindow(parent, SW_RESTORE);
    SetForegroundWindow(parent);
    SetFocus(parent);
    drainMessages();
    std::puts("Windows child hidden after frame wake: completed before restore");
}

MSG takeDueFrameTimer(HWND window, uint64_t flight) {
    MSG timer{};
    const ULONGLONG deadline = GetTickCount64() + 1000;
    while (!PeekMessageW(&timer, window, WM_TIMER, WM_TIMER, PM_REMOVE)) {
        assert(GetTickCount64() < deadline && "Frame watchdog timer never became due");
        Sleep(1);
    }
    assert(static_cast<uint64_t>(timer.wParam) == flight);
    return timer;
}

void testStaleTimer(HWND window, HWND parent, FrameProbe& probe) {
    ShowWindow(parent, SW_HIDE);
    drainMessages();
    const unsigned framesBefore = probe.frames;
    requestFrame(window, probe);
    const uint64_t oldFlight = probe.schedule.activeFlight();
    acceptPostedWake(window, probe, oldFlight);

    // Capture an actual due timer without dispatching it. KillTimer cannot
    // revoke a timer message which the message loop has already retrieved.
    MSG staleTimer = takeDueFrameTimer(window, oldFlight);
    assert(probe.frames == framesBefore);
    KillTimer(window, static_cast<UINT_PTR>(oldFlight));
    assert(probe.schedule.cancel(oldFlight));

    requestFrame(window, probe);
    const uint64_t newFlight = probe.schedule.activeFlight();
    assert(newFlight != oldFlight);
    acceptPostedWake(window, probe, newFlight);
    dispatch(staleTimer);
    assert(probe.frames == framesBefore);
    assert(probe.schedule.activeFlight() == newFlight);
    // The newer watchdog must still be armed. Fetch it explicitly so an old
    // pending paint cannot mask accidental cancellation of the newer timer.
    MSG currentTimer = takeDueFrameTimer(window, newFlight);
    assert(probe.frames == framesBefore);
    dispatch(currentTimer);
    assert(probe.frames == framesBefore + 1);
    assert(probe.schedule.activeFlight() == 0);

    ShowWindow(parent, SW_RESTORE);
    SetForegroundWindow(parent);
    SetFocus(parent);
    drainMessages();
    std::puts("Windows stale watchdog timer: rejected without consuming the newer flight");
}

void testRealWindowsFrames() {
    const HINSTANCE instance = GetModuleHandleW(nullptr);
    constexpr const wchar_t* name = L"ElectrobunUIFrameFairnessTest";
    WNDCLASSW windowClass{};
    windowClass.lpfnWndProc = frameWindowProc;
    windowClass.hInstance = instance;
    windowClass.lpszClassName = name;
    assert(RegisterClassW(&windowClass));

    const HWND oldForeground = GetForegroundWindow();
    POINT oldCursor{};
    const bool restoreCursor = GetCursorPos(&oldCursor) != 0;
    const auto oldDpi = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    assert(oldDpi);
    FrameProbe probe;
    HWND window = CreateWindowExW(WS_EX_TOPMOST, name, L"Electrobun frame fairness",
                                 WS_OVERLAPPEDWINDOW, 60, 60, 240, 180,
                                 nullptr, nullptr, instance, &probe);
    assert(window);
    // WGPU views are WS_VISIBLE children of a container under their window.
    // Neither ancestor has been shown yet: UI.nextFrame must still complete.
    HWND container = CreateWindowExW(0, L"STATIC", L"",
        WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
        10, 80, 160, 40, window, nullptr, instance, nullptr);
    assert(container);
    FrameProbe childProbe;
    HWND child = CreateWindowExW(0, name, L"",
        WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
        0, 0, 160, 40, container, nullptr, instance, &childProbe);
    assert(child);
    assert(!IsWindowVisible(window) && !IsWindowVisible(child));
    requestFrame(child, childProbe);
    assert(pumpUntil([&]() { return childProbe.frames == 1; }, 1000));
    assert(childProbe.hiddenFrames == 1);
    std::puts("Windows never-shown child frame: completed before first ShowWindow");

    ShowWindow(window, SW_SHOW);
    assert(SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW));
    SetForegroundWindow(window);
    SetFocus(window);
    assert(pumpUntil([&]() { return GetForegroundWindow() == window; }, 2000));
    drainMessages();

    testMouseUnderFrames(window, probe);
    testHiddenFrameRecovery(child, window, childProbe, SW_HIDE, "hidden-window");
    testHiddenFrameRecovery(child, window, childProbe, SW_MINIMIZE, "minimized-window");
    testHideAfterWake(child, window, childProbe);
    testStaleTimer(child, window, childProbe);

    assert(DestroyWindow(window));
    assert(UnregisterClassW(name, instance));
    SetThreadDpiAwarenessContext(oldDpi);
    if (restoreCursor) SetCursorPos(oldCursor.x, oldCursor.y);
    if (oldForeground && IsWindow(oldForeground)) SetForegroundWindow(oldForeground);
    drainMessages();
}
#endif

} // namespace

void runWindowsUIFrameScheduleTests() {
    testFrameSchedule();
}

void runWindowsUIFrameScheduleDesktopTests() {
#ifdef _WIN32
    testRealWindowsFrames();
#endif
}

#ifdef ELECTROBUN_UI_FRAME_SCHEDULE_TEST_STANDALONE
int main() {
    runWindowsUIFrameScheduleTests();
}
#endif
