import { machine as hostMachine } from "node:os";
import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

// Windows can report x64 through process.arch, os.machine(), and both processor
// environment variables on an ARM64 host. Query the native machine explicitly;
// GetNativeSystemInfo can also report the emulated architecture in that case.
const nativeArchitectureProgram = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ElectrobunNativeHost {
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);
}
'@
[UInt16]$processMachine = 0
[UInt16]$nativeMachine = 0
if (-not [ElectrobunNativeHost]::IsWow64Process2([IntPtr]::new(-1), [ref]$processMachine, [ref]$nativeMachine)) {
  throw 'IsWow64Process2 failed'
}
Write-Output ('{0:x4}' -f $nativeMachine)
`;

export function nativeWindowsArchitecture({ env = process.env, run = spawnSync } = {}) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) {
    throw new Error("Cannot determine native Windows Zig compiler host: SystemRoot is not an absolute path");
  }
  const executable = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = run(executable, [
    "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(nativeArchitectureProgram, "utf16le").toString("base64"),
  ], { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 4096 });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code || result.signal || `exit ${result.status}`;
    throw new Error(`Cannot determine native Windows Zig compiler host: IsWow64Process2 probe failed (${reason})`);
  }
  switch (result.stdout?.trim().toLowerCase()) {
    case "aa64": return "arm64";
    case "8664": return "x64";
    default: throw new Error("Cannot determine native Windows Zig compiler host: unexpected IsWow64Process2 native machine");
  }
}

// Compiler host selection is independent of the app's --arch target. A JS
// runtime under Windows emulation must still use the native 0.17 compiler.
export function zigCompilerHostArchitecture({
  platform = process.platform,
  processArch = process.arch,
  machine = hostMachine(),
  env = process.env,
  queryWindowsArchitecture = nativeWindowsArchitecture,
} = {}) {
  if (platform === "win32" && [processArch, machine,
    env.PROCESSOR_ARCHITEW6432, env.PROCESSOR_ARCHITECTURE,
  ].some(value => /^(?:arm64|aarch64)$/i.test(value || ""))) return "arm64";
  if (platform === "win32" && processArch === "x64") {
    const nativeArch = queryWindowsArchitecture({ env });
    if (nativeArch === "arm64" || nativeArch === "x64") return nativeArch;
    throw new Error(`Unsupported native Windows Zig compiler host architecture: ${nativeArch}`);
  }
  if (processArch === "arm64" || processArch === "x64") return processArch;
  throw new Error(`Unsupported Zig compiler host architecture: ${processArch}`);
}
