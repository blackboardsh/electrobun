#pragma once

#include <gtk/gtk.h>

#include <string>
#include <vector>

namespace electrobun {

// GtkFileChooserNative delegates to desktop portals where available. Keep its
// GObject lifetime and the GLib-owned filename list behind one small wrapper.
class LinuxNativeFileDialog final {
  public:
    LinuxNativeFileDialog(const char* title,
                          GtkWindow* parent,
                          GtkFileChooserAction action,
                          const char* accept_label,
                          const char* cancel_label = "_Cancel")
        : dialog_(gtk_file_chooser_native_new(
              title, parent, action, accept_label, cancel_label)) {
        if (dialog_) {
            gtk_native_dialog_set_modal(GTK_NATIVE_DIALOG(dialog_), TRUE);
        }
    }

    ~LinuxNativeFileDialog() {
        if (dialog_) {
            g_object_unref(dialog_);
        }
    }

    LinuxNativeFileDialog(const LinuxNativeFileDialog&) = delete;
    LinuxNativeFileDialog& operator=(const LinuxNativeFileDialog&) = delete;

    bool valid() const { return dialog_ != nullptr; }

    GtkFileChooserNative* nativeDialog() const { return dialog_; }

    GtkFileChooser* chooser() const {
        return dialog_ ? GTK_FILE_CHOOSER(dialog_) : nullptr;
    }

    void setSelectMultiple(bool enabled) {
        gtk_file_chooser_set_select_multiple(chooser(), enabled ? TRUE : FALSE);
    }

    void setCurrentFolder(const char* folder) {
        if (folder && folder[0] != '\0') {
            gtk_file_chooser_set_current_folder(chooser(), folder);
        }
    }

    void setCurrentName(const char* name) {
        if (name && name[0] != '\0') {
            gtk_file_chooser_set_current_name(chooser(), name);
        }
    }

    void addFilter(GtkFileFilter* filter) {
        gtk_file_chooser_add_filter(chooser(), filter);
    }

    gint run() {
        return gtk_native_dialog_run(GTK_NATIVE_DIALOG(dialog_));
    }

    std::vector<std::string> selectedPaths() const {
        std::vector<std::string> paths;
        GSList* filenames = gtk_file_chooser_get_filenames(chooser());
        for (GSList* current = filenames; current; current = current->next) {
            const char* filename = static_cast<const char*>(current->data);
            if (filename) {
                paths.emplace_back(filename);
            }
            g_free(current->data);
        }
        g_slist_free(filenames);
        return paths;
    }

  private:
    GtkFileChooserNative* dialog_ = nullptr;
};

} // namespace electrobun
