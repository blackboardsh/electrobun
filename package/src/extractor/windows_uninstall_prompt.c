#include <windows.h>
#include <commctrl.h>

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>

enum {
    ELECTROBUN_INSTALLER_CLOSE_BUTTON = 200,
};

enum {
    ELECTROBUN_INSTALLER_RUNNING = 0,
    ELECTROBUN_INSTALLER_SUCCEEDED = 1,
    ELECTROBUN_INSTALLER_FAILED = 2,
    ELECTROBUN_INSTALLER_CLOSING = 3,
};

/* Windows rendering adapter for the shared Zig install-progress state. The
   calling thread owns the opaque handle. Phase/progress updates are delivered
   synchronously to a Task Dialog on a dedicated UI thread. Complete publishes
   a terminal state and waits for Close; close joins the thread and frees it.
   No button may dismiss an in-progress install. */
typedef struct ElectrobunInstallerUi {
    HANDLE thread;
    HANDLE ready_event;
    PVOID volatile window;
    volatile LONG start_state;
    volatile LONG terminal_state;
    int autoclose;
    wchar_t *window_title;
    wchar_t *install_instruction;
} ElectrobunInstallerUi;

static wchar_t *join_wide_strings(
    const wchar_t *prefix,
    const wchar_t *value,
    const wchar_t *suffix) {
    const size_t prefix_length = wcslen(prefix);
    const size_t value_length = wcslen(value);
    const size_t suffix_length = wcslen(suffix);
    size_t total_length;
    wchar_t *result;

    if (prefix_length > SIZE_MAX - value_length ||
        prefix_length + value_length > SIZE_MAX - suffix_length) {
        return NULL;
    }
    total_length = prefix_length + value_length + suffix_length;
    if (total_length > SIZE_MAX / sizeof(wchar_t) - 1) return NULL;
    result = (wchar_t *)HeapAlloc(
        GetProcessHeap(), 0, (total_length + 1) * sizeof(wchar_t));
    if (result == NULL) return NULL;
    memcpy(result, prefix, prefix_length * sizeof(wchar_t));
    memcpy(
        result + prefix_length,
        value,
        value_length * sizeof(wchar_t));
    memcpy(
        result + prefix_length + value_length,
        suffix,
        (suffix_length + 1) * sizeof(wchar_t));
    return result;
}

static int installer_ui_autoclose_enabled(void) {
    static const wchar_t variable_name[] =
        L"ELECTROBUN_INSTALLER_UI_AUTOCLOSE";
    wchar_t value[2] = {0, 0};
    const DWORD length = GetEnvironmentVariableW(
        variable_name, value, ARRAYSIZE(value));
    return length == 1 && value[0] == L'1';
}

static HWND installer_ui_window(ElectrobunInstallerUi *ui) {
    return (HWND)InterlockedCompareExchangePointer(
        &ui->window, NULL, NULL);
}

static void set_installer_progress_mode(HWND window, int marquee) {
    if (marquee) {
        SendMessageW(
            window, TDM_SET_MARQUEE_PROGRESS_BAR, (WPARAM)TRUE, 0);
        SendMessageW(
            window,
            TDM_SET_PROGRESS_BAR_MARQUEE,
            (WPARAM)TRUE,
            (LPARAM)30);
        return;
    }

    SendMessageW(
        window, TDM_SET_PROGRESS_BAR_MARQUEE, (WPARAM)FALSE, 0);
    SendMessageW(
        window, TDM_SET_MARQUEE_PROGRESS_BAR, (WPARAM)FALSE, 0);
    SendMessageW(
        window,
        TDM_SET_PROGRESS_BAR_RANGE,
        0,
        (LPARAM)MAKELPARAM(0, 100));
}

