#include "ui_focus.h"

#include <cassert>
#include <cstdio>

int main() {
    Display* display = XOpenDisplay(nullptr);
    assert(display);
    const Window root = DefaultRootWindow(display);
    const auto makeWindow = [&](Window parent) {
        const Window window = XCreateSimpleWindow(display, parent, 0, 0, 100, 100, 0, 0, 0);
        XSelectInput(display, window, FocusChangeMask);
        XMapWindow(display, window);
        return window;
    };
    const Window first = makeWindow(root);
    const Window firstInput = makeWindow(first);
    const Window firstToolkitFocus = makeWindow(first);
    const Window second = makeWindow(root);
    const Window secondInput = makeWindow(second);
    XSync(display, False);

    const auto focusedWindow = [&] {
        Window focused = None;
        int revert = 0;
        XGetInputFocus(display, &focused, &revert);
        return focused;
    };
    const auto focus = [&](Window window) {
        XSetInputFocus(display, window, RevertToParent, CurrentTime);
        XSync(display, True);
    };
    using electrobun::focusChildOfCurrentToplevel;

    // Legitimate activation moves focus from the toplevel (or GTK's own
    // focus child) into its native UI input child.
    focus(first);
    assert(focusChildOfCurrentToplevel(display, first, firstInput));
    assert(focusedWindow() == firstInput);
    focus(firstToolkitFocus);
    assert(focusChildOfCurrentToplevel(display, first, firstInput));
    assert(focusedWindow() == firstInput);

    focus(secondInput);
    // Replay the old window's queued FocusIn notifications after a newer
    // window has become active. They must neither steal focus nor produce
    // another round of FocusOut/FocusIn events.
    for (int i = 0; i < 100; ++i) {
        assert(!focusChildOfCurrentToplevel(display, first, firstInput));
        assert(!focusChildOfCurrentToplevel(display, second, secondInput));
        assert(focusedWindow() == secondInput);
    }
    XSync(display, False);
    assert(XPending(display) == 0);

    focus(None);
    assert(!focusChildOfCurrentToplevel(display, first, firstInput));
    assert(focusedWindow() == None);
    focus(PointerRoot);
    assert(!focusChildOfCurrentToplevel(display, first, firstInput));
    assert(focusedWindow() == PointerRoot);

    XDestroyWindow(display, first);
    XDestroyWindow(display, second);
    XCloseDisplay(display);
    std::puts("Native UI ignores stale focus events across toplevels");
}
