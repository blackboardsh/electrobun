// Git Bash's tar (from MSYS2) misreads drive-letter paths like `C:\...` as
// `HOST:PATH` and fails with "Cannot connect to C: resolve failed". Windows
// 10 1803+ ships its own bsdtar in `%SystemRoot%\System32\tar.exe` that
// handles drive-letter paths natively, so scripts invoke it by absolute path
// on Windows instead of relying on PATH resolution.
import { join } from "node:path";

export function systemTarBinary() {
  if (process.platform !== "win32") return "tar";
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return join(systemRoot, "System32", "tar.exe");
}

export default systemTarBinary;
