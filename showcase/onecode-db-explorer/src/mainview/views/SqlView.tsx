import { type SQLNamespace } from "@codemirror/lang-sql";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { type ColDef } from "ag-grid-community";
import AgGridSolid from "solid-ag-grid";
import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import SqlEditor from "../components/SqlEditor";
import SqlWorkspaceTabs from "../components/SqlWorkspaceTabs";
import type { LogEntry, QueryResult, SqlDocument, SqlHistoryItem, SqlPanelId, SqlRun, SqlSnippet } from "../types";

type PanelDropEdge = "top" | "bottom";

type SqlViewProps = {
  documents: SqlDocument[];
  activeDocumentId: string;
  setActiveDocumentId: (nextId: string) => void;
  createDocument: () => void;
  closeDocument: (id: string) => void;
  reorderDocuments: (args: { startId: string; targetId: string; edge: "left" | "right" }) => void;
  panelOrder: SqlPanelId[];
  reorderPanels: (args: { startId: SqlPanelId; targetId: SqlPanelId; edge: PanelDropEdge }) => void;
  sqlQuery: string;
  setSqlQuery: (next: string) => void;
  runSql: () => void | Promise<void>;
  cancelActiveQuery: () => void | Promise<void>;
  canCancelQuery: boolean;
  isRunning: boolean;
  startNewSnippet: (query: string) => void;
  adapter: string;
  knownTables: string[];
  ensureTableSchema: (tableName: string) => void | Promise<void>;
  sqlCompletionSchema: SQLNamespace;
  defaultTable: string | null;
  statusText: string;
  error: string | null;
  sqlRuns: SqlRun[];
  activeSqlRun: SqlRun | null;
  activeSqlRunIndex: number;
  setActiveSqlRunIndex: (next: number) => void;
  activeSqlResult: QueryResult | null;
  columnDefs: ColDef<Record<string, unknown>, unknown>[];
  gridThemeClass: string;
  logs: LogEntry[];
  sqlHistory: SqlHistoryItem[];
  clearSqlHistory: () => void;
  historyFilter: string;
  setHistoryFilter: (next: string) => void;
  filteredHistory: SqlHistoryItem[];
  loadQueryIntoEditor: (query: string, opts?: { run?: boolean }) => void;
  summarizeQuery: (query: string) => string;
  formatAge: (ts: number | null) => string;
  snippetFilter: string;
  setSnippetFilter: (next: string) => void;
  filteredSnippets: SqlSnippet[];
  truncateText: (value: string, maxChars: number) => string;
  startEditSnippet: (snippet: SqlSnippet) => void;
  deleteSnippet: (id: string) => void;
};

function getPanelDragId(source: { data?: Record<string, unknown> }) {
  const kind = source.data?.kind;
  const id = source.data?.id;
  if (kind !== "sql-panel") return null;
  if (id !== "editor" && id !== "results") return null;
  return id as SqlPanelId;
}

function getClosestVerticalEdge(element: Element, clientY: number): PanelDropEdge {
  const rect = element.getBoundingClientRect();
  const mid = rect.top + rect.height / 2;
  return clientY < mid ? "top" : "bottom";
}

function DraggablePanel(props: {
  id: SqlPanelId;
  draggingId: SqlPanelId | null;
  setDraggingId: (id: SqlPanelId | null) => void;
  indicator: null | { id: SqlPanelId; edge: PanelDropEdge };
  setIndicator: (next: null | { id: SqlPanelId; edge: PanelDropEdge }) => void;
  reorderPanels: (args: { startId: SqlPanelId; targetId: SqlPanelId; edge: PanelDropEdge }) => void;
  header: JSX.Element;
  children: JSX.Element;
}) {
  let rootEl: HTMLDivElement | undefined;
  let handleEl: HTMLDivElement | undefined;

  const isIndicator = () => props.indicator?.id === props.id;
  const indicatorEdge = () => props.indicator?.edge ?? "top";

  onMount(() => {
    if (!rootEl) return;

    const cleanup = combine(
      draggable({
        element: rootEl,
        dragHandle: handleEl,
        getInitialData: () => ({ kind: "sql-panel", id: props.id }),
        onDragStart: () => {
          props.setDraggingId(props.id);
        },
        onDrop: () => {
          props.setDraggingId(null);
          props.setIndicator(null);
        },
      }),
      dropTargetForElements({
        element: rootEl,
        canDrop: ({ source }) => {
          const startId = getPanelDragId(source);
          return Boolean(startId) && startId !== props.id;
        },
        onDragEnter: ({ source, self, location }) => {
          const startId = getPanelDragId(source);
          if (!startId || startId === props.id) return;
          const edge = getClosestVerticalEdge(self.element, location.current.input.clientY);
          props.setIndicator({ id: props.id, edge });
        },
        onDrag: ({ source, self, location }) => {
          const startId = getPanelDragId(source);
          if (!startId || startId === props.id) return;
          const edge = getClosestVerticalEdge(self.element, location.current.input.clientY);
          props.setIndicator({ id: props.id, edge });
        },
        onDragLeave: () => {
          if (props.indicator?.id !== props.id) return;
          props.setIndicator(null);
        },
        onDrop: ({ source, self, location }) => {
          const startId = getPanelDragId(source);
          if (!startId || startId === props.id) return;
          const edge = getClosestVerticalEdge(self.element, location.current.input.clientY);
          props.reorderPanels({ startId, targetId: props.id, edge });
        },
      })
    );

    onCleanup(cleanup);
  });

  return (
    <div
      ref={(el) => {
        rootEl = el;
      }}
      class="sql-panel"
      data-panel={props.id}
      data-dragging={props.draggingId === props.id ? "true" : "false"}
    >
      <div
        ref={(el) => {
          handleEl = el;
        }}
        class="sql-panel-handle"
      >
        {props.header}
      </div>
      {props.children}
      <Show when={isIndicator()}>
        <div class="sql-panel-drop-indicator" data-edge={indicatorEdge()} />
      </Show>
    </div>
  );
}

