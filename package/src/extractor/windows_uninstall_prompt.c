#include <windows.h>
#include <commctrl.h>

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>

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

int electrobun_show_windows_uninstall_prompt(const wchar_t *app_name) {
    static const wchar_t title_prefix[] = L"Uninstall ";
    static const wchar_t title_suffix[] = L"?";
    static const wchar_t message[] = L"The application will be removed.";
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
