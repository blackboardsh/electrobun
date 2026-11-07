#include "../bridge_auth.h"

#include <cassert>
#include <iostream>

int main(int argc, char**) {
    using namespace electrobun;
    const auto token = createWebKitBridgeToken();
    assert(token.size() == 64);
    assert(token.find_first_not_of("0123456789abcdef") == std::string::npos);
    const auto otherToken = createWebKitBridgeToken();
    assert(token != otherToken);

    const std::string payload = R"({"type":"message","id":"probe","payload":"hello: 🐇"})";
    const auto message = token + ':' + payload;
    assert(std::string(authenticatedWebKitBridgePayload(message.c_str(), token)) == payload);
    assert(authenticatedWebKitBridgePayload(message.c_str(), otherToken) == nullptr);
    assert(authenticatedWebKitBridgePayload(message.c_str(), "") == nullptr);
    assert(authenticatedWebKitBridgePayload(nullptr, token) == nullptr);
    assert(authenticatedWebKitBridgePayload(payload.c_str(), token) == nullptr);
    assert(authenticatedWebKitBridgePayload((token + payload).c_str(), token) == nullptr);
    for (size_t length = 0; length <= token.size(); ++length) {
        assert(authenticatedWebKitBridgePayload(token.substr(0, length).c_str(), token) == nullptr);
    }
    for (size_t index = 0; index < token.size(); ++index) {
        auto forged = message;
        forged[index] = forged[index] == '0' ? '1' : '0';
        assert(authenticatedWebKitBridgePayload(forged.c_str(), token) == nullptr);
    }
    // Emit the actual generated script for the JavaScript transport tests.
    if (argc > 1) std::cout << webKitBridgeBootstrap(token);
    return 0;
}
