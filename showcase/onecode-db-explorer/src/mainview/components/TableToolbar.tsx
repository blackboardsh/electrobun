import { type Setter } from "solid-js";

type TableToolbarProps = {
  tableWhere: string;
  setTableWhere: Setter<string>;
  tableLimit: number;
  onLimitInput: (value: string) => void;
  onRun: () => void;
  onClear: () => void;
  onInsert: () => void;
  isInserting: boolean;
  onCopyCsv: () => void;
  onCopyJson: () => void;
  onExportCsv: () => void;
  onExportJson: () => void;
  onDeleteSelected: () => void | Promise<void>;
  isMutating: boolean;
  selectedRowCount: number;
};

export default function TableToolbar(props: TableToolbarProps) {
  return (
    <div class="table-toolbar">
      <input
        class="input table-filter"
        value={props.tableWhere}
        onInput={(e) => props.setTableWhere(e.currentTarget.value)}
        placeholder="Filter (SQL WHERE)… e.g. age > 18"
        spellcheck={false}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          props.onRun();
        }}
      />

      <input
        class="input table-limit"
        inputMode="numeric"
        value={String(props.tableLimit)}
        onInput={(e) => props.onLimitInput(e.currentTarget.value)}
        title="Limit"
        spellcheck={false}
      />

      <div class="table-toolbar-actions">
        <button class="btn btn-ghost" onClick={props.onClear} disabled={!props.tableWhere.trim()}>
          Clear
        </button>

        <button class="btn btn-secondary" onClick={props.onInsert} disabled={props.isInserting}>
          Insert
        </button>

        <button class="btn btn-ghost" onClick={props.onCopyCsv}>
          Copy CSV
        </button>
        <button class="btn btn-ghost" onClick={props.onCopyJson}>
          Copy JSON
        </button>
        <button class="btn btn-ghost" onClick={props.onExportCsv}>
          Export CSV
        </button>
        <button class="btn btn-ghost" onClick={props.onExportJson}>
          Export JSON
        </button>

        <button
          class="btn btn-destructive"
          onClick={() => void props.onDeleteSelected()}
          disabled={props.isMutating || props.selectedRowCount === 0}
        >
          Delete{props.selectedRowCount > 0 ? ` (${props.selectedRowCount})` : ""}
        </button>

        <button class="btn btn-primary" onClick={props.onRun}>
          Run
        </button>
      </div>
    </div>
  );
}
