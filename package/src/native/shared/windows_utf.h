#ifndef ELECTROBUN_WINDOWS_UTF_H
#define ELECTROBUN_WINDOWS_UTF_H

#include <cstddef>
#include <cwchar>
#include <limits>
#include <string>
#include <string_view>

#ifdef _WIN32
#include <windows.h>
#endif

namespace electrobun {

#ifdef _WIN32

inline bool utf8ToWide(std::string_view input, std::wstring& output) {
    output.clear();
    if (input.empty()) {
        return true;
    }
    if (input.size() > static_cast<size_t>(std::numeric_limits<int>::max())) {
        return false;
    }

    const int inputLength = static_cast<int>(input.size());
    const int outputLength = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, input.data(), inputLength, nullptr, 0);
    if (outputLength <= 0) {
        return false;
    }

    output.resize(static_cast<size_t>(outputLength));
    return MultiByteToWideChar(
               CP_UTF8,
               MB_ERR_INVALID_CHARS,
               input.data(),
               inputLength,
               output.data(),
               outputLength) == outputLength;
}

inline bool wideToUtf8(std::wstring_view input, std::string& output) {
    output.clear();
    if (input.empty()) {
        return true;
    }
    if (input.size() > static_cast<size_t>(std::numeric_limits<int>::max())) {
        return false;
    }

    const int inputLength = static_cast<int>(input.size());
    const int outputLength = WideCharToMultiByte(
        CP_UTF8, WC_ERR_INVALID_CHARS, input.data(), inputLength, nullptr, 0,
        nullptr, nullptr);
    if (outputLength <= 0) {
        return false;
    }

    output.resize(static_cast<size_t>(outputLength));
    return WideCharToMultiByte(
               CP_UTF8,
               WC_ERR_INVALID_CHARS,
               input.data(),
               inputLength,
               output.data(),
               outputLength,
               nullptr,
               nullptr) == outputLength;
}

inline bool appendMenuUtf8(
    HMENU menu,
    UINT flags,
    UINT_PTR item,
    std::string_view label
) {
    std::wstring wideLabel;
    if (!utf8ToWide(label, wideLabel)) {
        return false;
    }
    return AppendMenuW(menu, flags, item, wideLabel.c_str()) != FALSE;
}

inline bool modifyMenuUtf8(
    HMENU menu,
    UINT position,
    UINT flags,
    UINT_PTR item,
    std::string_view label
) {
    std::wstring wideLabel;
    if (!utf8ToWide(label, wideLabel)) {
        return false;
    }
    return ModifyMenuW(menu, position, flags, item, wideLabel.c_str()) != FALSE;
}

inline bool setWindowTextUtf8(HWND window, std::string_view title) {
    std::wstring wideTitle;
    if (!utf8ToWide(title, wideTitle)) {
        return false;
    }
    return SetWindowTextW(window, wideTitle.c_str()) != FALSE;
}

inline int messageBoxUtf8(
    HWND owner,
    std::string_view message,
    std::string_view title,
    UINT type
) {
    std::wstring wideMessage;
    std::wstring wideTitle;
    if (!utf8ToWide(message, wideMessage) || !utf8ToWide(title, wideTitle)) {
        return 0;
    }
    return MessageBoxW(owner, wideMessage.c_str(), wideTitle.c_str(), type);
}

template <size_t Capacity>
inline void copyWideToBuffer(
    std::wstring_view wideText,
    wchar_t (&buffer)[Capacity]
) {
    static_assert(Capacity > 0);

    size_t length = wideText.size();
    if (length >= Capacity) {
        length = Capacity - 1;
        // Do not truncate between the UTF-16 surrogate pair used for a
        // supplementary-plane code point.
        if (length > 0 &&
            wideText[length - 1] >= 0xD800 &&
            wideText[length - 1] <= 0xDBFF) {
            --length;
        }
    }
    if (length > 0) {
        std::wmemcpy(buffer, wideText.data(), length);
    }
    buffer[length] = L'\0';
}

template <size_t Capacity>
inline bool copyUtf8ToWideBuffer(
    std::string_view input,
    wchar_t (&buffer)[Capacity]
) {
    static_assert(Capacity > 0);
    std::wstring wideText;
    if (!utf8ToWide(input, wideText)) {
        buffer[0] = L'\0';
        return false;
    }

    copyWideToBuffer(wideText, buffer);
    return true;
}

#endif

} // namespace electrobun

#endif // ELECTROBUN_WINDOWS_UTF_H
