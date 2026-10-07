#include <gtk/gtk.h>
#include <gdk/gdkx.h>
#include <X11/Xatom.h>
#include <X11/extensions/shape.h>

#include <algorithm>
#include <array>
#include <cstdio>
#include <functional>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

static std::map<GdkCursor*, std::string> cursorNames;
static GdkCursor* recordCursor(GdkDisplay* display, const gchar* name) {
    GdkCursor* cursor = gdk_cursor_new_from_name(display, name);
    if (cursor) cursorNames[cursor] = name;
    return cursor;
}

struct Drag {
    GtkWindow* window;
    GdkWindowEdge edge;
    gint button, x, y;
    guint time;
};
static std::vector<Drag> drags;
static void recordDrag(GtkWindow* window, GdkWindowEdge edge, gint button,
                       gint x, gint y, guint time) {
    drags.push_back({window, edge, button, x, y, time});
}

// Keep real GTK windows, input shapes and signal dispatch. Intercept only the
// final WM drag request so this test never moves the user's physical pointer.
#define gdk_cursor_new_from_name recordCursor
#define gtk_window_begin_resize_drag recordDrag
#include "../window_resize_handles.h"
#undef gtk_window_begin_resize_drag
#undef gdk_cursor_new_from_name

static void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

static void pump() {
    while (g_main_context_iteration(nullptr, FALSE)) {}
}

static void await(const std::function<bool()>& predicate, const char* message) {
    const gint64 deadline = g_get_monotonic_time() + 3 * G_TIME_SPAN_SECOND;
    do {
        pump();
        if (predicate()) return;
        g_usleep(1000);
    } while (g_get_monotonic_time() < deadline);
    require(false, message);
}

static std::vector<Window> children(GdkWindow* parent) {
    Window root, ancestor, *values = nullptr;
    unsigned count = 0;
    require(XQueryTree(GDK_WINDOW_XDISPLAY(parent), GDK_WINDOW_XID(parent),
                       &root, &ancestor, &values, &count), "XQueryTree failed");
    std::vector<Window> result;
    if (count) result.assign(values, values + count);
    if (values) XFree(values);
    return result;
}

struct Handle {
    GdkWindow* window;
    XWindowAttributes geometry;
    std::vector<XRectangle> input;
    std::vector<XRectangle> bounding;

    bool contains(int x, int y) const {
        x -= geometry.x;
        y -= geometry.y;
        const auto containsPoint = [x, y](const auto& rect) {
            return x >= rect.x && y >= rect.y &&
                   x < rect.x + rect.width && y < rect.y + rect.height;
        };
        return std::any_of(input.begin(), input.end(), containsPoint) &&
               std::any_of(bounding.begin(), bounding.end(), containsPoint);
    }
};

static std::vector<Handle> handles(GtkWidget* widget) {
    GdkWindow* parent = gtk_widget_get_window(widget);
    GdkDisplay* display = gdk_window_get_display(parent);
    Display* xdisplay = GDK_WINDOW_XDISPLAY(parent);
    std::vector<Handle> result;
    for (Window child : children(parent)) {
        XWindowAttributes attributes{};
        require(XGetWindowAttributes(xdisplay, child, &attributes), "Missing X child");
        if (attributes.c_class != InputOnly) continue;
        GdkWindow* window = gdk_x11_window_lookup_for_display(display, child);
        require(window != nullptr, "Resize input window must be registered with GDK");
        // GTK also creates an internal input-only helper at (-1, -1).
        if (!cursorNames.count(gdk_window_get_cursor(window))) continue;
        int count = 0, ordering = 0;
        XRectangle* rectangles = XShapeGetRectangles(xdisplay, child, ShapeInput, &count, &ordering);
        std::vector<XRectangle> input;
        if (count) input.assign(rectangles, rectangles + count);
        if (rectangles) XFree(rectangles);
        rectangles = XShapeGetRectangles(xdisplay, child, ShapeBounding, &count, &ordering);
        std::vector<XRectangle> bounding;
        if (count) bounding.assign(rectangles, rectangles + count);
        if (rectangles) XFree(rectangles);
        result.push_back({window, attributes, input, bounding});
    }
    return result;
}

static bool press(GtkWidget* widget, GdkWindow* window, guint button,
                  GdkEventType type = GDK_BUTTON_PRESS) {
    GdkEvent* event = gdk_event_new(type);
    event->button.window = GDK_WINDOW(g_object_ref(window));
    event->button.send_event = TRUE;
    event->button.button = button;
    event->button.time = 12345;
    event->button.x_root = 321;
    event->button.y_root = 234;
    const bool handled = gtk_widget_event(widget, event);
    gdk_event_free(event);
    return handled;
}

