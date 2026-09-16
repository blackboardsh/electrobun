#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZIG_BIN="${ZIG:-${PACKAGE_DIR}/vendors/zig/zig}"
TEST_SOURCE="${PACKAGE_DIR}/src/native/linux/tests/native_file_dialog_test.cpp"
FAKE_GTK="${PACKAGE_DIR}/src/native/linux/tests/fake-gtk"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/electrobun-native-dialog.XXXXXX")"
trap 'rm -rf "${BUILD_DIR}"' EXIT

if [[ ! -x "${ZIG_BIN}" ]]; then
	echo "Zig was not found at ${ZIG_BIN}. Run an Electrobun build or set ZIG." >&2
	exit 1
fi

"${ZIG_BIN}" c++ -std=c++20 -I"${FAKE_GTK}" "${TEST_SOURCE}" -o "${BUILD_DIR}/native-file-dialog-test"
"${BUILD_DIR}/native-file-dialog-test"

for target in x86_64-linux-gnu aarch64-linux-gnu; do
	"${ZIG_BIN}" c++ -std=c++20 -target "${target}" -c -I"${FAKE_GTK}" "${TEST_SOURCE}" -o "${BUILD_DIR}/${target}.o"
done

echo "Linux native file dialog tests passed"
