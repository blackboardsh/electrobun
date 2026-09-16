#include "../native_file_dialog.h"

#include <cassert>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

struct _GtkWindow {};
struct _GtkFileChooser {};
struct _GtkNativeDialog {};
struct _GtkFileFilter {};

struct _GtkFileChooserNative {
    std::string title;
    GtkWindow* parent = nullptr;
    GtkFileChooserAction action = GTK_FILE_CHOOSER_ACTION_OPEN;
    std::string accept_label;
    std::string cancel_label;
    bool select_multiple = false;
    std::string current_folder;
    std::string current_name;
    std::vector<GtkFileFilter*> filters;
    std::vector<std::string> selected_paths;
    bool modal = false;
    gint response = GTK_RESPONSE_CANCEL;
};

static int create_count = 0;
static int unref_count = 0;
static int filename_free_count = 0;
static int list_free_count = 0;
static bool fail_creation = false;

static GtkFileChooserNative* asNative(void* value) {
    return static_cast<GtkFileChooserNative*>(value);
}

extern "C" GtkFileChooserNative* gtk_file_chooser_native_new(
    const char* title,
    GtkWindow* parent,
    GtkFileChooserAction action,
    const char* accept_label,
    const char* cancel_label) {
    ++create_count;
    if (fail_creation) {
        return nullptr;
    }

    auto* dialog = new GtkFileChooserNative();
    dialog->title = title ? title : "";
    dialog->parent = parent;
    dialog->action = action;
    dialog->accept_label = accept_label ? accept_label : "";
    dialog->cancel_label = cancel_label ? cancel_label : "";
    return dialog;
}

extern "C" void g_object_unref(gpointer object) {
    ++unref_count;
    delete asNative(object);
}

extern "C" void gtk_file_chooser_set_select_multiple(
    GtkFileChooser* chooser,
    gboolean enabled) {
    asNative(chooser)->select_multiple = enabled == TRUE;
}

extern "C" gboolean gtk_file_chooser_set_current_folder(
    GtkFileChooser* chooser,
    const char* folder) {
    asNative(chooser)->current_folder = folder ? folder : "";
    return TRUE;
}

extern "C" void gtk_file_chooser_set_current_name(
    GtkFileChooser* chooser,
    const char* name) {
    asNative(chooser)->current_name = name ? name : "";
}

extern "C" void gtk_file_chooser_add_filter(
    GtkFileChooser* chooser,
    GtkFileFilter* filter) {
    asNative(chooser)->filters.push_back(filter);
}

extern "C" void gtk_native_dialog_set_modal(
    GtkNativeDialog* dialog,
    gboolean modal) {
    asNative(dialog)->modal = modal == TRUE;
}

extern "C" gint gtk_native_dialog_run(GtkNativeDialog* dialog) {
    return asNative(dialog)->response;
}

extern "C" GSList* gtk_file_chooser_get_filenames(GtkFileChooser* chooser) {
    GSList* head = nullptr;
    GSList* tail = nullptr;

    for (const auto& path : asNative(chooser)->selected_paths) {
        auto* value = static_cast<char*>(std::malloc(path.size() + 1));
        std::memcpy(value, path.c_str(), path.size() + 1);
        auto* node = static_cast<GSList*>(std::malloc(sizeof(GSList)));
        node->data = value;
        node->next = nullptr;
        if (tail) {
            tail->next = node;
        } else {
            head = node;
        }
        tail = node;
    }

    return head;
}

extern "C" void g_free(gpointer memory) {
    ++filename_free_count;
    std::free(memory);
}

extern "C" void g_slist_free(GSList* list) {
    ++list_free_count;
    while (list) {
        GSList* next = list->next;
        std::free(list);
        list = next;
    }
}

int main() {
    GtkWindow parent;
    GtkFileFilter filter;

    {
        electrobun::LinuxNativeFileDialog dialog(
            "Select files",
            &parent,
            GTK_FILE_CHOOSER_ACTION_OPEN,
            "_Open");
        assert(dialog.valid());

        GtkFileChooserNative* native = dialog.nativeDialog();
        assert(native->title == "Select files");
        assert(native->parent == &parent);
        assert(native->action == GTK_FILE_CHOOSER_ACTION_OPEN);
        assert(native->accept_label == "_Open");
        assert(native->cancel_label == "_Cancel");
        assert(native->modal);

        dialog.setSelectMultiple(true);
        dialog.setCurrentFolder("/tmp/start");
        dialog.setCurrentName("save.txt");
        dialog.addFilter(&filter);
        assert(native->select_multiple);
        assert(native->current_folder == "/tmp/start");
        assert(native->current_name == "save.txt");
        assert(native->filters.size() == 1);
        assert(native->filters[0] == &filter);

        native->selected_paths = {"/tmp/one.txt", "/tmp/two,comma.txt"};
        native->response = GTK_RESPONSE_ACCEPT;
        assert(dialog.run() == GTK_RESPONSE_ACCEPT);
        assert(dialog.selectedPaths() == native->selected_paths);
    }

    assert(create_count == 1);
    assert(unref_count == 1);
    assert(filename_free_count == 2);
    assert(list_free_count == 1);

    {
        electrobun::LinuxNativeFileDialog dialog(
            "Save file",
            nullptr,
            GTK_FILE_CHOOSER_ACTION_SAVE,
            "_Save");
        assert(dialog.valid());
        assert(dialog.run() == GTK_RESPONSE_CANCEL);
        assert(dialog.nativeDialog()->action == GTK_FILE_CHOOSER_ACTION_SAVE);
    }

    {
        electrobun::LinuxNativeFileDialog dialog(
            "Select folder",
            nullptr,
            GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER,
            "_Select");
        assert(dialog.valid());
        assert(dialog.nativeDialog()->action == GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER);
        assert(dialog.nativeDialog()->accept_label == "_Select");
    }

    fail_creation = true;
    {
        electrobun::LinuxNativeFileDialog dialog(
            "Unavailable",
            nullptr,
            GTK_FILE_CHOOSER_ACTION_OPEN,
            "_Open");
        assert(!dialog.valid());
    }

    assert(create_count == 4);
    assert(unref_count == 3);
    return 0;
}
