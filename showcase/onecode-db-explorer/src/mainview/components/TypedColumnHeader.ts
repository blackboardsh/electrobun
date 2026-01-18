export default class TypedColumnHeader {
  private eGui!: HTMLDivElement;
  private nameEl!: HTMLDivElement;
  private typeEl!: HTMLDivElement;

  init(params: unknown) {
    this.eGui = document.createElement("div");
    this.eGui.className = "col-header";

    this.nameEl = document.createElement("div");
    this.nameEl.className = "col-header-name";

    this.typeEl = document.createElement("div");
    this.typeEl.className = "col-header-type";

    this.eGui.append(this.nameEl, this.typeEl);
    this.refresh(params);
  }

  getGui() {
    return this.eGui;
  }

  refresh(params: unknown) {
    const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const displayName = typeof record.displayName === "string" ? record.displayName : "";

    const column = record.column;
    type ColumnLike = { getColDef?: () => unknown };
    const colDefRaw =
      column && typeof column === "object" && typeof (column as ColumnLike).getColDef === "function"
        ? (column as ColumnLike).getColDef?.()
        : null;
    const colDef = colDefRaw && typeof colDefRaw === "object" ? (colDefRaw as Record<string, unknown>) : {};
    const field = typeof colDef.field === "string" ? colDef.field : "";

    const paramsType = typeof record.typeText === "string" ? record.typeText : "";
    const headerParamsRaw = colDef.headerComponentParams;
    const headerParams =
      headerParamsRaw && typeof headerParamsRaw === "object"
        ? (headerParamsRaw as Record<string, unknown>)
        : {};
    const headerType = typeof headerParams.typeText === "string" ? headerParams.typeText : "";

    const name = displayName || field;
    const typeText = paramsType || headerType;

    this.nameEl.textContent = name;
    this.typeEl.textContent = typeText;
    this.typeEl.style.display = typeText ? "" : "none";
    return true;
  }
}

