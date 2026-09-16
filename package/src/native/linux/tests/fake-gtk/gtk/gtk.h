#pragma once

#include <stddef.h>

typedef int gboolean;
typedef int gint;
typedef char gchar;
typedef void* gpointer;

#ifndef TRUE
#define TRUE 1
#endif
#ifndef FALSE
#define FALSE 0
#endif

typedef enum {
    GTK_FILE_CHOOSER_ACTION_OPEN,
    GTK_FILE_CHOOSER_ACTION_SAVE,
    GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER,
    GTK_FILE_CHOOSER_ACTION_CREATE_FOLDER,
} GtkFileChooserAction;

typedef struct _GtkWindow GtkWindow;
typedef struct _GtkFileChooser GtkFileChooser;
typedef struct _GtkFileChooserNative GtkFileChooserNative;
typedef struct _GtkNativeDialog GtkNativeDialog;
typedef struct _GtkFileFilter GtkFileFilter;

typedef struct _GSList {
    gpointer data;
    struct _GSList* next;
} GSList;

#define GTK_FILE_CHOOSER(value) ((GtkFileChooser*)(value))
#define GTK_NATIVE_DIALOG(value) ((GtkNativeDialog*)(value))

#define GTK_RESPONSE_CANCEL (-6)
#define GTK_RESPONSE_ACCEPT (-3)

#ifdef __cplusplus
extern "C" {
#endif

GtkFileChooserNative* gtk_file_chooser_native_new(
    const char* title,
    GtkWindow* parent,
    GtkFileChooserAction action,
    const char* accept_label,
    const char* cancel_label);
void g_object_unref(gpointer object);
void gtk_file_chooser_set_select_multiple(GtkFileChooser* chooser, gboolean enabled);
gboolean gtk_file_chooser_set_current_folder(GtkFileChooser* chooser, const char* folder);
void gtk_file_chooser_set_current_name(GtkFileChooser* chooser, const char* name);
void gtk_file_chooser_add_filter(GtkFileChooser* chooser, GtkFileFilter* filter);
void gtk_native_dialog_set_modal(GtkNativeDialog* dialog, gboolean modal);
gint gtk_native_dialog_run(GtkNativeDialog* dialog);
GSList* gtk_file_chooser_get_filenames(GtkFileChooser* chooser);
void g_free(gpointer memory);
void g_slist_free(GSList* list);

#ifdef __cplusplus
}
#endif