export default function SqlView(props: SqlViewProps) {
  const resolvedDialect = () => {
    const value = props.adapter;
    return value === "postgres" || value === "mysql" || value === "sqlite" ? value : undefined;
  };

  const [panelDraggingId, setPanelDraggingId] = createSignal<SqlPanelId | null>(null);
  const [panelIndicator, setPanelIndicator] = createSignal<null | { id: SqlPanelId; edge: PanelDropEdge }>(null);

  return (
    <div class="view">
      <div class="sql-layout">
        <div class="sql-main">
          <For each={props.panelOrder}>
            {(panelId) => (
              <Show when={panelId === "editor"} fallback={
                <DraggablePanel
                  id="results"
                  draggingId={panelDraggingId()}
                  setDraggingId={setPanelDraggingId}
                  indicator={panelIndicator()}
                  setIndicator={setPanelIndicator}
                  reorderPanels={props.reorderPanels}
                  header={<div class="pane-title"><div class="pane-title-left">Results</div></div>}
                  children={
                    <div class="results">
                      <div class="meta-row">
                        <div class={`pill ${(props.activeSqlRun?.error || props.error) ? "pill-error" : ""}`}>
                          {props.activeSqlRun?.error || props.error
                            ? props.activeSqlRun?.error ?? props.error
                            : props.statusText}
                        </div>
                        <div class="pill">Adapter: {props.adapter}</div>
                      </div>

                      <Show when={props.sqlRuns.length > 1}>
                        <div class="runbar" role="tablist" aria-label="Query statements">
                          <For each={props.sqlRuns}>
                            {(run, idx) => (
                              <button
                                class="run-tab"
                                data-active={props.activeSqlRunIndex === idx() ? "true" : "false"}
                                role="tab"
                                onClick={() => props.setActiveSqlRunIndex(idx())}
                                title={run.statement}
                              >
                                {idx() + 1}. {run.error ? "Error" : run.result?.command ?? "OK"}
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>

                      <div class="grid">
                        <AgGridSolid
                          class={props.gridThemeClass}
                          rowData={props.activeSqlResult?.rows ?? []}
                          columnDefs={props.columnDefs}
                          defaultColDef={{
                            sortable: true,
                            filter: true,
                            resizable: true,
                            autoHeaderHeight: true,
                          }}
                          animateRows={true}
                          suppressFieldDotNotation={true}
                        />
                      </div>

                      <Show when={props.logs.length > 0}>
                        <div class="pill">
                          {props.logs[0]?.level.toUpperCase()}: {props.logs[0]?.message}
                        </div>
                      </Show>
                    </div>
                  }
                />
              }>
                <DraggablePanel
                  id="editor"
                  draggingId={panelDraggingId()}
                  setDraggingId={setPanelDraggingId}
                  indicator={panelIndicator()}
                  setIndicator={setPanelIndicator}
                  reorderPanels={props.reorderPanels}
                  header={
                    <div class="pane-title">
                      <div class="pane-title-left">
                        SQL <span class="kbd">⌘/Ctrl</span>+<span class="kbd">Enter</span>
                      </div>
                      <div class="pane-actions">
                        <button
                          class="btn btn-ghost"
                          onClick={() => {
                            props.setSqlQuery("SELECT 1 as ok;");
                          }}
                        >
                          Reset
                        </button>
                        <button
                          class="btn btn-secondary"
                          onClick={() => props.startNewSnippet(props.sqlQuery)}
                          disabled={!props.sqlQuery.trim()}
                        >
                          Save
                        </button>
                        <button
                          class="btn btn-secondary"
                          onClick={() => void props.cancelActiveQuery()}
                          disabled={!props.canCancelQuery}
                        >
                          Cancel
                        </button>
                        <button class="btn btn-primary" onClick={() => void props.runSql()} disabled={props.isRunning}>
                          {props.isRunning ? "Running…" : "Run"}
                        </button>
                      </div>
                    </div>
                  }
                  children={
                    <div class="pane">
                      <SqlWorkspaceTabs
                        documents={props.documents}
                        activeId={props.activeDocumentId}
                        onSelect={props.setActiveDocumentId}
                        onCreate={props.createDocument}
                        onClose={props.closeDocument}
                        onReorder={props.reorderDocuments}
                      />
                      <SqlEditor
                        value={props.sqlQuery}
                        onChange={props.setSqlQuery}
                        onRun={() => void props.runSql()}
                        placeholder="Write SQL…"
                        dialect={resolvedDialect()}
                        schema={props.sqlCompletionSchema}
                        defaultSchema={resolvedDialect() === "postgres" ? "public" : undefined}
                        defaultTable={props.defaultTable ?? undefined}
                        knownTables={props.knownTables}
                        ensureTableSchema={props.ensureTableSchema}
                      />
                    </div>
                  }
                />
              </Show>
            )}
          </For>
        </div>

        <div class="sql-side">
          <div class="sql-side-card">
            <div class="sql-side-header">
              <div class="sql-side-title">History</div>
              <div class="sql-side-actions">
                <button class="btn btn-ghost btn-xs" onClick={props.clearSqlHistory} disabled={props.sqlHistory.length === 0}>
                  Clear
                </button>
              </div>
            </div>
            <div class="sql-side-body">
              <input
                class="input input-compact"
                value={props.historyFilter}
                onInput={(e) => props.setHistoryFilter(e.currentTarget.value)}
                placeholder="Filter history…"
                spellcheck={false}
              />
              <div class="sql-side-list">
                <Show
                  when={props.filteredHistory.length > 0}
                  fallback={<div class="sql-empty">No history yet.</div>}
                >
                  <For each={props.filteredHistory}>
                    {(item) => (
                      <div class="sql-item" title={item.query}>
                        <button class="sql-item-main" onClick={() => props.loadQueryIntoEditor(item.query)}>
                          <div class="sql-item-title">{props.summarizeQuery(item.query)}</div>
                          <div class="sql-item-meta">
                            <span>{item.profileName || "Unknown"}</span>
                            <span>•</span>
                            <span>{props.formatAge(item.createdAt)}</span>
                          </div>
                        </button>
                        <div class="sql-item-actions">
                          <button
                            class="btn btn-ghost btn-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.loadQueryIntoEditor(item.query, { run: true });
                            }}
                            disabled={props.isRunning}
                          >
                            Run
                          </button>
                          <button
                            class="btn btn-ghost btn-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.startNewSnippet(item.query);
                            }}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </div>

          <div class="sql-side-card">
            <div class="sql-side-header">
              <div class="sql-side-title">Snippets</div>
              <div class="sql-side-actions">
                <button
                  class="btn btn-ghost btn-xs"
                  onClick={() => props.startNewSnippet(props.sqlQuery)}
                  disabled={!props.sqlQuery.trim()}
                >
                  Save
                </button>
              </div>
            </div>
            <div class="sql-side-body">
              <input
                class="input input-compact"
                value={props.snippetFilter}
                onInput={(e) => props.setSnippetFilter(e.currentTarget.value)}
                placeholder="Filter snippets…"
                spellcheck={false}
              />
              <div class="sql-side-list">
                <Show
                  when={props.filteredSnippets.length > 0}
                  fallback={<div class="sql-empty">No snippets yet.</div>}
                >
                  <For each={props.filteredSnippets}>
                    {(snippet) => (
                      <div class="sql-item" title={snippet.query}>
                        <button class="sql-item-main" onClick={() => props.loadQueryIntoEditor(snippet.query)}>
                          <div class="sql-item-title">{snippet.name}</div>
                          <div class="sql-item-meta">
                            <span>{props.truncateText(props.summarizeQuery(snippet.query), 44)}</span>
                            <span>•</span>
                            <span>{props.formatAge(snippet.updatedAt || snippet.createdAt)}</span>
                          </div>
                        </button>
                        <div class="sql-item-actions">
                          <button
                            class="btn btn-ghost btn-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.loadQueryIntoEditor(snippet.query, { run: true });
                            }}
                            disabled={props.isRunning}
                          >
                            Run
                          </button>
                          <button
                            class="btn btn-ghost btn-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.startEditSnippet(snippet);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            class="btn btn-ghost btn-xs btn-danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.deleteSnippet(snippet.id);
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
