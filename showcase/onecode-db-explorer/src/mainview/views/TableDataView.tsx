import {
  type CellDoubleClickedEvent,
  type CellValueChangedEvent,
  type ColDef,
  type GridReadyEvent,
  type IDatasource,
  type SelectionChangedEvent,
} from "ag-grid-community";
import AgGridSolid from "solid-ag-grid";
import { Show } from "solid-js";
import type { LogEntry } from "../types";

type TableDataViewProps = {
  tableName: string;
  columnCount: number;
  onRetrySchema: () => void | Promise<void>;
  onOpenSchemaManager: () => void;
  error: string | null;
  statusText: string;
  adapter: string;
  gridThemeClass: string;
  tableLimit: number;
  clampInt: (value: number, min: number, max: number) => number;
  tableDatasource: IDatasource | null;
  columnDefs: ColDef<Record<string, unknown>, unknown>[];
  onGridReady: (e: GridReadyEvent) => void;
  onSelectionChanged: (e: SelectionChangedEvent) => void;
  onCellValueChanged: (e: CellValueChangedEvent<Record<string, unknown>>) => void;
  onCellDoubleClicked: (e: CellDoubleClickedEvent<Record<string, unknown>, unknown>) => void;
  logs: LogEntry[];
};

export default function TableDataView(props: TableDataViewProps) {
  const schemaLoaded = () => props.columnCount > 0;
  return (
    <div class="view">
      <div class="results">
        <div class="meta-row">
          <div class={`pill ${props.error ? "pill-error" : ""}`}>{props.error ? props.error : props.statusText}</div>
          <div class="pill">Adapter: {props.adapter}</div>
        </div>

        <div class="grid">
          <Show when={schemaLoaded()}>
            <AgGridSolid
              class={props.gridThemeClass}
              rowModelType="infinite"
              cacheBlockSize={props.clampInt(Number(props.tableLimit) || 100, 1, 1000)}
              maxBlocksInCache={6}
              datasource={props.tableDatasource ?? undefined}
              rowSelection="multiple"
              suppressRowClickSelection={true}
              singleClickEdit={true}
              stopEditingWhenCellsLoseFocus={true}
              columnDefs={props.columnDefs}
              defaultColDef={{
                sortable: true,
                filter: true,
                resizable: true,
                autoHeaderHeight: true,
              }}
              onGridReady={props.onGridReady}
              onSelectionChanged={props.onSelectionChanged}
              onCellValueChanged={props.onCellValueChanged}
              onCellDoubleClicked={props.onCellDoubleClicked}
              animateRows={true}
              suppressFieldDotNotation={true}
            />
          </Show>

          <Show when={!schemaLoaded()}>
            <div class="grid-overlay" role="status" aria-live="polite">
              <div class="grid-overlay-card">
                <div class="grid-overlay-title">
                  {props.error ? "Couldn’t load table schema" : "Loading table schema…"}
                </div>
                <div class="grid-overlay-text">
                  <span class="grid-overlay-table">{props.tableName}</span>
                  <span> needs column metadata before rows can render.</span>
                </div>

                <Show when={props.error}>
                  <div class="pill pill-error grid-overlay-error">{props.error}</div>
                </Show>

                <div class="grid-overlay-actions">
                  <button class="btn btn-primary" onClick={() => void props.onRetrySchema()}>
                    Retry
                  </button>
                  <button class="btn btn-secondary" onClick={props.onOpenSchemaManager}>
                    Schema
                  </button>
                </div>

                <Show when={!props.error}>
                  <div class="grid-overlay-status">
                    <span class="spinner" aria-hidden="true" />
                    Fetching columns…
                  </div>
                </Show>
              </div>
            </div>
          </Show>
        </div>

        <Show when={props.logs.length > 0}>
          <div class="pill">
            {props.logs[0]?.level.toUpperCase()}: {props.logs[0]?.message}
          </div>
        </Show>
      </div>
    </div>
  );
}
