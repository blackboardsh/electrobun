import { For, Show, onCleanup, type Setter } from "solid-js";
import type { RelationshipInfo, TableInfo } from "../../bun/index";
import type { SchemaGraph, TabId } from "../types";

type GraphLayout = {
  stageWidth: number;
  stageHeight: number;
  nodes: Array<{ table: TableInfo; x: number; y: number }>;
};

type GraphEdge = {
  d: string;
  label: string;
  labelX: number;
  labelY: number;
  rel: RelationshipInfo;
};

type SchemaGraphViewProps = {
  graphFilter: string;
  setGraphFilter: Setter<string>;
  visibleGraphTables: TableInfo[];
  visibleGraphRelationships: RelationshipInfo[];
  graphLoading: boolean;
  error: string | null;
  loadSchemaGraph: (opts?: { force?: boolean }) => void | Promise<void>;
  setGraphScale: Setter<number>;
  clampFloat: (value: number, min: number, max: number) => number;
  setGraphHasFit: Setter<boolean>;
  fitGraphToViewport: () => void;
  graph: SchemaGraph | null;
  graphLayout: GraphLayout;
  graphTransform: string;
  graphEdges: GraphEdge[];
  graphSelectedRelationship: RelationshipInfo | null;
  setGraphSelectedRelationship: Setter<RelationshipInfo | null>;
  graphSelectedTable: string | null;
  setGraphSelectedTable: Setter<string | null>;
  selectedGraphTableInfo: TableInfo | null;
  selectedGraphOutgoing: RelationshipInfo[];
  selectedGraphIncoming: RelationshipInfo[];
  focusGraphOnTable: (name: string, opts?: { minScale?: number }) => void;
  graphPan: { x: number; y: number };
  setGraphPan: Setter<{ x: number; y: number }>;
  setGraphViewport: Setter<{ width: number; height: number }>;
  openTable: (tableName: string) => void | Promise<void>;
  isRunning: boolean;
  setActiveTable: Setter<string | null>;
  ensureSchema: (tableName: string) => void | Promise<void>;
  setActiveTab: Setter<TabId>;
};

