import { For, Show } from "solid-js";
import type { ColumnInfo } from "../../bun/index";

type SchemaManagerViewProps = {
  activeTable: string | null;
  tableSchemas: Record<string, ColumnInfo[]>;
  ensureSchema: (tableName: string) => void | Promise<void>;
};

export default function SchemaManagerView(props: SchemaManagerViewProps) {
  return (
    <div class="view">
      <div class="view-card schema-card">
        <div class="view-title">Schema Manager</div>
        <Show when={props.activeTable} fallback={<div class="view-text">Select a table to inspect schema.</div>}>
          {(tableName) => (
            <>
              <div class="schema-meta">
                <span class="pill">Table: {tableName()}</span>
                <Show when={!props.tableSchemas[tableName()]}>
                  <button class="btn btn-secondary" onClick={() => void props.ensureSchema(tableName())}>
                    Load schema
                  </button>
                </Show>
              </div>

              <Show when={props.tableSchemas[tableName()]} fallback={<div class="pill">Loading schema…</div>}>
                {(cols) => (
                  <div class="schema-grid">
                    <div class="schema-row schema-head">
                      <div>#</div>
                      <div>Name</div>
                      <div>Type</div>
                      <div>PK</div>
                      <div>Nullable</div>
                      <div>Default</div>
                    </div>
                    <For each={[...cols()].sort((a, b) => a.ordinal - b.ordinal)}>
                      {(col) => (
                        <div class="schema-row">
                          <div class="schema-ordinal">{col.ordinal + 1}</div>
                          <div class="schema-name">{col.name}</div>
                          <div class="schema-type">{col.type}</div>
                          <div>{col.primaryKey ? "✓" : ""}</div>
                          <div>{col.nullable ? "YES" : "NO"}</div>
                          <div class="schema-default">{col.defaultValue ?? ""}</div>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </Show>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
