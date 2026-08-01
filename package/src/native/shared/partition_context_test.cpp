#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

template <typename T>
using CefRefPtr = T*;

struct CefSchemeHandlerFactory {};

struct CefRequestContextSettings {
    bool persist_session_cookies = false;
    std::string cache_path;
};

class CefString {
public:
    explicit CefString(std::string* value) : value_(value) {}

    void FromString(const std::string& value) {
        *value_ = value;
    }

private:
    std::string* value_;
};

class CefRequestContext {
public:
    explicit CefRequestContext(bool global, CefRequestContextSettings settings = {})
        : global(global), settings(std::move(settings)) {}

    static CefRefPtr<CefRequestContext> CreateContext(
        const CefRequestContextSettings& settings,
        void*) {
        createdContexts().push_back(std::make_unique<CefRequestContext>(false, settings));
        return createdContexts().back().get();
    }

    static CefRefPtr<CefRequestContext> GetGlobalContext() {
        return &globalContext();
    }

    void RegisterSchemeHandlerFactory(
        const std::string& scheme,
        const std::string& domain,
        CefRefPtr<CefSchemeHandlerFactory> factory) {
        registeredSchemes.push_back({scheme, domain, factory});
    }

    struct RegisteredScheme {
        std::string scheme;
        std::string domain;
        CefRefPtr<CefSchemeHandlerFactory> factory;
    };

    static std::vector<std::unique_ptr<CefRequestContext>>& createdContexts() {
        static std::vector<std::unique_ptr<CefRequestContext>> contexts;
        return contexts;
    }

    static CefRequestContext& globalContext() {
        static CefRequestContext context(true);
        return context;
    }

    bool global;
    CefRequestContextSettings settings;
    std::vector<RegisteredScheme> registeredSchemes;
};

#include "partition_context.h"

namespace {

std::vector<std::string> builtPartitionPaths;

[[noreturn]] void fail(const std::string& message) {
    std::cerr << "partition_context_test: " << message << '\n';
    std::exit(1);
}

void expect(bool condition, const std::string& message) {
    if (!condition) fail(message);
}

void resetState() {
    CefRequestContext::createdContexts().clear();
    CefRequestContext::globalContext().registeredSchemes.clear();
    electrobun::partitionContextMap_().clear();
    builtPartitionPaths.clear();
}

} // namespace

namespace electrobun {

std::string buildAndEnsurePartitionCachePath(const std::string& partitionName) {
    builtPartitionPaths.push_back(partitionName);
    return "/profiles/" + partitionName;
}

} // namespace electrobun

int main() {
    CefSchemeHandlerFactory schemeFactory;

    resetState();
    auto* persistentDefault = electrobun::getOrCreateRequestContextForPartition(
        "persist:default", 1, &schemeFactory);
    expect(persistentDefault == CefRequestContext::GetGlobalContext(),
           "persist:default must select CEF's global request context");
    expect(CefRequestContext::createdContexts().empty(),
           "persist:default must not create a custom request context");
    expect(builtPartitionPaths.empty(),
           "persist:default must not create a named partition profile");
    expect(persistentDefault->registeredSchemes.size() == 1,
           "persist:default must register the views scheme on the global context");

    resetState();
    auto* namedPersistentFirst = electrobun::getOrCreateRequestContextForPartition(
        "persist:account-a", 2, &schemeFactory);
    auto* namedPersistentSecond = electrobun::getOrCreateRequestContextForPartition(
        "persist:account-a", 3, &schemeFactory);
    expect(namedPersistentFirst != CefRequestContext::GetGlobalContext(),
           "a named persistent partition must remain isolated from the global profile");
    expect(namedPersistentFirst == namedPersistentSecond,
           "a named persistent partition must reuse its cached request context");
    expect(CefRequestContext::createdContexts().size() == 1,
           "a named persistent partition must create exactly one request context");
    expect(builtPartitionPaths == std::vector<std::string>{"account-a"},
           "a named persistent partition must build its own profile path");
    expect(namedPersistentFirst->settings.persist_session_cookies,
           "a named persistent partition must persist session cookies");
    expect(namedPersistentFirst->settings.cache_path == "/profiles/account-a",
           "a named persistent partition must use its isolated profile path");

    resetState();
    auto* ephemeralFirst = electrobun::getOrCreateRequestContextForPartition(
        "temporary", 4, &schemeFactory);
    auto* ephemeralSecond = electrobun::getOrCreateRequestContextForPartition(
        "temporary", 5, &schemeFactory);
    expect(ephemeralFirst != ephemeralSecond,
           "a named ephemeral partition must create a fresh context per webview");
    expect(!ephemeralFirst->global && !ephemeralSecond->global,
           "a named ephemeral partition must not use the global profile");
    expect(!ephemeralFirst->settings.persist_session_cookies &&
               !ephemeralSecond->settings.persist_session_cookies,
           "a named ephemeral partition must remain in memory");
    expect(builtPartitionPaths.empty(),
           "a named ephemeral partition must not build a disk profile path");

    resetState();
    auto* unnamedFirst = electrobun::getOrCreateRequestContextForPartition(
        nullptr, 6, &schemeFactory);
    auto* unnamedSecond = electrobun::getOrCreateRequestContextForPartition(
        "", 7, &schemeFactory);
    expect(unnamedFirst != unnamedSecond,
           "an omitted partition must retain fresh ephemeral context semantics");
    expect(!unnamedFirst->global && !unnamedSecond->global,
           "an omitted partition must not be conflated with persist:default");

    std::cout << "partition_context_test: passed\n";
    return 0;
}
