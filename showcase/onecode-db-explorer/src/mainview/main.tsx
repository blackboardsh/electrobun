import { render } from "solid-js/web";
import App from "@/App";

// Some embedded WebKit builds don't expose `queueMicrotask` reliably. Solid and our UI use it
// in a few places, so polyfill to keep bootstrapping deterministic.
if (typeof globalThis.queueMicrotask !== "function") {
  (globalThis as unknown as { queueMicrotask: (cb: () => void) => void }).queueMicrotask = (cb) => {
    void Promise.resolve().then(cb);
  };
}

render(() => <App />, document.getElementById("root")!);
