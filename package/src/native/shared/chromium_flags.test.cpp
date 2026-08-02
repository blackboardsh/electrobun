#include "chromium_flags.h"

#include <cassert>
#include <iostream>
#include <set>

using electrobun::RemoteDebuggingSource;

static electrobun::RemoteDebuggingDecision resolve(
    const std::string& json,
    const char* environmentOverride = nullptr) {
    const auto flags = electrobun::parseChromiumFlags(json);
    return electrobun::resolveRemoteDebugging(json, flags, environmentOverride);
}

int main() {
    const auto development = resolve(R"({"buildEnvironment":"dev"})");
    assert(development.enabled());
    assert(development.requestedPort == 9222);
    assert(development.scanForAvailablePort);
    assert(development.source == RemoteDebuggingSource::development_default);

    for (const char* environment : {"canary", "production"}) {
        const auto packaged = resolve(
            std::string("{\"buildEnvironment\":\"") + environment + "\"}");
        assert(!packaged.enabled());
        assert(packaged.source == RemoteDebuggingSource::disabled_by_default);
    }
    const auto missingMetadata = resolve("{}");
    assert(!missingMetadata.enabled());
    assert(missingMetadata.source == RemoteDebuggingSource::disabled_by_default);

    const auto configured = resolve(
        R"({"buildEnvironment":"production","chromiumFlags":{"remote-debugging-port":"9333"}})");
    assert(configured.enabled());
    assert(configured.requestedPort == 9333);
    assert(!configured.scanForAvailablePort);
    assert(configured.source == RemoteDebuggingSource::configuration);

    const auto disabledInDevelopment = resolve(
        R"({"buildEnvironment":"dev","chromiumFlags":{"remote-debugging-port":false}})");
    assert(!disabledInDevelopment.enabled());
    assert(disabledInDevelopment.source == RemoteDebuggingSource::explicit_disable);

    for (const char* invalidValue : {"true", "\"1023\"", "\"65536\"", "\"not-a-port\""}) {
        const auto invalid = resolve(
            std::string("{\"buildEnvironment\":\"dev\",\"chromiumFlags\":{") +
            "\"remote-debugging-port\":" + invalidValue + "}}");
        assert(!invalid.enabled());
        assert(invalid.source == RemoteDebuggingSource::invalid_configuration);
    }

    const auto environmentOverride = resolve(
        R"({"buildEnvironment":"production","chromiumFlags":{"remote-debugging-port":"9333"}})",
        "9444");
    assert(environmentOverride.requestedPort == 9444);
    assert(environmentOverride.source == RemoteDebuggingSource::environment);

    const auto environmentDisable = resolve(R"({"buildEnvironment":"dev"})", "off");
    assert(!environmentDisable.enabled());
    assert(environmentDisable.source == RemoteDebuggingSource::explicit_disable);

    const auto invalidEnvironment = resolve(R"({"buildEnvironment":"dev"})", "70000");
    assert(!invalidEnvironment.enabled());
    assert(invalidEnvironment.source == RemoteDebuggingSource::invalid_environment);

    const std::set<int> unavailable = {9222, 9223};
    const int selected = electrobun::selectRemoteDebuggingPort(
        development,
        [&](int port) { return unavailable.count(port) == 0; });
    assert(selected == 9224);

    const int noAutomaticPort = electrobun::selectRemoteDebuggingPort(
        development,
        [](int) { return false; });
    assert(noAutomaticPort == 0);

    const int exactConfiguredPort = electrobun::selectRemoteDebuggingPort(
        configured,
        [](int) { return false; });
    assert(exactConfiguredPort == 9333);

    auto flags = electrobun::parseChromiumFlags(
        R"({"chromiumFlags":{"remote-debugging-port":"9333","user-agent":"Electrobun/Test"}})");
    CefCommandLine commandLine;
    electrobun::applyChromiumFlags(flags, CefRefPtr<CefCommandLine>(&commandLine));
    assert(commandLine.switches.size() == 1);
    assert(commandLine.switches[0].first == "user-agent");
    assert(commandLine.switches[0].second == "Electrobun/Test");

    std::cout << "CEF remote debugging policy tests passed\n";
    return 0;
}
