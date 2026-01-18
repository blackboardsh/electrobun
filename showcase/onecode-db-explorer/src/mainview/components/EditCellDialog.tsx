import Dialog from "@corvu/dialog";
import { Show, createMemo } from "solid-js";
import { bytesToBase64 } from "../lib/app-helpers";

export type CellEditMode = "value" | "null";
export type CellEditorKind = "json" | "longText" | "blob" | "datetime" | "date" | "time";

type EditCellDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  table: string;
  column: string;
  typeText: string;
  kind: CellEditorKind;
  mode: CellEditMode;
  onModeChange: (mode: CellEditMode) => void;
  value: string;
  onValueChange: (next: string) => void;
  error: string | null;
  onSave: () => void | Promise<void>;
  isSaving: boolean;
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function base64ByteLength(base64: string) {
  const clean = base64.trim().replace(/\s+/g, "");
  if (!clean) return { ok: true as const, bytes: 0 };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return { ok: false as const, error: "Not valid base64." };
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return { ok: true as const, bytes: Math.max(0, Math.floor((clean.length * 3) / 4) - padding) };
}

function base64ToBytes(base64: string) {
  const clean = base64.trim().replace(/\s+/g, "");
  if (!clean) return new Uint8Array(0);
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function normalizeDateInputValue(kind: CellEditorKind, raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (kind === "date") {
    const match = trimmed.match(/\d{4}-\d{2}-\d{2}/);
    return match?.[0] ?? "";
  }

  if (kind === "time") {
    const match = trimmed.match(/\d{2}:\d{2}(?::\d{2})?/);
    return match?.[0] ?? "";
  }

  if (kind === "datetime") {
    const match = trimmed.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?/);
    if (!match) return "";
    return match[0].replace(" ", "T");
  }

  return trimmed;
}

