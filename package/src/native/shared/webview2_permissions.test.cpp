#include "webview2_permissions.h"

#include <cassert>
#include <iostream>

using electrobun::AutoGrantPermission;

int main() {
    const auto permissions = electrobun::parseAutoGrantPermissions(R"({
        "runtime": {"nested": [true, {"value": "ignored"}]},
        "autoGrantPermissions": [
            "camera", "microphone", "geolocation", "notifications",
            "camera", "clipboard-read"
        ]
    })");
    assert(permissions.size() == 4);
    assert(electrobun::hasAutoGrantPermission(
        permissions, AutoGrantPermission::camera));
    assert(electrobun::hasAutoGrantPermission(
        permissions, AutoGrantPermission::microphone));
    assert(electrobun::hasAutoGrantPermission(
        permissions, AutoGrantPermission::geolocation));
    assert(electrobun::hasAutoGrantPermission(
        permissions, AutoGrantPermission::notifications));

    // Only the top-level build.json field is authoritative.
    assert(electrobun::parseAutoGrantPermissions(
        R"({"chromiumFlags":{"autoGrantPermissions":["camera"]}})")
        .empty());

    // Canonical names are exact and unknown future kinds fail closed.
    assert(electrobun::parseAutoGrantPermissions(
        R"({"autoGrantPermissions":["Camera","clipboard-read"]})")
        .empty());

    // Invalid types and malformed arrays fail closed rather than granting.
    assert(electrobun::parseAutoGrantPermissions(
        R"({"autoGrantPermissions":"camera"})").empty());
    assert(electrobun::parseAutoGrantPermissions(
        R"({"autoGrantPermissions":["camera",true]})").empty());
    assert(electrobun::parseAutoGrantPermissions(
        R"({"autoGrantPermissions":["camera"]} trailing)").empty());
    assert(electrobun::parseAutoGrantPermissions(
        R"({"autoGrantPermissions":["camera"],"autoGrantPermissions":["microphone"]})")
        .empty());

    const auto escaped = electrobun::parseAutoGrantPermissions(
        R"({"autoGrantPermissi\u006Fns":["microphone"]})");
    assert(escaped.size() == 1);
    assert(electrobun::hasAutoGrantPermission(
        escaped, AutoGrantPermission::microphone));

    std::cout << "WebView2 auto-grant permission parser tests passed\n";
    return 0;
}