static HRESULT CALLBACK installer_task_dialog_callback(
    HWND window,
    UINT notification,
    WPARAM wparam,
    LPARAM lparam,
    LONG_PTR callback_data) {
    ElectrobunInstallerUi *ui =
        (ElectrobunInstallerUi *)callback_data;
    (void)lparam;

    switch (notification) {
        case TDN_CREATED:
            InterlockedExchangePointer(&ui->window, window);
            SendMessageW(
                window,
                TDM_ENABLE_BUTTON,
                (WPARAM)ELECTROBUN_INSTALLER_CLOSE_BUTTON,
                (LPARAM)FALSE);
            set_installer_progress_mode(window, 1);
            InterlockedExchange(&ui->start_state, 1);
            SetEvent(ui->ready_event);
            return S_OK;
        case TDN_BUTTON_CLICKED:
            if ((int)wparam == ELECTROBUN_INSTALLER_CLOSE_BUTTON) {
                const LONG state = InterlockedCompareExchange(
                    &ui->terminal_state,
                    ELECTROBUN_INSTALLER_RUNNING,
                    ELECTROBUN_INSTALLER_RUNNING);
                /* TaskDialog keeps the dialog open for S_FALSE and closes it
                   for S_OK. Keep it alive even if a synthetic click reaches
                   its disabled button while an installation is still running. */
                return state == ELECTROBUN_INSTALLER_RUNNING
                    ? S_FALSE
                    : S_OK;
            }
            return S_FALSE;
        case TDN_DESTROYED:
            InterlockedExchangePointer(&ui->window, NULL);
            return S_OK;
        default:
            return S_OK;
    }
}

static DWORD WINAPI installer_ui_thread(LPVOID parameter) {
    static const wchar_t initial_content[] = L"Preparing installation...";
    static const TASKDIALOG_BUTTON close_button = {
        ELECTROBUN_INSTALLER_CLOSE_BUTTON,
        L"Close",
    };
    ElectrobunInstallerUi *ui = (ElectrobunInstallerUi *)parameter;
    INITCOMMONCONTROLSEX controls = {
        sizeof(controls),
        ICC_PROGRESS_CLASS,
    };
    TASKDIALOGCONFIG config = {0};
    int pressed_button = 0;
    HRESULT result;

    InitCommonControlsEx(&controls);
    config.cbSize = sizeof(config);
    config.hInstance = GetModuleHandleW(NULL);
    config.dwFlags =
        TDF_SHOW_MARQUEE_PROGRESS_BAR |
        TDF_CAN_BE_MINIMIZED |
        TDF_SIZE_TO_CONTENT;
    if (ui->autoclose) config.dwFlags |= TDF_NO_SET_FOREGROUND;
    config.pszWindowTitle = ui->window_title;
    config.pszMainInstruction = ui->install_instruction;
    config.pszContent = initial_content;
    config.pszMainIcon = TD_INFORMATION_ICON;
    config.cButtons = 1;
    config.pButtons = &close_button;
    config.nDefaultButton = ELECTROBUN_INSTALLER_CLOSE_BUTTON;
    config.pfCallback = installer_task_dialog_callback;
    config.lpCallbackData = (LONG_PTR)ui;

    result = TaskDialogIndirect(
        &config, &pressed_button, NULL, NULL);
    InterlockedExchangePointer(&ui->window, NULL);
    if (InterlockedCompareExchange(&ui->start_state, -1, 0) == 0) {
        SetEvent(ui->ready_event);
    }
    return FAILED(result) ? 1 : 0;
}

static void free_installer_ui(ElectrobunInstallerUi *ui) {
    if (ui == NULL) return;
    if (ui->thread != NULL) CloseHandle(ui->thread);
    if (ui->ready_event != NULL) CloseHandle(ui->ready_event);
    if (ui->window_title != NULL) {
        HeapFree(GetProcessHeap(), 0, ui->window_title);
    }
    if (ui->install_instruction != NULL) {
        HeapFree(GetProcessHeap(), 0, ui->install_instruction);
    }
    HeapFree(GetProcessHeap(), 0, ui);
}

void *electrobun_windows_installer_ui_start(const wchar_t *app_name) {
    ElectrobunInstallerUi *ui;
    DWORD thread_id = 0;
    DWORD wait_result;

    if (app_name == NULL || app_name[0] == L'\0') return NULL;
    ui = (ElectrobunInstallerUi *)HeapAlloc(
        GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*ui));
    if (ui == NULL) return NULL;
    ui->autoclose = installer_ui_autoclose_enabled();
    ui->window_title = join_wide_strings(L"", app_name, L" Setup");
    ui->install_instruction =
        join_wide_strings(L"Installing ", app_name, L"");
    ui->ready_event = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (ui->window_title == NULL ||
        ui->install_instruction == NULL ||
        ui->ready_event == NULL) {
        free_installer_ui(ui);
        return NULL;
    }

    ui->thread = CreateThread(
        NULL, 0, installer_ui_thread, ui, 0, &thread_id);
    if (ui->thread == NULL) {
        free_installer_ui(ui);
        return NULL;
    }
    wait_result = WaitForSingleObject(ui->ready_event, INFINITE);
    if (wait_result != WAIT_OBJECT_0 ||
        InterlockedCompareExchange(&ui->start_state, 0, 0) != 1) {
        WaitForSingleObject(ui->thread, INFINITE);
        free_installer_ui(ui);
        return NULL;
    }
    return ui;
}

