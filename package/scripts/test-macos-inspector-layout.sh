#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping macOS WebKit inspector layout test on $(uname -s)."
  exit 0
fi

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/electrobun-inspector-layout.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT

xcrun --sdk macosx clang++ \
  -std=c++20 \
  -fobjc-arc \
  -framework AppKit \
  -framework WebKit \
  "$package_dir/src/native/macos/inspector_layout.test.mm" \
  -o "$test_dir/inspector-layout-test"

"$test_dir/inspector-layout-test"