function nowForKind(kind: CellEditorKind) {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  const ss = pad(d.getSeconds());

  if (kind === "date") return `${yyyy}-${mm}-${dd}`;
  if (kind === "time") return `${hh}:${min}:${ss}`;
  if (kind === "datetime") return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`;
  return "";
}

function placeholderForKind(kind: CellEditorKind) {
  switch (kind) {
    case "json":
      return "{\n  \n}";
    case "blob":
      return "Base64…";
    case "date":
      return "YYYY-MM-DD";
    case "time":
      return "HH:MM:SS";
    case "datetime":
      return "YYYY-MM-DD HH:MM:SS";
    case "longText":
      return "Text…";
  }
}

export default function EditCellDialog(props: EditCellDialogProps) {
  let fileInputEl: HTMLInputElement | undefined;

  const isDateLike = createMemo(() => props.kind === "date" || props.kind === "time" || props.kind === "datetime");
  const inputType = createMemo(() => (props.kind === "date" ? "date" : props.kind === "time" ? "time" : "datetime-local"));

  const normalizedDateValue = createMemo(() => normalizeDateInputValue(props.kind, props.value));

  const jsonPreview = createMemo(() => {
    if (props.kind !== "json") return null;
    const trimmed = props.value.trim();
    if (!trimmed) return { ok: true as const, preview: "" };
    try {
      const parsed = JSON.parse(trimmed);
      return { ok: true as const, preview: JSON.stringify(parsed, null, 2) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : "Invalid JSON." };
    }
  });

  const blobStats = createMemo(() => {
    if (props.kind !== "blob") return null;
    const info = base64ByteLength(props.value);
    if (!info.ok) return { ok: false as const, error: info.error };
    return { ok: true as const, bytes: info.bytes };
  });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="dialog-overlay" />
        <Dialog.Content class="dialog-content">
          <div class="cell-edit-dialog">
            <div class="cell-edit-header">
              <div>
                <div class="cell-edit-title">Edit Cell</div>
                <div class="cell-edit-subtitle">
                  {props.table}.{props.column}{" "}
                  <Show when={props.typeText}>
                    <span class="pill pill-muted">{props.typeText}</span>
                  </Show>
                </div>
              </div>
              <Dialog.Close class="btn btn-ghost" aria-label="close">
                Close <span class="kbd">Esc</span>
              </Dialog.Close>
            </div>

            <div class="cell-edit-body">
              <div class="cell-edit-controls">
                <div class="insert-mode" role="tablist" aria-label="Value mode">
                  <button
                    class="mode-btn"
                    data-active={props.mode === "value" ? "true" : "false"}
                    onClick={() => props.onModeChange("value")}
                    type="button"
                  >
                    Value
                  </button>
                  <button
                    class="mode-btn"
                    data-active={props.mode === "null" ? "true" : "false"}
                    onClick={() => props.onModeChange("null")}
                    type="button"
                  >
                    NULL
                  </button>
                </div>
                <div class="cell-edit-hint">
                  <span class="kbd">⌘/Ctrl</span>+<span class="kbd">Enter</span> to save
                </div>
              </div>

              <Show when={props.error}>
                <div class="pill pill-error">{props.error}</div>
              </Show>

              <Show when={props.kind === "json"}>
                <div class="cell-edit-kind-toolbar">
                  <div class="cell-edit-kind-actions">
                    <button
                      class="btn btn-ghost btn-xs"
                      type="button"
                      disabled={props.mode === "null" || props.isSaving || !props.value.trim()}
                      onClick={() => {
                        const trimmed = props.value.trim();
                        if (!trimmed) return;
                        try {
                          const parsed = JSON.parse(trimmed);
                          props.onValueChange(JSON.stringify(parsed, null, 2));
                        } catch {
                          // ignore
                        }
                      }}
                    >
                      Format
                    </button>
                    <button
                      class="btn btn-ghost btn-xs"
                      type="button"
                      disabled={props.mode === "null" || props.isSaving || !props.value.trim()}
                      onClick={() => {
                        const trimmed = props.value.trim();
                        if (!trimmed) return;
                        try {
                          const parsed = JSON.parse(trimmed);
                          props.onValueChange(JSON.stringify(parsed));
                        } catch {
                          // ignore
                        }
                      }}
                    >
                      Minify
                    </button>
                    <button
                      class="btn btn-ghost btn-xs"
                      type="button"
                      disabled={!props.value}
                      onClick={() => void navigator.clipboard?.writeText(props.value)}
                    >
                      Copy
                    </button>
                  </div>
                  <Show when={jsonPreview() && !jsonPreview()!.ok}>
                    <div class="cell-edit-kind-status cell-edit-kind-error">Invalid JSON</div>
                  </Show>
                  <Show when={jsonPreview() && jsonPreview()!.ok && props.value.trim()}>
                    <div class="cell-edit-kind-status">Valid JSON</div>
                  </Show>
                </div>
              </Show>

              <Show when={isDateLike()}>
                <div class="cell-edit-kind-toolbar">
                  <div class="cell-edit-kind-actions">
                    <button
                      class="btn btn-ghost btn-xs"
                      type="button"
                      disabled={props.mode === "null" || props.isSaving}
                      onClick={() => props.onValueChange(nowForKind(props.kind))}
                    >
                      Now
                    </button>
                    <button
                      class="btn btn-ghost btn-xs"
                      type="button"
                      disabled={!props.value}
                      onClick={() => void navigator.clipboard?.writeText(props.value)}
                    >
                      Copy
                    </button>
                  </div>
                </div>

                <input
                  class="input cell-edit-input"
                  type={inputType()}
                  value={normalizedDateValue()}
                  disabled={props.mode === "null" || props.isSaving}
                  onInput={(e) => props.onValueChange(e.currentTarget.value)}
                  placeholder={placeholderForKind(props.kind)}
                  onKeyDown={(e) => {
                    if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
                    e.preventDefault();
                    void props.onSave();
                  }}
                />
              </Show>

              <Show when={props.kind === "blob"}>
                <div class="cell-edit-kind-toolbar">
                  <div class="cell-edit-kind-actions">
                    <button
                      class="btn btn-ghost btn-xs"
                      type="button"
                      disabled={props.mode === "null" || props.isSaving}
                      onClick={() => fileInputEl?.click()}
                    >
                      Upload…
                    </button>
                    <button
                      class="btn btn-ghost btn-xs"
                      type="button"
                      disabled={!props.value.trim()}
                      onClick={() => {
                        try {
                          const bytes = base64ToBytes(props.value);
                          const blob = new Blob([bytes]);
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `${props.column}.bin`;
                          a.click();
                          URL.revokeObjectURL(url);
                        } catch {
                          // ignore
                        }
                      }}
                    >
                      Download
                    </button>
                    <button
                      class="btn btn-ghost btn-xs"
                      type="button"
                      disabled={!props.value}
                      onClick={() => void navigator.clipboard?.writeText(props.value)}
                    >
                      Copy
                    </button>
                  </div>
                  <Show when={blobStats()}>
                    {(stats) => (
                      <div class="cell-edit-kind-status">
                        {(() => {
                          const s = stats();
                          return s.ok ? formatBytes(s.bytes) : s.error;
                        })()}
                      </div>
                    )}
                  </Show>
                </div>

                <input
                  ref={(el) => {
                    fileInputEl = el;
                  }}
                  type="file"
                  class="cell-edit-file-input"
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    if (!file) return;
                    void (async () => {
                      const buffer = await file.arrayBuffer();
                      props.onValueChange(bytesToBase64(new Uint8Array(buffer)));
                      e.currentTarget.value = "";
                    })();
                  }}
                />
              </Show>

              <Show
                when={!isDateLike()}
                fallback={null}
              >
                <Show when={props.kind !== "blob"}>
                  <textarea
                    class="textarea cell-edit-textarea"
                    value={props.value}
                    onInput={(e) => props.onValueChange(e.currentTarget.value)}
                    spellcheck={false}
                    disabled={props.mode === "null" || props.isSaving}
                    placeholder={placeholderForKind(props.kind)}
                    onKeyDown={(e) => {
                      if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
                      e.preventDefault();
                      void props.onSave();
                    }}
                  />
                </Show>

                <Show when={props.kind === "blob"}>
                  <textarea
                    class="textarea cell-edit-textarea"
                    value={props.value}
                    onInput={(e) => props.onValueChange(e.currentTarget.value)}
                    spellcheck={false}
                    disabled={props.mode === "null" || props.isSaving}
                    placeholder={placeholderForKind(props.kind)}
                    onKeyDown={(e) => {
                      if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
                      e.preventDefault();
                      void props.onSave();
                    }}
                  />
                </Show>
              </Show>

              <div class="cell-edit-actions">
                <button class="btn btn-secondary" onClick={() => props.onOpenChange(false)} disabled={props.isSaving}>
                  Cancel
                </button>
                <button class="btn btn-primary" onClick={() => void props.onSave()} disabled={props.isSaving}>
                  {props.isSaving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
