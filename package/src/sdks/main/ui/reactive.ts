// Warren reactivity core — canonical source lives in src/shared/warren so
// the browser (DOM) renderer shares one implementation. This shim keeps
// main/ui-relative imports stable.
export * from "../../../shared/warren/reactive";