void electrobun_windows_installer_ui_set_phase(
    void *opaque_ui,
    const wchar_t *phase,
    int marquee) {
    ElectrobunInstallerUi *ui =
        (ElectrobunInstallerUi *)opaque_ui;
    HWND window;

    if (ui == NULL || phase == NULL || phase[0] == L'\0') return;
    if (InterlockedCompareExchange(
            &ui->terminal_state,
            ELECTROBUN_INSTALLER_RUNNING,
            ELECTROBUN_INSTALLER_RUNNING) !=
        ELECTROBUN_INSTALLER_RUNNING) {
        return;
    }
    window = installer_ui_window(ui);
    if (window == NULL) return;
    SendMessageW(
        window,
        TDM_SET_ELEMENT_TEXT,
        (WPARAM)TDE_CONTENT,
        (LPARAM)phase);
    set_installer_progress_mode(window, marquee != 0);
}

void electrobun_windows_installer_ui_set_progress(
    void *opaque_ui,
    unsigned int percent) {
    ElectrobunInstallerUi *ui =
        (ElectrobunInstallerUi *)opaque_ui;
    HWND window;

    if (ui == NULL) return;
    if (InterlockedCompareExchange(
            &ui->terminal_state,
            ELECTROBUN_INSTALLER_RUNNING,
            ELECTROBUN_INSTALLER_RUNNING) !=
        ELECTROBUN_INSTALLER_RUNNING) {
        return;
    }
    window = installer_ui_window(ui);
    if (window == NULL) return;
    if (percent > 100) percent = 100;
    set_installer_progress_mode(window, 0);
    SendMessageW(
        window,
        TDM_SET_PROGRESS_BAR_STATE,
        (WPARAM)PBST_NORMAL,
        0);
    SendMessageW(
        window, TDM_SET_PROGRESS_BAR_POS, (WPARAM)percent, 0);
}

void electrobun_windows_installer_ui_complete(
    void *opaque_ui,
    int succeeded,
    const wchar_t *message) {
    static const wchar_t success_instruction[] =
        L"Installation complete";
    static const wchar_t failure_instruction[] =
        L"Installation failed";
    static const wchar_t success_content[] =
        L"The application was installed successfully.";
    static const wchar_t failure_content[] =
        L"The installer could not complete. Try again or contact the application publisher.";
    ElectrobunInstallerUi *ui =
        (ElectrobunInstallerUi *)opaque_ui;
    const LONG terminal_state = succeeded
        ? ELECTROBUN_INSTALLER_SUCCEEDED
        : ELECTROBUN_INSTALLER_FAILED;
    const wchar_t *instruction = succeeded
        ? success_instruction
        : failure_instruction;
    const wchar_t *content = message != NULL && message[0] != L'\0'
        ? message
        : (succeeded ? success_content : failure_content);
    HWND window;

    if (ui == NULL) return;
    if (InterlockedCompareExchange(
            &ui->terminal_state,
            terminal_state,
            ELECTROBUN_INSTALLER_RUNNING) !=
        ELECTROBUN_INSTALLER_RUNNING) {
        WaitForSingleObject(ui->thread, INFINITE);
        return;
    }

    window = installer_ui_window(ui);
    if (window != NULL) {
        set_installer_progress_mode(window, 0);
        SendMessageW(
            window,
            TDM_SET_PROGRESS_BAR_STATE,
            (WPARAM)(succeeded ? PBST_NORMAL : PBST_ERROR),
            0);
        SendMessageW(
            window, TDM_SET_PROGRESS_BAR_POS, (WPARAM)100, 0);
        SendMessageW(
            window,
            TDM_SET_ELEMENT_TEXT,
            (WPARAM)TDE_MAIN_INSTRUCTION,
            (LPARAM)instruction);
        SendMessageW(
            window,
            TDM_SET_ELEMENT_TEXT,
            (WPARAM)TDE_CONTENT,
            (LPARAM)content);
        SendMessageW(
            window,
            TDM_UPDATE_ICON,
            (WPARAM)TDIE_ICON_MAIN,
            (LPARAM)(succeeded ? TD_INFORMATION_ICON : TD_ERROR_ICON));
        SendMessageW(
            window,
            TDM_ENABLE_BUTTON,
            (WPARAM)ELECTROBUN_INSTALLER_CLOSE_BUTTON,
            (LPARAM)TRUE);
        if (ui->autoclose) {
            SendMessageW(
                window,
                TDM_CLICK_BUTTON,
                (WPARAM)ELECTROBUN_INSTALLER_CLOSE_BUTTON,
                0);
        } else {
            SetForegroundWindow(window);
            FlashWindow(window, TRUE);
        }
    }
    WaitForSingleObject(ui->thread, INFINITE);
}