export default function SchemaGraphView(props: SchemaGraphViewProps) {
  const graphDragState = {
    dragging: false,
    suppressClick: false,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
  };

  let cleanupMousePan: (() => void) | null = null;
  onCleanup(() => cleanupMousePan?.());

  return (
    <div class="view graph-view">
      <div class="graph-toolbar">
        <div class="graph-toolbar-left">
          <input
            class="input graph-search"
            value={props.graphFilter}
            onInput={(e) => props.setGraphFilter(e.currentTarget.value)}
            placeholder="Search tables…"
            spellcheck={false}
          />
          <div class="pill">{props.visibleGraphTables.length} tables</div>
          <div class="pill">{props.visibleGraphRelationships.length} relationships</div>
          <Show when={props.error}>
            <div class="pill pill-error graph-error-pill" title={props.error ?? undefined}>
              {props.error}
            </div>
          </Show>
        </div>

        <div class="graph-toolbar-right">
          <button class="btn btn-ghost" onClick={() => void props.loadSchemaGraph({ force: true })} disabled={props.graphLoading}>
            {props.graphLoading ? "Loading…" : "Reload"}
          </button>
          <button
            class="btn btn-ghost"
            onClick={() => {
              props.setGraphScale((s) => props.clampFloat((Number(s) || 1) * 0.9, 0.2, 2.5));
              props.setGraphHasFit(true);
            }}
            title="Zoom out"
          >
            −
          </button>
          <button
            class="btn btn-ghost"
            onClick={() => {
              props.setGraphScale((s) => props.clampFloat((Number(s) || 1) * 1.1, 0.2, 2.5));
              props.setGraphHasFit(true);
            }}
            title="Zoom in"
          >
            +
          </button>
          <button class="btn btn-secondary" onClick={props.fitGraphToViewport}>
            Fit
          </button>
        </div>
      </div>

      <div class="graph-shell">
        <div
          class="graph-viewport"
          ref={(el) => {
            const updateViewport = () => {
              const rect = el.getBoundingClientRect();
              props.setGraphViewport({ width: rect.width, height: rect.height });
            };

            updateViewport();

            if (typeof ResizeObserver === "function") {
              const ro = new ResizeObserver((entries) => {
                const entry = entries[0];
                if (!entry) return;
                const rect = entry.contentRect;
                props.setGraphViewport({ width: rect.width, height: rect.height });
              });
              ro.observe(el);
              onCleanup(() => ro.disconnect());
              return;
            }

            window.addEventListener("resize", updateViewport);
            onCleanup(() => window.removeEventListener("resize", updateViewport));
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            props.setGraphHasFit(true);
            graphDragState.dragging = true;
            graphDragState.suppressClick = false;
            graphDragState.startX = e.clientX;
            graphDragState.startY = e.clientY;
            const pan = props.graphPan;
            graphDragState.originX = pan.x;
            graphDragState.originY = pan.y;
            try {
              (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
            } catch {
              // ignore
            }
          }}
          onPointerMove={(e) => {
            if (!graphDragState.dragging) return;
            const dx = e.clientX - graphDragState.startX;
            const dy = e.clientY - graphDragState.startY;
            if (!graphDragState.suppressClick && Math.hypot(dx, dy) > 2) graphDragState.suppressClick = true;
            props.setGraphPan({ x: graphDragState.originX + dx, y: graphDragState.originY + dy });
          }}
          onPointerUp={(e) => {
            graphDragState.dragging = false;
            try {
              (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
            } catch {
              // ignore
            }
          }}
          onPointerCancel={() => {
            graphDragState.dragging = false;
          }}
          onMouseDown={(e) => {
            if (typeof PointerEvent === "function") return;
            if (e.button !== 0) return;

            cleanupMousePan?.();
            cleanupMousePan = null;

            props.setGraphHasFit(true);
            graphDragState.dragging = true;
            graphDragState.suppressClick = false;
            graphDragState.startX = e.clientX;
            graphDragState.startY = e.clientY;
            const pan = props.graphPan;
            graphDragState.originX = pan.x;
            graphDragState.originY = pan.y;

            const onMove = (ev: MouseEvent) => {
              if (!graphDragState.dragging) return;
              const dx = ev.clientX - graphDragState.startX;
              const dy = ev.clientY - graphDragState.startY;
              if (!graphDragState.suppressClick && Math.hypot(dx, dy) > 2) graphDragState.suppressClick = true;
              props.setGraphPan({ x: graphDragState.originX + dx, y: graphDragState.originY + dy });
            };

            const onUp = () => {
              graphDragState.dragging = false;
              cleanupMousePan?.();
              cleanupMousePan = null;
            };

            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp, { once: true });

            cleanupMousePan = () => {
              window.removeEventListener("mousemove", onMove);
            };

            e.preventDefault();
          }}
          onWheel={(e) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            props.setGraphScale((s) => props.clampFloat((Number(s) || 1) * factor, 0.2, 2.5));
            props.setGraphHasFit(true);
          }}
          onClick={() => {
            if (graphDragState.suppressClick) {
              graphDragState.suppressClick = false;
              return;
            }
            props.setGraphSelectedTable(null);
            props.setGraphSelectedRelationship(null);
          }}
        >
          <Show
            when={props.graph}
            fallback={
              <div class="graph-empty">
                <div class="view-card">
                  <div class="view-title">Schema Graph</div>
                  <div class="view-text">Load the full schema graph (tables + foreign keys).</div>
                  <div style={{ "margin-top": "10px" }}>
                    <button
                      class="btn btn-primary"
                      onClick={() => void props.loadSchemaGraph({ force: true })}
                      disabled={props.graphLoading}
                    >
                      {props.graphLoading ? "Loading…" : "Load graph"}
                    </button>
                  </div>
                </div>
              </div>
            }
          >
            <div
              class="graph-stage"
              style={{
                width: `${props.graphLayout.stageWidth}px`,
                height: `${props.graphLayout.stageHeight}px`,
                transform: props.graphTransform,
              }}
            >
              <svg
                class="graph-edges"
                width={props.graphLayout.stageWidth}
                height={props.graphLayout.stageHeight}
              >
                <defs>
                  <marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                    <path d="M0,0 L8,4 L0,8 Z" fill="hsl(var(--primary) / 0.55)" />
                  </marker>
                </defs>

                <For each={props.graphEdges}>
                  {(edge) => (
                    <g
                      class="graph-edge-group"
                      data-selected={props.graphSelectedRelationship === edge.rel ? "true" : "false"}
                      data-related={
                        props.graphSelectedTable &&
                        (edge.rel.fromTable === props.graphSelectedTable || edge.rel.toTable === props.graphSelectedTable)
                          ? "true"
                          : "false"
                      }
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.setGraphSelectedTable(null);
                        props.setGraphSelectedRelationship(edge.rel);
                      }}
                    >
                      <path d={edge.d} class="graph-edge" marker-end="url(#graph-arrow)" />
                      <text class="graph-edge-label" x={edge.labelX} y={edge.labelY} text-anchor="middle">
                        {edge.label}
                      </text>
                    </g>
                  )}
                </For>
              </svg>

              <For each={props.graphLayout.nodes}>
                {(node) => {
                  const cols = node.table.columns;
                  return (
                    <div
                      class="graph-node"
                      data-selected={props.graphSelectedTable === node.table.name ? "true" : "false"}
                      style={{
                        transform: `translate(${node.x}px, ${node.y}px)`,
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.setGraphSelectedRelationship(null);
                        props.setGraphSelectedTable(node.table.name);
                      }}
                      onDblClick={(e) => {
                        e.stopPropagation();
                        props.setGraphSelectedRelationship(null);
                        props.setGraphSelectedTable(node.table.name);
                        props.focusGraphOnTable(node.table.name, { minScale: 1 });
                      }}
                    >
                      <div class="graph-node-title">{node.table.name}</div>
                      <div class="graph-node-cols">
                        <For each={cols.slice(0, 6)}>
                          {(c) => (
                            <div class="graph-col">
                              <span class="graph-col-name">{c.name}</span>
                              <span class="graph-col-type">{c.type}</span>
                            </div>
                          )}
                        </For>
                        <Show when={cols.length > 6}>
                          <div class="graph-more">+{cols.length - 6} more</div>
                        </Show>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>

        <div class="graph-panel">
          <Show when={props.graphSelectedRelationship} fallback={<></>}>
            {(rel) => (
              <div class="graph-panel-card">
                <div class="graph-panel-title">Relationship</div>
                <div class="graph-panel-text">
                  <div class="pill">
                    {rel().fromTable}.{rel().fromColumn} → {rel().toTable}.{rel().toColumn}
                  </div>
                  <Show when={rel().constraintName}>
                    <div class="pill">Constraint: {rel().constraintName}</div>
                  </Show>
                </div>
              </div>
            )}
          </Show>

          <Show when={!props.graphSelectedRelationship && props.selectedGraphTableInfo} fallback={<></>}>
            {(tableInfo) => (
              <div class="graph-panel-card">
                <div class="graph-panel-title">Table</div>
                <div class="graph-panel-text">
                  <div class="pill">{tableInfo().name}</div>
                  <div class="graph-panel-actions">
                    <button
                      class="btn btn-primary"
                      onClick={() => void props.openTable(tableInfo().name)}
                      disabled={props.isRunning}
                    >
                      Open data
                    </button>
                    <button
                      class="btn btn-secondary"
                      onClick={() => {
                        props.setActiveTable(tableInfo().name);
                        void props.ensureSchema(tableInfo().name);
                        props.setActiveTab("schema");
                      }}
                    >
                      Schema
                    </button>
                    <button
                      class="btn btn-ghost"
                      onClick={() => props.focusGraphOnTable(tableInfo().name, { minScale: 1 })}
                    >
                      Focus
                    </button>
                  </div>

                  <div class="pill">{tableInfo().columns.length} columns</div>
                  <div class="pill">{props.selectedGraphOutgoing.length} outgoing</div>
                  <div class="pill">{props.selectedGraphIncoming.length} incoming</div>
                </div>
              </div>
            )}
          </Show>

          <Show when={!props.graphSelectedRelationship && !props.selectedGraphTableInfo}>
            <div class="graph-panel-card">
              <div class="graph-panel-title">Schema Graph</div>
              <div class="graph-panel-text">Select a table (node) or relationship (edge).</div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
