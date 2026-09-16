#include "views_url.h"

#include <cassert>
#include <string>

using electrobun::ViewsUrlPathError;
using electrobun::normalizeViewsRelativePath;

static void expectPath(const std::string& url, const std::string& expected) {
    std::string actual;
    ViewsUrlPathError error = ViewsUrlPathError::invalid_utf8;
    assert(normalizeViewsRelativePath(url, actual, &error));
    assert(error == ViewsUrlPathError::none);
    assert(actual == expected);
}

static void expectError(const std::string& url, ViewsUrlPathError expected) {
    std::string actual = "stale";
    ViewsUrlPathError error = ViewsUrlPathError::none;
    assert(!normalizeViewsRelativePath(url, actual, &error));
    assert(actual.empty());
    assert(error == expected);
}

int main() {
    expectPath("views://", "index.html");
    expectPath("views:////nested//index.html/", "nested/index.html");
    expectPath("views://nested\\asset.js", "nested/asset.js");
    expectPath("views://folder/./asset.js", "folder/asset.js");
    expectPath(
        "views://folder/hello%20world%23%3F.txt?cache=1#section",
        "folder/hello world#?.txt"
    );
    expectPath("views://unicode/%E2%9C%93.txt", "unicode/\xe2\x9c\x93.txt");
    expectPath("appdata://fixture.txt", "fixture.txt");
    expectPath("appdata://folder/asset.png?cache=1", "folder/asset.png");

    expectError("views://bad%", ViewsUrlPathError::malformed_percent_encoding);
    expectError("views://bad%2", ViewsUrlPathError::malformed_percent_encoding);
    expectError("views://bad%GG", ViewsUrlPathError::malformed_percent_encoding);
    expectError("views://nested%2fsecret", ViewsUrlPathError::encoded_separator);
    expectError("views://nested%5Csecret", ViewsUrlPathError::encoded_separator);
    expectError("views://asset%00.js", ViewsUrlPathError::nul_byte);
    expectError("views://asset%0A.js", ViewsUrlPathError::control_character);
    expectError("views://../secret", ViewsUrlPathError::traversal);
    expectError("views://safe/%2e%2e/secret", ViewsUrlPathError::traversal);
    expectError("views://C:/secret", ViewsUrlPathError::drive_prefix);
    expectError("views://safe/d:/secret", ViewsUrlPathError::drive_prefix);
    expectError("views://bad/%C0%AF", ViewsUrlPathError::invalid_utf8);
    expectError("views://bad/%FF", ViewsUrlPathError::invalid_utf8);
    expectError("appdata://../secret", ViewsUrlPathError::traversal);
    expectError("appdata://safe/%2e%2e/secret", ViewsUrlPathError::traversal);
    return 0;
}