void electrobun_windows_installer_ui_close(void *opaque_ui) {
    ElectrobunInstallerUi *ui =
        (ElectrobunInstallerUi *)opaque_ui;
    HWND window;

    if (ui == NULL) return;
    InterlockedCompareExchange(
        &ui->terminal_state,
        ELECTROBUN_INSTALLER_CLOSING,
        ELECTROBUN_INSTALLER_RUNNING);
    window = installer_ui_window(ui);
    if (window != NULL) {
        SendMessageW(
            window,
            TDM_ENABLE_BUTTON,
            (WPARAM)ELECTROBUN_INSTALLER_CLOSE_BUTTON,
            (LPARAM)TRUE);
        SendMessageW(
            window,
            TDM_CLICK_BUTTON,
            (WPARAM)ELECTROBUN_INSTALLER_CLOSE_BUTTON,
            0);
    }
    WaitForSingleObject(ui->thread, INFINITE);
    free_installer_ui(ui);
}

static int build_temporary_manager_path(
    const wchar_t *destination_path,
    wchar_t **temporary_path) {
    static volatile LONG counter = 0;
    const size_t destination_length = wcslen(destination_path);
    const size_t suffix_capacity = 64;
    wchar_t *path;
    int suffix_length;

    if (destination_length > SIZE_MAX / sizeof(wchar_t) - suffix_capacity) {
        return 0;
    }
    path = (wchar_t *)HeapAlloc(
        GetProcessHeap(),
        0,
        (destination_length + suffix_capacity) * sizeof(wchar_t));
    if (path == NULL) return 0;
    memcpy(path, destination_path, destination_length * sizeof(wchar_t));
    suffix_length = swprintf_s(
        path + destination_length,
        suffix_capacity,
        L".tmp-%lu-%ld",
        GetCurrentProcessId(),
        InterlockedIncrement(&counter));
    if (suffix_length < 0) {
        HeapFree(GetProcessHeap(), 0, path);
        return 0;
    }
    *temporary_path = path;
    return 1;
}

