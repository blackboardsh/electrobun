import { makePersisted } from "@solid-primitives/storage";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Setter } from "solid-js";
import type { ColumnInfo } from "../../bun/index";
import { classifyColumnType } from "../lib/app-helpers";

type TablesSidebarProps = {
  sidebarWidth: number;
  setSidebarWidth: Setter<number>;
  adapter: string;
  tables: string[];
  tableSchemas: Record<string, ColumnInfo[]>;
  ensureSchema: (tableName: string) => void | Promise<void>;
  activeTable: string | null;
  openTable: (tableName: string) => void | Promise<void>;
  tableFilter: string;
  setTableFilter: Setter<string>;
  onRefresh: () => void | Promise<void>;
  onOpenGraph?: () => void;
  onOpenNewTable?: () => void;
  isConnecting: boolean;
};

type TableNode = {
  fullName: string;
  schema: string;
  name: string;
};

function splitQualifiedTableName(adapter: string, tableName: string): { schema: string; name: string } {
  const idx = tableName.indexOf(".");
  if (idx === -1) {
    const schema = adapter === "sqlite" ? "main" : "public";
    return { schema, name: tableName };
  }

  return { schema: tableName.slice(0, idx), name: tableName.slice(idx + 1) };
}

function ColumnTypePill(props: { typeText: string }) {
  const { isJson, isBool, isDateTime, isDate, isTime, isNumber, isBlob, isText } = classifyColumnType(props.typeText);
  const kind = isJson
    ? "json"
    : isBool
      ? "bool"
      : isBlob
        ? "blob"
        : isDateTime || isDate || isTime
          ? "datetime"
          : isNumber
            ? "number"
            : isText
              ? "text"
              : "other";

  return (
    <span class="type-pill" data-kind={kind} title={props.typeText}>
      {props.typeText}
    </span>
  );
}

function IconDatabase() {
  return (
    <svg class="schema-tree-svg" viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  );
}

function IconTable() {
  return (
    <svg class="schema-tree-svg" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 10h16" />
      <path d="M10 5v14" />
    </svg>
  );
}

function IconKey() {
  return (
    <svg class="schema-tree-svg schema-tree-svg-key" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="7.5" cy="14.5" r="2.5" />
      <path d="M10 14.5H22" />
      <path d="M16 14.5v3" />
      <path d="M19 14.5v2" />
    </svg>
  );
}

function IconGraph() {
  return (
    <svg class="schema-tree-svg" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="12" r="2.2" />
      <circle cx="18" cy="6" r="2.2" />
      <circle cx="18" cy="18" r="2.2" />
      <path d="M8 11l8-4" />
      <path d="M8 13l8 4" />
    </svg>
  );
}

