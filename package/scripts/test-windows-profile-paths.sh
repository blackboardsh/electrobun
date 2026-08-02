#!/usr/bin/env bash
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_file="$package_dir/src/native/shared/windows_profile_paths_test.cpp"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/electrobun-win-paths.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT

host_cxx="${CXX:-c++}"
zig="${ZIG:-$package_dir/vendors/zig/zig}"

"$host_cxx" -std=c++20 -Wall -Wextra -pedantic \
    "$source_file" -o "$build_dir/windows_profile_paths_host"
"$build_dir/windows_profile_paths_host"

if [[ ! -x "$zig" ]]; then
    echo "Zig was not found at $zig; set ZIG to cross-compile the Windows test." >&2
    exit 1
fi

"$zig" c++ -target x86_64-windows-gnu -std=c++20 \
    -DUNICODE -D_UNICODE \
    "$source_file" -o "$build_dir/windows_profile_paths_test.exe"

echo "windows x64 profile path test cross-compiled successfully"
