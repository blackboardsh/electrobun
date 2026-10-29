#pragma once

#include <X11/Xlib.h>

namespace electrobun {

// A queued FocusIn can describe a window that has already lost focus. Only
// redirect focus within the currently focused toplevel; replaying old events
// otherwise makes two native UI windows repeatedly steal focus from each other.
inline bool focusChildOfCurrentToplevel(Display* display, Window toplevel, Window child) {
    if (!display || !toplevel || !child) return false;
    Window focused = None;
    int revert = 0;
    XGetInputFocus(display, &focused, &revert);
    if (focused == None || focused == PointerRoot || focused == child) return false;
    if (focused != toplevel) {
        Window root = None, parent = None, *children = nullptr;
        unsigned int count = 0;
        const bool found = XQueryTree(display, focused, &root, &parent, &children, &count);
        if (children) XFree(children);
        if (!found || parent != toplevel) return false;
    }
    XSetInputFocus(display, child, RevertToParent, CurrentTime);
    XFlush(display);
    return true;
}

} // namespace electrobun