export default function TablesSidebar(props: TablesSidebarProps) {
  const resizeState = {
    dragging: false,
    startX: 0,
    startWidth: 0,
  };

  let cleanupMouseResize: (() => void) | null = null;
  onCleanup(() => cleanupMouseResize?.());

  const [expandedSchemas, setExpandedSchemas] = makePersisted(createSignal<string[]>([]), {
    name: "onecodeDbExplorer.schemaSidebar.expandedSchemas",
    storage: sessionStorage,
  });

  const [expandedTables, setExpandedTables] = makePersisted(createSignal<string[]>([]), {
    name: "onecodeDbExplorer.schemaSidebar.expandedTables",
    storage: sessionStorage,
  });

  const [loadingSchemas, setLoadingSchemas] = createSignal<Record<string, boolean>>({});

  const expandedSchemaSet = createMemo(() => new Set(expandedSchemas()));
  const expandedTableSet = createMemo(() => new Set(expandedTables()));

  const filterText = createMemo(() => props.tableFilter.trim().toLowerCase());

  const schemaGroups = createMemo(() => {
    const adapter = props.adapter;
    const q = filterText();
    const out = new Map<string, TableNode[]>();

    for (const tableName of props.tables) {
      const { schema, name } = splitQualifiedTableName(adapter, tableName);
      const cols = props.tableSchemas[tableName];

      const matches =
        !q ||
        tableName.toLowerCase().includes(q) ||
        name.toLowerCase().includes(q) ||
        schema.toLowerCase().includes(q) ||
        (cols &&
          cols.some((c) => c.name.toLowerCase().includes(q) || c.type.toLowerCase().includes(q)));

      if (!matches) continue;

      const list = out.get(schema);
      const node: TableNode = { fullName: tableName, schema, name };
      if (list) list.push(node);
      else out.set(schema, [node]);
    }

    const sorted = [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return sorted.map(([schema, tables]) => ({
      schema,
      tables: tables.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  });

  const ensureSchemaLoaded = async (tableName: string) => {
    if (props.tableSchemas[tableName]) return;
    if (loadingSchemas()[tableName]) return;

    setLoadingSchemas((prev) => ({ ...prev, [tableName]: true }));
    try {
      await props.ensureSchema(tableName);
    } finally {
      setLoadingSchemas((prev) => ({ ...prev, [tableName]: false }));
    }
  };

  const toggleSchema = (schema: string) => {
    setExpandedSchemas((prev) => (prev.includes(schema) ? prev.filter((s) => s !== schema) : [...prev, schema]));
  };

  const toggleTable = (tableName: string) => {
    setExpandedTables((prev) =>
      prev.includes(tableName) ? prev.filter((t) => t !== tableName) : [...prev, tableName]
    );

    void ensureSchemaLoaded(tableName);
  };

  let didAutoExpand = false;
  createEffect(() => {
    const groups = schemaGroups();
    if (groups.length === 0) return;

    if (!didAutoExpand && expandedSchemas().length === 0) {
      didAutoExpand = true;
      setExpandedSchemas([groups[0].schema]);
    }
  });

  createEffect(() => {
    const active = props.activeTable;
    if (!active) return;

    const { schema } = splitQualifiedTableName(props.adapter, active);
    if (!expandedSchemaSet().has(schema)) {
      setExpandedSchemas((prev) => (prev.includes(schema) ? prev : [...prev, schema]));
    }

    if (!expandedTableSet().has(active)) {
      setExpandedTables((prev) => (prev.includes(active) ? prev : [...prev, active]));
    }

    void ensureSchemaLoaded(active);
  });

  return (
    <div class="sidebar" style={{ width: `${props.sidebarWidth}px` }}>
      <div class="sidebar-header">
        <div class="sidebar-title-row schema-title-row">
          <div class="sidebar-title">Schema</div>
          <div class="schema-actions">
            <Show when={props.onOpenNewTable}>
              <button class="btn btn-ghost btn-icon" title="New table" onClick={() => props.onOpenNewTable?.()}>
                <span aria-hidden="true">+</span>
              </button>
            </Show>
            <Show when={props.onOpenGraph}>
              <button class="btn btn-ghost btn-icon" title="Schema graph" onClick={() => props.onOpenGraph?.()}>
                <IconGraph />
              </button>
            </Show>
            <button class="btn btn-ghost btn-icon" title="Refresh" onClick={() => void props.onRefresh()} disabled={props.isConnecting}>
              <span aria-hidden="true">↻</span>
            </button>
          </div>
        </div>

        <input
          class="input input-compact"
          value={props.tableFilter}
          onInput={(e) => props.setTableFilter(e.currentTarget.value)}
          placeholder="Search tables, routines…"
          spellcheck={false}
        />
      </div>

      <div class="sidebar-list schema-tree">
        <Show when={props.tables.length > 0} fallback={<div class="pill">No tables</div>}>
          <For each={schemaGroups()}>
            {(group) => {
              const openSchema = () => expandedSchemaSet().has(group.schema);
              return (
                <div class="schema-tree-group">
                  <div
                    class="schema-tree-row schema-tree-schema-row"
                    data-level="0"
                    data-open={openSchema() ? "true" : "false"}
                    tabIndex={0}
                    role="button"
                    onClick={() => toggleSchema(group.schema)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleSchema(group.schema);
                      }
                    }}
                  >
                    <span class="schema-tree-disclosure">{openSchema() ? "▾" : "▸"}</span>
                    <span class="schema-tree-icon">
                      <IconDatabase />
                    </span>
                    <span class="schema-tree-label">{group.schema}</span>
                    <span class="schema-tree-count">{group.tables.length}</span>
                  </div>

                  <Show when={openSchema()}>
                    <For each={group.tables}>
                      {(table) => {
                        const open = () => expandedTableSet().has(table.fullName);
                        const isActive = () => props.activeTable === table.fullName;
                        const cols = () =>
                          (props.tableSchemas[table.fullName] ?? []).slice().sort((a, b) => a.ordinal - b.ordinal);
                        const isLoading = () => Boolean(loadingSchemas()[table.fullName]);

                        return (
                          <div class="schema-tree-table-block">
                            <div
                              class="schema-tree-row schema-tree-table-row"
                              data-level="1"
                              data-active={isActive() ? "true" : "false"}
                              data-open={open() ? "true" : "false"}
                              tabIndex={0}
                              role="button"
                              title={table.fullName}
                              onClick={() => void props.openTable(table.fullName)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void props.openTable(table.fullName);
                                }
                                if (e.key === " " && (e.metaKey || e.ctrlKey)) {
                                  e.preventDefault();
                                  toggleTable(table.fullName);
                                }
                              }}
                            >
                              <button
                                type="button"
                                class="schema-tree-toggle"
                                aria-label={open() ? "Collapse table" : "Expand table"}
                                data-open={open() ? "true" : "false"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleTable(table.fullName);
                                }}
                              >
                                {open() ? "▾" : "▸"}
                              </button>
                              <span class="schema-tree-icon">
                                <IconTable />
                              </span>
                              <span class="schema-tree-label">{table.name}</span>
                            </div>

                            <Show when={open()}>
                              <Show
                                when={props.tableSchemas[table.fullName]}
                                fallback={
                                  <div class="schema-tree-row schema-tree-column-row schema-tree-loading" data-level="2">
                                    {isLoading() ? "Loading…" : "Columns unavailable"}
                                  </div>
                                }
                              >
                                <For each={cols()}>
                                  {(col) => (
                                    <div
                                      class="schema-tree-row schema-tree-column-row"
                                      data-level="2"
                                      title={`${col.name} ${col.type}`}
                                    >
                                      <span class="schema-tree-col-icon" aria-hidden="true">
                                        {col.primaryKey ? <IconKey /> : <span class="schema-tree-col-dot">•</span>}
                                      </span>
                                      <span class="schema-tree-label">
                                        {col.name}
                                        <Show when={!col.nullable}>
                                          <span class="schema-tree-required">*</span>
                                        </Show>
                                      </span>
                                      <ColumnTypePill typeText={col.type} />
                                    </div>
                                  )}
                                </For>
                              </Show>
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>
      </div>

      <div
        class="resize-handle"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          resizeState.dragging = true;
          resizeState.startX = e.clientX;
          resizeState.startWidth = props.sidebarWidth;
          try {
            (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        }}
        onPointerMove={(e) => {
          if (!resizeState.dragging) return;
          const delta = e.clientX - resizeState.startX;
          const next = Math.max(180, Math.min(420, resizeState.startWidth + delta));
          props.setSidebarWidth(next);
        }}
        onPointerUp={(e) => {
          resizeState.dragging = false;
          try {
            (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        }}
        onPointerCancel={() => {
          resizeState.dragging = false;
        }}
        onMouseDown={(e) => {
          if (typeof PointerEvent === "function") return;
          if (e.button !== 0) return;

          cleanupMouseResize?.();
          cleanupMouseResize = null;

          resizeState.dragging = true;
          resizeState.startX = e.clientX;
          resizeState.startWidth = props.sidebarWidth;

          const onMove = (ev: MouseEvent) => {
            if (!resizeState.dragging) return;
            const delta = ev.clientX - resizeState.startX;
            const next = Math.max(180, Math.min(420, resizeState.startWidth + delta));
            props.setSidebarWidth(next);
          };

          const onUp = () => {
            resizeState.dragging = false;
            cleanupMouseResize?.();
            cleanupMouseResize = null;
          };

          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp, { once: true });

          cleanupMouseResize = () => {
            window.removeEventListener("mousemove", onMove);
          };

          e.preventDefault();
        }}
      />
    </div>
  );
}
