#pragma once

#include <gtk/gtk.h>
#include <gdk/gdkx.h>
#include <X11/Xlib.h>
#include <algorithm>
#include <array>

namespace electrobun {

// Native input windows keep borderless content at (0, 0). GTK client-side
// decorations would add shadow offsets to WebKit and direct X11/WGPU children.
class GtkWindowResizeHandles {
public:
    explicit GtkWindowResizeHandles(GtkWidget* widget) : widget_(widget) {}

    void connect() {
        g_signal_connect_after(widget_, "realize", G_CALLBACK(onRealize), this);
        g_signal_connect_after(widget_, "map", G_CALLBACK(onMap), this);
        g_signal_connect(widget_, "unmap", G_CALLBACK(onUnmap), this);
        g_signal_connect(widget_, "unrealize", G_CALLBACK(onUnrealize), this);
        g_signal_connect_after(widget_, "size-allocate", G_CALLBACK(onSizeAllocate), this);
        g_signal_connect(widget_, "window-state-event", G_CALLBACK(onWindowState), this);
        g_signal_connect(widget_, "notify::resizable", G_CALLBACK(onResizable), this);
        g_signal_connect(widget_, "button-press-event", G_CALLBACK(onButtonPress), this);
        if (gtk_widget_get_realized(widget_)) create();
    }

private:
    GtkWidget* widget_;
    GdkWindow* parent_ = nullptr;
    std::array<GdkWindow*, 8> handles_{};

    bool enabled() const {
        if (!parent_ || !gtk_widget_get_mapped(widget_) ||
            !gtk_window_get_resizable(GTK_WINDOW(widget_))) return false;
        return !(gdk_window_get_state(parent_) &
                 (GDK_WINDOW_STATE_MAXIMIZED | GDK_WINDOW_STATE_FULLSCREEN));
    }

    bool owns(Window window) const {
        for (GdkWindow* handle : handles_) {
            if (handle && GDK_WINDOW_XID(handle) == window) return true;
        }
        return false;
    }

    void raise() {
        if (!enabled()) return;
        Display* display = GDK_WINDOW_XDISPLAY(parent_);
        for (GdkWindow* handle : handles_) {
            if (handle && gdk_window_is_visible(handle)) {
                // Keep GDK's clipping/stacking model in sync as well: a native
                // input window below a GTK child can otherwise be clipped to
                // an empty bounding shape even after an Xlib-only raise.
                gdk_window_raise(handle);
                // WGPU children are created directly with Xlib, outside GDK's
                // sibling list. Raise the actual X windows, not just GDK's list.
                XRaiseWindow(display, GDK_WINDOW_XID(handle));
            }
        }
    }

    static GdkFilterReturn onChildEvent(GdkXEvent* nativeEvent, GdkEvent*, gpointer data) {
        auto* self = static_cast<GtkWindowResizeHandles*>(data);
        const auto* event = static_cast<XEvent*>(nativeEvent);
        Window child = None;
        if (event->type == MapNotify) child = event->xmap.window;
        if (event->type == ConfigureNotify) child = event->xconfigure.window;
        if (child && child != GDK_WINDOW_XID(self->parent_) && !self->owns(child)) {
            self->raise();
        }
        // Ignore our own stacking notifications so raising cannot loop.
        return GDK_FILTER_CONTINUE;
    }

    void create() {
        if (parent_) return;
        parent_ = gtk_widget_get_window(widget_);
        if (!parent_ || !GDK_IS_X11_WINDOW(parent_)) {
            parent_ = nullptr;
            return;
        }

        constexpr const char* cursors[] = {
            "nw-resize", "n-resize", "ne-resize", "w-resize",
            "e-resize", "sw-resize", "s-resize", "se-resize",
        };
        for (unsigned i = 0; i < handles_.size(); ++i) {
            GdkWindowAttr attributes{};
            attributes.window_type = GDK_WINDOW_CHILD;
            attributes.wclass = GDK_INPUT_ONLY;
            attributes.width = attributes.height = 1;
            attributes.event_mask = GDK_BUTTON_PRESS_MASK | GDK_BUTTON_RELEASE_MASK |
                                    GDK_ENTER_NOTIFY_MASK | GDK_LEAVE_NOTIFY_MASK |
                                    GDK_POINTER_MOTION_MASK;
            handles_[i] = gdk_window_new(parent_, &attributes, GDK_WA_X | GDK_WA_Y);
            gdk_window_ensure_native(handles_[i]);
            gtk_widget_register_window(widget_, handles_[i]);
            GdkCursor* cursor = gdk_cursor_new_from_name(gdk_window_get_display(parent_), cursors[i]);
            gdk_window_set_cursor(handles_[i], cursor);
            if (cursor) g_object_unref(cursor);
        }

        // Catch child creation/restacking from both GTK and direct Xlib users.
        gdk_window_set_events(parent_, static_cast<GdkEventMask>(
            gdk_window_get_events(parent_) | GDK_SUBSTRUCTURE_MASK));
        gdk_window_add_filter(parent_, onChildEvent, this);
        update();
    }

