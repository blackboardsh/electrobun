#include "dialog_paths.h"

#include <cassert>

int main() {
    using electrobun::serializeDialogPaths;

    assert(serializeDialogPaths({}) == "[]");
    assert(
        serializeDialogPaths({
            "/tmp/report,final.txt",
            "C:\\Users\\name\\quoted\"file.txt",
            "line\nbreak\tand\x01-control",
            "/tmp/caf\xc3\xa9.txt",
        }) ==
        "[\"/tmp/report,final.txt\",\"C:\\\\Users\\\\name\\\\quoted\\\"file.txt\","
        "\"line\\nbreak\\tand\\u0001-control\",\"/tmp/caf\xc3\xa9.txt\"]"
    );

    return 0;
}