static void verifyPerimeter(GtkWidget* window, GtkWidget* content) {
    const auto regions = handles(window);
    require(regions.size() == 8, "Expected eight native resize input windows");
    GtkAllocation allocation{};
    gtk_widget_get_allocation(content, &allocation);
    const int width = gtk_widget_get_allocated_width(window);
    const int height = gtk_widget_get_allocated_height(window);
    require(allocation.x == 0 && allocation.y == 0 &&
            allocation.width == width && allocation.height == height,
            "Resize handles must preserve full-size content at (0, 0)");

    // Query both server shapes: an input shape is ineffective when GDK clips its
    // bounding shape behind a GTK child. Include corner cutouts so interior
    // controls remain clickable and every perimeter pixel has just one owner.
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            unsigned hits = 0;
            for (const auto& region : regions) hits += region.contains(x, y);
            require(hits <= 1, "Resize input shapes overlap");
            if (x == 0 || y == 0 || x == width - 1 || y == height - 1)
                require(hits == 1, "Resize input shapes leave a perimeter gap");
            if (x >= 6 && y >= 6 && x < width - 6 && y < height - 6)
                require(hits == 0, "Resize handles intercept interior content");
        }
    }

    struct Probe { int x, y; GdkWindowEdge edge; const char* cursor; };
    const Probe probes[] = {
        {0, 0, GDK_WINDOW_EDGE_NORTH_WEST, "nw-resize"},
        {width / 2, 0, GDK_WINDOW_EDGE_NORTH, "n-resize"},
        {width - 1, 0, GDK_WINDOW_EDGE_NORTH_EAST, "ne-resize"},
        {0, height / 2, GDK_WINDOW_EDGE_WEST, "w-resize"},
        {width - 1, height / 2, GDK_WINDOW_EDGE_EAST, "e-resize"},
        {0, height - 1, GDK_WINDOW_EDGE_SOUTH_WEST, "sw-resize"},
        {width / 2, height - 1, GDK_WINDOW_EDGE_SOUTH, "s-resize"},
        {width - 1, height - 1, GDK_WINDOW_EDGE_SOUTH_EAST, "se-resize"},
    };
    for (const auto& probe : probes) {
        const auto found = std::find_if(regions.begin(), regions.end(), [&](const auto& region) {
            return region.contains(probe.x, probe.y);
        });
        require(found != regions.end(), "Missing resize handle at edge probe");
        require(found->geometry.map_state == IsViewable, "Resize handle is hidden");
        require(cursorNames[gdk_window_get_cursor(found->window)] == probe.cursor,
                "Resize handle has incorrect cursor");
        const auto previous = drags.size();
        require(press(window, found->window, GDK_BUTTON_PRIMARY), "Primary edge press was not handled");
        require(drags.size() == previous + 1, "Primary press must start exactly one resize");
        const Drag& drag = drags.back();
        require(drag.window == GTK_WINDOW(window) && drag.edge == probe.edge &&
                drag.button == GDK_BUTTON_PRIMARY && drag.x == 321 && drag.y == 234 &&
                drag.time == 12345, "Incorrect native resize request");
        press(window, found->window, GDK_BUTTON_SECONDARY);
        press(window, found->window, GDK_BUTTON_PRIMARY, GDK_2BUTTON_PRESS);
        require(drags.size() == previous + 1, "Nonprimary or double press began resize");
    }
    const auto previous = drags.size();
    press(window, gtk_widget_get_window(content), GDK_BUTTON_PRIMARY);
    require(drags.size() == previous, "Content press began resize");
}

static bool allVisible(GtkWidget* window, bool visible) {
    const auto regions = handles(window);
    return regions.size() == 8 && std::all_of(regions.begin(), regions.end(), [&](const auto& region) {
        return (region.geometry.map_state == IsViewable) == visible;
    });
}

static void verifyDisabled(GtkWidget* window) {
    await([&] { return allVisible(window, false); }, "Disabled resize handles remain visible");
    const auto previous = drags.size();
    for (const auto& region : handles(window)) press(window, region.window, GDK_BUTTON_PRIMARY);
    require(drags.size() == previous, "Disabled handle began resize");
}

static void verifyRestacking(GtkWidget* window) {
    GdkWindow* parent = gtk_widget_get_window(window);
    Display* display = GDK_WINDOW_XDISPLAY(parent);
    const Window child = XCreateSimpleWindow(display, GDK_WINDOW_XID(parent), 0, 0,
        gtk_widget_get_allocated_width(window), gtk_widget_get_allocated_height(window), 0, 0, 0);
    XMapRaised(display, child);
    XFlush(display);
    const auto onTop = [&] {
        const auto stack = children(parent); // XQueryTree returns bottom to top.
        const auto childIndex = std::find(stack.begin(), stack.end(), child);
        for (const auto& region : handles(window)) {
            const auto index = std::find(stack.begin(), stack.end(), GDK_WINDOW_XID(region.window));
            if (index <= childIndex) return false;
        }
        return true;
    };
    await(onTop, "A newly mapped native child obscures resize handles");
    XRaiseWindow(display, child);
    XFlush(display);
    await(onTop, "A restacked native child obscures resize handles");
    XDestroyWindow(display, child);
    XFlush(display);
    pump();
}

