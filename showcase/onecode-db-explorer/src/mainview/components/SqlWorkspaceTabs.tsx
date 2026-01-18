import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { SqlDocument } from "../types";

type TabDropEdge = "left" | "right";

type SqlWorkspaceTabsProps = {
  documents: SqlDocument[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClose: (id: string) => void;
  onReorder: (args: { startId: string; targetId: string; edge: TabDropEdge }) => void;
};

function getDragId(source: { data?: Record<string, unknown> }) {
  const kind = source.data?.kind;
  const id = source.data?.id;
  if (kind !== "sql-doc-tab") return null;
  return typeof id === "string" ? id : null;
}

function getClosestEdge(element: Element, clientX: number): TabDropEdge {
  const rect = element.getBoundingClientRect();
  const mid = rect.left + rect.width / 2;
  return clientX < mid ? "left" : "right";
}

function SqlWorkspaceTab(props: {
  doc: SqlDocument;
  isActive: boolean;
  canClose: boolean;
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
  indicator: { id: string; edge: TabDropEdge } | null;
  setIndicator: (next: { id: string; edge: TabDropEdge } | null) => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (args: { startId: string; targetId: string; edge: TabDropEdge }) => void;
}) {
  let rootEl: HTMLDivElement | undefined;
  let handleEl: HTMLButtonElement | undefined;

  const isIndicator = () => props.indicator?.id === props.doc.id;
  const indicatorEdge = () => props.indicator?.edge ?? "left";

  onMount(() => {
    if (!rootEl) return;

    const cleanup = combine(
      draggable({
        element: rootEl,
        dragHandle: handleEl,
        getInitialData: () => ({ kind: "sql-doc-tab", id: props.doc.id }),
        onDragStart: () => {
          props.setDraggingId(props.doc.id);
        },
        onDrop: () => {
          props.setDraggingId(null);
          props.setIndicator(null);
        },
      }),
      dropTargetForElements({
        element: rootEl,
        canDrop: ({ source }) => {
          const id = getDragId(source);
          return Boolean(id) && id !== props.doc.id;
        },
        onDragEnter: ({ source, self, location }) => {
          const startId = getDragId(source);
          if (!startId || startId === props.doc.id) return;
          const edge = getClosestEdge(self.element, location.current.input.clientX);
          props.setIndicator({ id: props.doc.id, edge });
        },
        onDrag: ({ source, self, location }) => {
          const startId = getDragId(source);
          if (!startId || startId === props.doc.id) return;
          const edge = getClosestEdge(self.element, location.current.input.clientX);
          props.setIndicator({ id: props.doc.id, edge });
        },
        onDragLeave: () => {
          if (props.indicator?.id !== props.doc.id) return;
          props.setIndicator(null);
        },
        onDrop: ({ source, self, location }) => {
          const startId = getDragId(source);
          if (!startId || startId === props.doc.id) return;
          const edge = getClosestEdge(self.element, location.current.input.clientX);
          props.onReorder({ startId, targetId: props.doc.id, edge });
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
      class="sql-doc-tab"
      data-active={props.isActive ? "true" : "false"}
      data-dragging={props.draggingId === props.doc.id ? "true" : "false"}
    >
      <button
        ref={(el) => {
          handleEl = el;
        }}
        class="sql-doc-tab-button"
        onClick={() => props.onSelect(props.doc.id)}
        title={props.doc.query}
      >
        {props.doc.title}
      </button>
      <button
        class="sql-doc-tab-close"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose(props.doc.id);
        }}
        disabled={!props.canClose}
        aria-label={`Close ${props.doc.title}`}
        title={props.canClose ? "Close" : "Cannot close last tab"}
      >
        ×
      </button>

      <Show when={isIndicator()}>
        <div class="sql-doc-drop-indicator" data-edge={indicatorEdge()} />
      </Show>
    </div>
  );
}

export default function SqlWorkspaceTabs(props: SqlWorkspaceTabsProps) {
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [indicator, setIndicator] = createSignal<null | { id: string; edge: TabDropEdge }>(null);

  return (
    <div class="sql-doc-tabs" role="tablist" aria-label="SQL documents">
      <For each={props.documents}>
        {(doc) => (
          <SqlWorkspaceTab
            doc={doc}
            isActive={props.activeId === doc.id}
            canClose={props.documents.length > 1}
            draggingId={draggingId()}
            setDraggingId={setDraggingId}
            indicator={indicator()}
            setIndicator={setIndicator}
            onSelect={props.onSelect}
            onClose={props.onClose}
            onReorder={props.onReorder}
          />
        )}
      </For>
      <button class="sql-doc-add" onClick={props.onCreate} aria-label="New query tab" title="New query tab">
        +
      </button>
    </div>
  );
}