    void update() {
        if (!parent_) return;
        if (!enabled()) {
            hide();
            return;
        }
        const int width = gtk_widget_get_allocated_width(widget_);
        const int height = gtk_widget_get_allocated_height(widget_);
        const int cornerX = std::min(16, width / 2);
        const int cornerY = std::min(16, height / 2);
        const int borderX = std::min(6, cornerX);
        const int borderY = std::min(6, cornerY);
        const GdkRectangle rectangles[] = {
            {0, 0, cornerX, cornerY},
            {cornerX, 0, width - 2 * cornerX, borderY},
            {width - cornerX, 0, cornerX, cornerY},
            {0, cornerY, borderX, height - 2 * cornerY},
            {width - borderX, cornerY, borderX, height - 2 * cornerY},
            {0, height - cornerY, cornerX, cornerY},
            {cornerX, height - borderY, width - 2 * cornerX, borderY},
            {width - cornerX, height - cornerY, cornerX, cornerY},
        };
        for (unsigned i = 0; i < handles_.size(); ++i) {
            const auto& rect = rectangles[i];
            if (rect.width <= 0 || rect.height <= 0) {
                gdk_window_hide(handles_[i]);
                continue;
            }
            gdk_window_move_resize(handles_[i], rect.x, rect.y, rect.width, rect.height);
            if (i == GDK_WINDOW_EDGE_NORTH_WEST || i == GDK_WINDOW_EDGE_NORTH_EAST ||
                i == GDK_WINDOW_EDGE_SOUTH_WEST || i == GDK_WINDOW_EDGE_SOUTH_EAST) {
                const bool right = i == GDK_WINDOW_EDGE_NORTH_EAST || i == GDK_WINDOW_EDGE_SOUTH_EAST;
                const bool bottom = i == GDK_WINDOW_EDGE_SOUTH_WEST || i == GDK_WINDOW_EDGE_SOUTH_EAST;
                // Corners extend the diagonal cursor along each edge, without
                // intercepting buttons located inside the 6px perimeter.
                const cairo_rectangle_int_t horizontal = {
                    0, bottom ? cornerY - borderY : 0, cornerX, borderY,
                };
                const cairo_rectangle_int_t vertical = {
                    right ? cornerX - borderX : 0, 0, borderX, cornerY,
                };
                cairo_region_t* region = cairo_region_create_rectangle(&horizontal);
                cairo_region_union_rectangle(region, &vertical);
                gdk_window_input_shape_combine_region(handles_[i], region, 0, 0);
                cairo_region_destroy(region);
            }
            gdk_window_show_unraised(handles_[i]);
        }
        raise();
    }

    void hide() {
        for (GdkWindow* handle : handles_) {
            if (handle) gdk_window_hide(handle);
        }
    }

    void destroy() {
        if (!parent_) return;
        gdk_window_remove_filter(parent_, onChildEvent, this);
        for (GdkWindow*& handle : handles_) {
            if (!handle) continue;
            gtk_widget_unregister_window(widget_, handle);
            gdk_window_destroy(handle);
            handle = nullptr;
        }
        parent_ = nullptr;
    }

    static void onRealize(GtkWidget*, gpointer data) {
        static_cast<GtkWindowResizeHandles*>(data)->create();
    }
    static void onMap(GtkWidget*, gpointer data) {
        static_cast<GtkWindowResizeHandles*>(data)->update();
    }
    static void onUnmap(GtkWidget*, gpointer data) {
        static_cast<GtkWindowResizeHandles*>(data)->hide();
    }
    static void onUnrealize(GtkWidget*, gpointer data) {
        static_cast<GtkWindowResizeHandles*>(data)->destroy();
    }
    static void onSizeAllocate(GtkWidget*, GtkAllocation*, gpointer data) {
        static_cast<GtkWindowResizeHandles*>(data)->update();
    }
    static gboolean onWindowState(GtkWidget*, GdkEventWindowState*, gpointer data) {
        static_cast<GtkWindowResizeHandles*>(data)->update();
        return FALSE;
    }
    static void onResizable(GObject*, GParamSpec*, gpointer data) {
        static_cast<GtkWindowResizeHandles*>(data)->update();
    }
    static gboolean onButtonPress(GtkWidget*, GdkEventButton* event, gpointer data) {
        auto* self = static_cast<GtkWindowResizeHandles*>(data);
        if (event->button != GDK_BUTTON_PRIMARY || event->type != GDK_BUTTON_PRESS || !self->enabled()) {
            return FALSE;
        }
        for (unsigned i = 0; i < self->handles_.size(); ++i) {
            if (event->window != self->handles_[i]) continue;
            gtk_window_begin_resize_drag(GTK_WINDOW(self->widget_), static_cast<GdkWindowEdge>(i),
                event->button, static_cast<gint>(event->x_root), static_cast<gint>(event->y_root), event->time);
            return TRUE;
        }
        return FALSE;
    }
};

inline void attachGtkWindowResizeHandles(GtkWidget* window) {
    constexpr const char* key = "electrobun-window-resize-handles";
    if (g_object_get_data(G_OBJECT(window), key)) return;
    auto* handles = new GtkWindowResizeHandles(window);
    g_object_set_data_full(G_OBJECT(window), key, handles, [](gpointer data) {
        delete static_cast<GtkWindowResizeHandles*>(data);
    });
    handles->connect();
}

} // namespace electrobun
