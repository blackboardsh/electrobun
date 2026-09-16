#ifndef ELECTROBUN_CONSOLE_FORWARDING_H
#define ELECTROBUN_CONSOLE_FORWARDING_H

#include <cstdint>
#include <cstdio>
#include <string>

namespace electrobun {

inline bool shouldForwardWebviewConsole(const std::string& channel) {
    return channel == "dev";
}

inline void printWebviewConsoleMessage(uint32_t webviewId, const char* message) {
    if (!message) return;
    std::fprintf(stdout, "[webview:%u] %s\n", webviewId, message);
    std::fflush(stdout);
}

inline const char* webviewConsoleForwardingScript() {
    return R"ELECTROBUN_JS(
(() => {
  const marker = "__electrobunConsoleForwardingInstalled";
  if (globalThis[marker]) return;
  Object.defineProperty(globalThis, marker, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  let bridge = null;
  const getBridge = () => {
    if (bridge) return bridge;
    try {
      bridge = globalThis.webkit?.messageHandlers?.electrobunConsole ??
        globalThis.chrome?.webview?.hostObjects?.sync?.electrobunConsole ??
        null;
    } catch {}
    return bridge;
  };

  const formatValue = (value) => {
    if (value === null) return "null";
    switch (typeof value) {
      case "string": return value;
      case "undefined": return "undefined";
      case "bigint": return `${value}n`;
      case "symbol": return String(value);
      case "function": return `[Function${value.name ? `: ${value.name}` : ""}]`;
      case "number":
      case "boolean": return String(value);
    }

    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    try {
      const seen = new WeakSet();
      const json = JSON.stringify(value, (_key, nested) => {
        if (typeof nested === "bigint") return `${nested}n`;
        if (nested && typeof nested === "object") {
          if (seen.has(nested)) return "[Circular]";
          seen.add(nested);
        }
        return nested;
      });
      if (json !== undefined) return json;
    } catch {}

    try {
      return String(value);
    } catch {
      return "[Unprintable]";
    }
  };

  for (const level of ["debug", "log", "info", "warn", "error"]) {
    const original = console[level];
    if (typeof original !== "function") continue;
    const forwarded = function(...args) {
      try {
        getBridge()?.postMessage(`[console.${level}] ${args.map(formatValue).join(" ")}`);
      } catch {}
      return Reflect.apply(original, console, args);
    };
    try {
      Object.defineProperty(console, level, {
        value: forwarded,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    } catch {}
  }
})();
)ELECTROBUN_JS";
}

} // namespace electrobun

#endif // ELECTROBUN_CONSOLE_FORWARDING_H
