import { machine as hostMachine } from "node:os";

// Compiler host selection is independent of the app's --arch target. A JS
// runtime under Windows emulation must still use the native 0.17 compiler.
export function zigCompilerHostArchitecture({
  platform = process.platform,
  processArch = process.arch,
  machine = hostMachine(),
  env = process.env,
} = {}) {
  if (platform === "win32" && [processArch, machine,
    env.PROCESSOR_ARCHITEW6432, env.PROCESSOR_ARCHITECTURE,
  ].some(value => /^(?:arm64|aarch64)$/i.test(value || ""))) return "arm64";
  if (processArch === "arm64" || processArch === "x64") return processArch;
  throw new Error(`Unsupported Zig compiler host architecture: ${processArch}`);
}