int electrobun_atomic_copy_windows_manager(
    const wchar_t *source_path,
    const wchar_t *destination_path) {
    wchar_t *temporary_path = NULL;
    DWORD source_attributes;
    DWORD destination_attributes;
    int result = 0;

    if (source_path == NULL || source_path[0] == L'\0' ||
        destination_path == NULL || destination_path[0] == L'\0' ||
        !build_temporary_manager_path(destination_path, &temporary_path)) {
        return 0;
    }
    source_attributes = GetFileAttributesW(source_path);
    if (source_attributes == INVALID_FILE_ATTRIBUTES ||
        (source_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
        goto cleanup;
    }
    destination_attributes = GetFileAttributesW(destination_path);
    if (destination_attributes != INVALID_FILE_ATTRIBUTES &&
        (destination_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
        goto cleanup;
    }

    if (!CopyFileW(source_path, temporary_path, TRUE)) goto cleanup;
    if (!MoveFileExW(
            temporary_path,
            destination_path,
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        goto cleanup;
    }
    result = 1;

cleanup:
    if (temporary_path != NULL) {
        if (!result) DeleteFileW(temporary_path);
        HeapFree(GetProcessHeap(), 0, temporary_path);
    }
    return result;
}

int electrobun_read_windows_file_exact(
    const wchar_t *path,
    unsigned char *buffer,
    size_t expected_size) {
    HANDLE file;
    size_t offset = 0;
    DWORD attributes;

    if (path == NULL || path[0] == L'\0' ||
        (buffer == NULL && expected_size != 0) ||
        expected_size > 64 * 1024) {
        return 0;
    }
    attributes = GetFileAttributesW(path);
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
        return 0;
    }
    file = CreateFileW(
        path,
        GENERIC_READ,
        FILE_SHARE_READ,
        NULL,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
        NULL);
    if (file == INVALID_HANDLE_VALUE) return 0;

    while (offset < expected_size) {
        DWORD bytes_read = 0;
        DWORD requested = (DWORD)(expected_size - offset);
        if (!ReadFile(file, buffer + offset, requested, &bytes_read, NULL) ||
            bytes_read == 0) {
            CloseHandle(file);
            return 0;
        }
        offset += bytes_read;
    }
    {
        unsigned char extra;
        DWORD extra_read = 0;
        if (!ReadFile(file, &extra, 1, &extra_read, NULL) || extra_read != 0) {
            CloseHandle(file);
            return 0;
        }
    }
    CloseHandle(file);
    return 1;
}

enum {
    ELECTROBUN_UNINSTALL_CANCEL = 0,
    ELECTROBUN_UNINSTALL_APP = 1,
    ELECTROBUN_UNINSTALL_APP_AND_DATA = 2,
};

enum {
    ELECTROBUN_BUTTON_APP = 100,
    ELECTROBUN_BUTTON_APP_AND_DATA = 101,
};

static int show_windows_uninstall_prompt(
    const wchar_t *app_name,
    const wchar_t *message) {
    static const wchar_t title_prefix[] = L"Uninstall ";
    static const wchar_t title_suffix[] = L"?";
    const size_t prefix_length = ARRAYSIZE(title_prefix) - 1;
    const size_t suffix_length = ARRAYSIZE(title_suffix) - 1;
    size_t app_name_length;
    size_t title_length;
    wchar_t *title;

    if (app_name == NULL || app_name[0] == L'\0') {
        return ELECTROBUN_UNINSTALL_CANCEL;
    }

    app_name_length = wcslen(app_name);
    if (app_name_length >
        (SIZE_MAX / sizeof(wchar_t)) - prefix_length - suffix_length - 1) {
        return ELECTROBUN_UNINSTALL_CANCEL;
    }

    title_length = prefix_length + app_name_length + suffix_length;
    title = (wchar_t *)HeapAlloc(
        GetProcessHeap(), 0, (title_length + 1) * sizeof(wchar_t));
    if (title == NULL) {
        return ELECTROBUN_UNINSTALL_CANCEL;
    }

    memcpy(title, title_prefix, prefix_length * sizeof(wchar_t));
    memcpy(
        title + prefix_length,
        app_name,
        app_name_length * sizeof(wchar_t));
    memcpy(
        title + prefix_length + app_name_length,
        title_suffix,
        (suffix_length + 1) * sizeof(wchar_t));

    const TASKDIALOG_BUTTON buttons[] = {
        {ELECTROBUN_BUTTON_APP, L"App"},
        {ELECTROBUN_BUTTON_APP_AND_DATA, L"App and Data"},
        {IDCANCEL, L"Cancel"},
    };
    TASKDIALOGCONFIG config = {0};
    int pressed_button = IDCANCEL;

    config.cbSize = sizeof(config);
    config.hInstance = GetModuleHandleW(NULL);
    config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT;
    /* Keep the title-bar label compact; the requested prompt title belongs in
       Task Dialog's main-instruction area, matching NSAlert.messageText. */
    config.pszWindowTitle = app_name;
    config.pszMainInstruction = title;
    config.pszContent = message;
    config.cButtons = ARRAYSIZE(buttons);
    config.pButtons = buttons;
    config.nDefaultButton = ELECTROBUN_BUTTON_APP;

    const HRESULT result =
        TaskDialogIndirect(&config, &pressed_button, NULL, NULL);
    HeapFree(GetProcessHeap(), 0, title);

    if (FAILED(result)) {
        return ELECTROBUN_UNINSTALL_CANCEL;
    }
    if (pressed_button == ELECTROBUN_BUTTON_APP) {
        return ELECTROBUN_UNINSTALL_APP;
    }
    if (pressed_button == ELECTROBUN_BUTTON_APP_AND_DATA) {
        return ELECTROBUN_UNINSTALL_APP_AND_DATA;
    }
    return ELECTROBUN_UNINSTALL_CANCEL;
}

int electrobun_show_windows_uninstall_prompt(const wchar_t *app_name) {
    static const wchar_t message[] = L"The application will be removed.";
    return show_windows_uninstall_prompt(app_name, message);
}

int electrobun_preview_windows_uninstall_prompt(const wchar_t *app_name) {
    static const wchar_t message[] =
        L"UI preview only; no files will be removed.";
    return show_windows_uninstall_prompt(app_name, message);
}