static void setWindowState(GtkWidget* window, std::initializer_list<const char*> names,
                           GdkWindowState expected) {
    // Act as a minimal WM for this owned window. This makes GTK process genuine
    // X11 property changes and state events even under Xvfb without a WM.
    GdkWindow* parent = gtk_widget_get_window(window);
    Display* display = GDK_WINDOW_XDISPLAY(parent);
    std::vector<Atom> states;
    for (const char* name : names) states.push_back(XInternAtom(display, name, False));
    XChangeProperty(display, GDK_WINDOW_XID(parent), XInternAtom(display, "_NET_WM_STATE", False),
                    XA_ATOM, 32, PropModeReplace, reinterpret_cast<unsigned char*>(states.data()),
                    states.size());
    XFlush(display);
    await([&] {
        return (gdk_window_get_state(parent) &
            (GDK_WINDOW_STATE_MAXIMIZED | GDK_WINDOW_STATE_FULLSCREEN)) == expected;
    }, "GTK did not observe the test window's native state change");
}

int main(int argc, char** argv) {
    if (!gtk_init_check(&argc, &argv)) {
        std::fprintf(stderr, "Cannot initialize GTK; set DISPLAY to an X11 server.\n");
        return 1;
    }
    GtkWidget* window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    g_object_ref_sink(window);
    gtk_window_set_title(GTK_WINDOW(window), "Electrobun resize regression test");
    gtk_window_set_decorated(GTK_WINDOW(window), FALSE);
    gtk_window_set_default_size(GTK_WINDOW(window), 360, 240);
    GtkWidget* content = gtk_drawing_area_new();
    gtk_container_add(GTK_CONTAINER(window), content);
    try {
        electrobun::attachGtkWindowResizeHandles(window);
        electrobun::attachGtkWindowResizeHandles(window); // Installation is idempotent.
        gtk_widget_show_all(window);
        await([&] { return gtk_widget_get_mapped(window) && allVisible(window, true); },
              "Resize handles did not map");
        verifyPerimeter(window, content);

        // WebKit can add its GTK event window after the resize handles exist.
        gtk_container_remove(GTK_CONTAINER(window), content);
        content = gtk_event_box_new();
        gtk_container_add(GTK_CONTAINER(window), content);
        gtk_widget_show_all(window);
        await([&] { return gtk_widget_get_mapped(content) &&
                          gtk_widget_get_allocated_width(content) ==
                          gtk_widget_get_allocated_width(window); }, "Late GTK content did not map");
        verifyPerimeter(window, content);
        verifyRestacking(window);

        gtk_window_resize(GTK_WINDOW(window), 430, 280);
        await([&] { return gtk_widget_get_allocated_width(window) == 430 &&
                          gtk_widget_get_allocated_height(window) == 280; }, "Window did not resize");
        verifyPerimeter(window, content);

        gtk_window_set_resizable(GTK_WINDOW(window), FALSE);
        verifyDisabled(window);
        gtk_window_set_resizable(GTK_WINDOW(window), TRUE);
        await([&] { return allVisible(window, true); }, "Handles did not restore after resizable changed");

        setWindowState(window, {"_NET_WM_STATE_MAXIMIZED_VERT", "_NET_WM_STATE_MAXIMIZED_HORZ"},
                       GDK_WINDOW_STATE_MAXIMIZED);
        verifyDisabled(window);
        setWindowState(window, {}, static_cast<GdkWindowState>(0));
        await([&] { return allVisible(window, true); }, "Handles did not restore after unmaximize");
        setWindowState(window, {"_NET_WM_STATE_FULLSCREEN"}, GDK_WINDOW_STATE_FULLSCREEN);
        verifyDisabled(window);
        setWindowState(window, {}, static_cast<GdkWindowState>(0));
        await([&] { return allVisible(window, true); }, "Handles did not restore after fullscreen");

        const auto oldHandles = handles(window);
        for (const auto& region : oldHandles) g_object_ref(region.window);
        gtk_widget_hide(window);
        require(allVisible(window, false), "Unmapped window retained visible handles");
        gtk_widget_unrealize(window);
        for (const auto& region : oldHandles) {
            require(gdk_window_is_destroyed(region.window), "Unrealize leaked a native resize handle");
            g_object_unref(region.window);
        }
        gtk_widget_show_all(window);
        await([&] { return gtk_widget_get_mapped(window) && allVisible(window, true); },
              "Resize handles did not restore after re-realize");
        verifyPerimeter(window, content);
        verifyRestacking(window);
        gtk_widget_destroy(window);
        g_object_unref(window);
        pump();
        std::puts("Linux GTK window resize tests passed");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "Linux GTK window resize test failed: %s\n", error.what());
        gtk_widget_destroy(window);
        g_object_unref(window);
        return 1;
    }
}
