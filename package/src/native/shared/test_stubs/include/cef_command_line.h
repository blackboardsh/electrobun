#ifndef ELECTROBUN_TEST_CEF_COMMAND_LINE_H
#define ELECTROBUN_TEST_CEF_COMMAND_LINE_H

#include <string>
#include <utility>
#include <vector>

template <typename Type>
class CefRefPtr {
public:
    explicit CefRefPtr(Type* pointer) : pointer_(pointer) {}

    Type* operator->() const {
        return pointer_;
    }

private:
    Type* pointer_;
};

class CefCommandLine {
public:
    void AppendSwitch(const std::string& name) {
        switches.emplace_back(name, "");
    }

    void AppendSwitchWithValue(const std::string& name, const std::string& value) {
        switches.emplace_back(name, value);
    }

    std::vector<std::pair<std::string, std::string>> switches;
};

#endif
