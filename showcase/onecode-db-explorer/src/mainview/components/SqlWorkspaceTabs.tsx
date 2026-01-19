import { For, Show, createSignal, onCleanup } from "solid-js";
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

function getClosestEdge(element: Element, clientX: number): TabDropEdge {
  const rect = element.getBoundingClientRect();
  const mid = rect.left + rect.width / 2;
  return clientX < mid ? "left" : "right";
}

function getTabTargetFromPoint(clientX: number, clientY: number): null | { id: string; edge: TabDropEdge } {
  const el = document.elementFromPoint(clientX, clientY);
  const tabEl = el?.closest?.(".sql-doc-tab");
  if (!(tabEl instanceof HTMLElement)) return null;
  const id = tabEl.getAttribute("data-doc-id");
  if (!id) return null;
  return { id, edge: getClosestEdge(tabEl, clientX) };
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
  let handleEl: HTMLButtonElement | undefined;

  const isIndicator = () => props.indicator?.id === props.doc.id;
  const indicatorEdge = () => props.indicator?.edge ?? "left";

  const dragState: {
    mode: "pointer" | "mouse" | null;
    pointerId: number | null;
    startX: number;
    startY: number;
    dragging: boolean;
  } = {
    mode: null,
    pointerId: null,
    startX: 0,
    startY: 0,
    dragging: false,
  };

  const DRAG_THRESHOLD_PX = 6;

  const updateIndicatorFromPoint = (clientX: number, clientY: number) => {
    const target = getTabTargetFromPoint(clientX, clientY);
    if (!target || target.id === props.doc.id) {
      if (props.indicator) props.setIndicator(null);
      return;
    }
    props.setIndicator(target);
  };

  const finishDrag = (clientX: number, clientY: number) => {
    if (!dragState.dragging) return;

    const drop = getTabTargetFromPoint(clientX, clientY);
    if (!drop || drop.id === props.doc.id) return;

    props.onReorder({ startId: props.doc.id, targetId: drop.id, edge: drop.edge });
  };

  let cleanupMouseListeners: (() => void) | null = null;
  onCleanup(() => cleanupMouseListeners?.());

  return (
    <div
      class="sql-doc-tab"
      data-doc-id={props.doc.id}
      data-active={props.isActive ? "true" : "false"}
      data-dragging={props.draggingId === props.doc.id ? "true" : "false"}
    >
      <button
        ref={(el) => {
          handleEl = el;
        }}
        class="sql-doc-tab-button"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if (!handleEl) return;
          if (dragState.mode !== null) return;

          dragState.mode = "pointer";
          dragState.pointerId = e.pointerId;
          dragState.startX = e.clientX;
          dragState.startY = e.clientY;
          dragState.dragging = false;

          try {
            handleEl.setPointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        }}
        onPointerMove={(e) => {
          if (dragState.mode !== "pointer") return;

          const dx = e.clientX - dragState.startX;
          const dy = e.clientY - dragState.startY;

          if (!dragState.dragging) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
            dragState.dragging = true;
            props.setDraggingId(props.doc.id);
          }

          updateIndicatorFromPoint(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          if (dragState.mode !== "pointer") return;

          try {
            handleEl?.releasePointerCapture(e.pointerId);
          } catch {
            // ignore
          }

          finishDrag(e.clientX, e.clientY);

          dragState.mode = null;
          dragState.pointerId = null;
          dragState.dragging = false;
          props.setDraggingId(null);
          props.setIndicator(null);
        }}
        onPointerCancel={() => {
          if (dragState.mode !== "pointer") return;
          dragState.mode = null;
          dragState.pointerId = null;
          dragState.dragging = false;
          props.setDraggingId(null);
          props.setIndicator(null);
        }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          if (dragState.mode !== null) return;

          dragState.mode = "mouse";
          dragState.pointerId = null;
          dragState.startX = e.clientX;
          dragState.startY = e.clientY;
          dragState.dragging = false;

          const onMove = (ev: MouseEvent) => {
            if (dragState.mode !== "mouse") return;

            const dx = ev.clientX - dragState.startX;
            const dy = ev.clientY - dragState.startY;

            if (!dragState.dragging) {
              if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
              dragState.dragging = true;
              props.setDraggingId(props.doc.id);
            }

            updateIndicatorFromPoint(ev.clientX, ev.clientY);
          };

          const onUp = (ev: MouseEvent) => {
            if (dragState.mode !== "mouse") return;

            cleanupMouseListeners?.();
            cleanupMouseListeners = null;

            finishDrag(ev.clientX, ev.clientY);

            dragState.mode = null;
            dragState.dragging = false;
            props.setDraggingId(null);
            props.setIndicator(null);
          };

          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp, { once: true });

          cleanupMouseListeners = () => {
            window.removeEventListener("mousemove", onMove);
          };
        }}
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
