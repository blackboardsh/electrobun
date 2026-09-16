#ifndef ELECTROBUN_WINDOWS_DIALOG_OPTIONS_H
#define ELECTROBUN_WINDOWS_DIALOG_OPTIONS_H

#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "windows_utf.h"

namespace electrobun {

#ifdef _WIN32

constexpr int WINDOWS_TASK_DIALOG_BUTTON_ID_BASE = 1000;

inline bool parseWindowsDialogButtonLabels(
    std::string_view serializedLabels,
    std::vector<std::wstring>& labels
) {
    labels.clear();

    size_t position = 0;
    while (position <= serializedLabels.size()) {
        const size_t delimiter = serializedLabels.find(',', position);
        const size_t end = delimiter == std::string_view::npos
            ? serializedLabels.size()
            : delimiter;
        std::string_view label = serializedLabels.substr(position, end - position);

        const size_t first = label.find_first_not_of(" \t");
        if (first != std::string_view::npos) {
            const size_t last = label.find_last_not_of(" \t");
            std::wstring wideLabel;
            if (!utf8ToWide(label.substr(first, last - first + 1), wideLabel)) {
                labels.clear();
                return false;
            }
            labels.push_back(std::move(wideLabel));
        }

        if (delimiter == std::string_view::npos) {
            break;
        }
        position = delimiter + 1;
    }

    if (labels.empty()) {
        labels.push_back(L"OK");
    }
    return true;
}

inline int windowsTaskDialogButtonId(size_t index) {
    return WINDOWS_TASK_DIALOG_BUTTON_ID_BASE + static_cast<int>(index);
}

inline int windowsTaskDialogButtonIndex(
    int buttonId,
    size_t buttonCount,
    int cancelId
) {
    if (buttonId == IDCANCEL) {
        return cancelId >= 0 && cancelId < static_cast<int>(buttonCount)
            ? cancelId
            : -1;
    }

    const int index = buttonId - WINDOWS_TASK_DIALOG_BUTTON_ID_BASE;
    return index >= 0 && index < static_cast<int>(buttonCount) ? index : -1;
}

inline int normalizeWindowsDialogDefaultId(int defaultId, size_t buttonCount) {
    return defaultId >= 0 && defaultId < static_cast<int>(buttonCount)
        ? defaultId
        : 0;
}

#endif

} // namespace electrobun

#endif // ELECTROBUN_WINDOWS_DIALOG_OPTIONS_H
