import Dialog from "@corvu/dialog";
import { makePersisted, storageSync } from "@solid-primitives/storage";
import {
  type CellDoubleClickedEvent,
  type CellValueChangedEvent,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type IDatasource,
  type IGetRowsParams,
  type IRowNode,
  type SelectionChangedEvent,
  type SortModelItem,
} from "ag-grid-community";
import Electrobun, { Electroview } from "electrobun/view";
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { ColumnInfo, DbExplorerRPC, RelationshipInfo, TableInfo } from "../bun/index";
import CommandPaletteDialog from "./components/CommandPaletteDialog";
import EditCellDialog, { type CellEditMode, type CellEditorKind } from "./components/EditCellDialog";
import EditConnectionDialog from "./components/EditConnectionDialog";
import StatusBar from "./components/StatusBar";
import TabBar from "./components/TabBar";
import TableToolbar from "./components/TableToolbar";
import TablesSidebar from "./components/TablesSidebar";
import TypedColumnHeader from "./components/TypedColumnHeader";
import TitleBar from "./components/TitleBar";
import type { SqlEditorHandle } from "./components/SqlEditor";
import {
  buildSqlCompletionSchema,
  clampFloat,
  clampInt,
  classifyColumnType,
  createProfileId,
  createRequestId,
    formatAge,
    formatCellEditorValue,
    formatMs,
    getCellEditorKind,
    inferProfileName,
    inferTableFromQuery,
    isTableTab,
    normalizeEditedValue,
    parseCellEditorValue,
    parseInsertValue,
    redactConnectionStringDisplay,
    splitSqlStatements,
  summarizeQuery,
  toBytes,
  truncateText,
} from "./lib/app-helpers";
import { scheduleMicrotask } from "./lib/microtask";
import ConnectionsView from "./views/ConnectionsView";
import DashboardView from "./views/DashboardView";
import LogsView from "./views/LogsView";
import NewTableView from "./views/NewTableView";
import SchemaGraphView from "./views/SchemaGraphView";
import SchemaManagerView from "./views/SchemaManagerView";
import SqlView from "./views/SqlView";
import TableDataView from "./views/TableDataView";
import type {
  CommandItem,
  ConnectionProfile,
  LogEntry,
  QueryResult,
  SchemaGraph,
  SqlDocument,
  SqlHistoryItem,
  SqlPanelId,
  SqlRun,
  SqlSnippet,
  TabId,
} from "./types";

type InsertFieldMode = "value" | "null" | "default";

type InsertFieldState = {
  mode: InsertFieldMode;
  value: string;
};

const staticTabs: Array<{ id: Exclude<TabId, `table:${string}`>; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "sql", label: "SQL" },
  { id: "graph", label: "Schema Graph" },
  { id: "schema", label: "Schema Manager" },
  { id: "logs", label: "Recent logs" },
  { id: "newTable", label: "New Table" },
];

const INTERNAL_SQLITE_ROWID = "__eb_rowid";
const INTERNAL_POSTGRES_CTID = "__eb_ctid";

let pushLog: ((entry: LogEntry) => void) | undefined;

const rpc = Electroview.defineRPC<DbExplorerRPC>({
  maxRequestTime: 60_000,
  handlers: {
    requests: {},
    messages: {
      log: (payload: { level: "info" | "error"; message: string }) => {
        if (!payload) return;
        pushLog?.({ ts: Date.now(), level: payload.level, message: payload.message });
      },
    },
  },
});

const electrobun = new Electrobun.Electroview<DbExplorerRPC>({ rpc });

export default function App() {
  const [theme, setTheme] = makePersisted(createSignal<"light" | "dark">("dark"), {
    name: "onecodeDbExplorer.theme",
    sync: storageSync,
  });

  const [profiles, setProfiles] = makePersisted(createSignal<ConnectionProfile[]>([]), {
    name: "onecodeDbExplorer.connectionProfiles",
    sync: storageSync,
  });

  const [activeProfileId, setActiveProfileId] = makePersisted(createSignal<string | null>(null), {
    name: "onecodeDbExplorer.activeProfileId",
    storage: sessionStorage,
  });

  const [windowMode, setWindowMode] = createSignal<"boot" | "main" | "connections" | "devtools">("boot");

  const [sidebarWidth, setSidebarWidth] = makePersisted(createSignal(260), {
    name: "onecodeDbExplorer.sidebarWidth",
  });

  const [activeTab, setActiveTab] = makePersisted(createSignal<TabId>("sql"), {
    name: "onecodeDbExplorer.activeTab",
    storage: sessionStorage,
  });

  const [openTables, setOpenTables] = makePersisted(createSignal<string[]>([]), {
    name: "onecodeDbExplorer.openTables",
    storage: sessionStorage,
  });

  const [tableFilter, setTableFilter] = createSignal("");
  const [tableWhere, setTableWhere] = makePersisted(createSignal(""), {
    name: "onecodeDbExplorer.tableWhere",
    storage: sessionStorage,
  });
  const [tableLimit, setTableLimit] = makePersisted(createSignal(100), {
    name: "onecodeDbExplorer.tableLimit",
    storage: sessionStorage,
  });
  const [selectedRowCount, setSelectedRowCount] = createSignal(0);
  const [insertOpen, setInsertOpen] = createSignal(false);
  const [insertFields, setInsertFields] = createSignal<Record<string, InsertFieldState>>({});
  const [insertError, setInsertError] = createSignal<string | null>(null);
  const [isInserting, setIsInserting] = createSignal(false);

  type CellEditContext = {
    table: string;
    column: string;
    typeText: string;
    kind: CellEditorKind;
    primaryKey: Record<string, unknown>;
  };

  const [cellEditOpen, setCellEditOpen] = createSignal(false);
  const [cellEditContext, setCellEditContext] = createSignal<CellEditContext | null>(null);
  const [cellEditMode, setCellEditMode] = createSignal<CellEditMode>("value");
  const [cellEditValue, setCellEditValue] = createSignal("");
  const [cellEditError, setCellEditError] = createSignal<string | null>(null);
  const [cellEditSaving, setCellEditSaving] = createSignal(false);
  let cellEditNode: IRowNode<Record<string, unknown>> | null = null;

  const [sqlDocuments, setSqlDocuments] = makePersisted(createSignal<SqlDocument[]>([]), {
    name: "onecodeDbExplorer.sqlDocuments",
    storage: sessionStorage,
  });

  const [activeSqlDocumentId, setActiveSqlDocumentId] = makePersisted(createSignal<string | null>(null), {
    name: "onecodeDbExplorer.activeSqlDocumentId",
    storage: sessionStorage,
  });

  const [sqlPanelOrder, setSqlPanelOrder] = makePersisted(createSignal<SqlPanelId[]>(["editor", "results"]), {
    name: "onecodeDbExplorer.sqlPanelOrder",
    storage: sessionStorage,
  });
  const [sqlHistory, setSqlHistory] = makePersisted(createSignal<SqlHistoryItem[]>([]), {
    name: "onecodeDbExplorer.sqlHistory",
    sync: storageSync,
  });
  const [sqlSnippets, setSqlSnippets] = makePersisted(createSignal<SqlSnippet[]>([]), {
    name: "onecodeDbExplorer.sqlSnippets",
    sync: storageSync,
  });
  const [historyFilter, setHistoryFilter] = createSignal("");
  const [snippetFilter, setSnippetFilter] = createSignal("");
  const [snippetDialogOpen, setSnippetDialogOpen] = createSignal(false);
  const [snippetEditId, setSnippetEditId] = createSignal<string | null>(null);
  const [snippetName, setSnippetName] = createSignal("");
  const [snippetQuery, setSnippetQuery] = createSignal("");
  const [snippetError, setSnippetError] = createSignal<string | null>(null);
  const [activeQueryId, setActiveQueryId] = createSignal<string | null>(null);
  const [sqlEditorHandle, setSqlEditorHandle] = createSignal<SqlEditorHandle | null>(null);

  const [adapter, setAdapter] = createSignal<string>("—");
  const [tables, setTables] = createSignal<string[]>([]);
  const [activeTable, setActiveTable] = createSignal<string | null>(null);
  const [tableSchemas, setTableSchemas] = createSignal<Record<string, ColumnInfo[]>>({});
  const [isConnecting, setIsConnecting] = createSignal(false);
  const [isRunning, setIsRunning] = createSignal(false);
  const [isMutating, setIsMutating] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [logs, setLogs] = createSignal<LogEntry[]>([]);
  const [tableLastFetch, setTableLastFetch] = createSignal<{
    table: string;
    startRow: number;
    rows: number;
    elapsedMs: number;
    at: number;
  } | null>(null);
  const [tableGridApi, setTableGridApi] = createSignal<GridApi | null>(null);
  let suppressEditRollback = false;
  const HISTORY_LIMIT = 80;
  const LONG_TEXT_DIALOG_MIN_CHARS = 160;

  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [paletteFilter, setPaletteFilter] = createSignal("");
  let paletteInputEl: HTMLInputElement | undefined;
  let connectionsMenuEl: HTMLDivElement | undefined;
  let connectionsMenuButtonEl: HTMLButtonElement | undefined;

  const [editConnectionOpen, setEditConnectionOpen] = createSignal(false);
  const [editProfileId, setEditProfileId] = createSignal<string | null>(null);
  const [editName, setEditName] = createSignal("");
  const [editConn, setEditConn] = createSignal("");
  const [isTestingConnection, setIsTestingConnection] = createSignal(false);
  const [testConnectionResult, setTestConnectionResult] =
    createSignal<null | { ok: boolean; message: string }>(null);
  const [connectionsSearch, setConnectionsSearch] = createSignal("");
  const [connectionsMenuOpen, setConnectionsMenuOpen] = createSignal(false);
  const [importOpen, setImportOpen] = createSignal(false);
  const [importConn, setImportConn] = createSignal("");
  const [importError, setImportError] = createSignal<string | null>(null);

  const [graph, setGraph] = createSignal<SchemaGraph | null>(null);
  const [graphConnectionKey, setGraphConnectionKey] = createSignal<string>("");
  const [graphLoading, setGraphLoading] = createSignal(false);
  const [graphFilter, setGraphFilter] = createSignal("");
  const [graphSelectedTable, setGraphSelectedTable] = createSignal<string | null>(null);
  const [graphSelectedRelationship, setGraphSelectedRelationship] =
    createSignal<RelationshipInfo | null>(null);
  const [graphHasFit, setGraphHasFit] = createSignal(false);
  const [graphScale, setGraphScale] = makePersisted(createSignal(1), {
    name: "onecodeDbExplorer.graphScale",
    storage: sessionStorage,
  });
  const [graphPan, setGraphPan] = createSignal({ x: 24, y: 24 });
  const [graphViewport, setGraphViewport] = createSignal({ width: 0, height: 0 });

  let hasMounted = false;

  const gridThemeClass = createMemo(() =>
    theme() === "dark" ? "ag-theme-quartz-dark" : "ag-theme-quartz"
  );

  const isConnectionsWindow = createMemo(() => windowMode() === "connections");

  const activeProfile = createMemo(() => {
    const id = activeProfileId();
    if (!id) return null;
    return profiles().find((p) => p.id === id) ?? null;
  });

  const selectedProfile = createMemo<ConnectionProfile | null>(() => {
    const list = profiles();
    if (list.length === 0) return null;
    const id = activeProfileId();
    if (id) return list.find((p) => p.id === id) ?? list[0] ?? null;
    return list[0] ?? null;
  });

  const [activeConnectionString, setActiveConnectionString] = createSignal("");
  const connectionSecretCache = new Map<string, string>();
  let activeSecretRequestId = 0;

  async function getProfileConnectionString(profileId: string) {
    const cached = connectionSecretCache.get(profileId);
    if (cached) return cached;

    const res = await electrobun.rpc!.request.getProfileConnectionString({ profileId });
    if (res.ok) {
      connectionSecretCache.set(profileId, res.connectionString);
      return res.connectionString;
    }

    const stored = (profiles() as unknown as Array<Record<string, unknown>>).find((p) => p.id === profileId);
    const legacyConn = typeof stored?.connectionString === "string" ? stored.connectionString.trim() : "";
    if (legacyConn) {
      try {
        await setProfileConnectionString(profileId, legacyConn);
        setProfiles((prev) =>
          prev.map((p) =>
            p.id === profileId
              ? {
                  id: p.id,
                  name: p.name,
                  connectionStringDisplay: redactConnectionStringDisplay(legacyConn),
                  createdAt: p.createdAt,
                  updatedAt: Date.now(),
                }
              : p
          )
        );
      } catch {
        // ignore
      }

      connectionSecretCache.set(profileId, legacyConn);
      return legacyConn;
    }

    const displayConn = typeof stored?.connectionStringDisplay === "string" ? stored.connectionStringDisplay.trim() : "";
    if (displayConn && !displayConn.includes("******")) {
      connectionSecretCache.set(profileId, displayConn);
      return displayConn;
    }

    throw new Error(res.error);
  }

  async function setProfileConnectionString(profileId: string, connectionString: string) {
    const res = await electrobun.rpc!.request.setProfileConnectionString({ profileId, connectionString });
    if (!res.ok) throw new Error(res.error);

    connectionSecretCache.set(profileId, connectionString);
    if (activeProfileId() === profileId) {
      setActiveConnectionString(connectionString);
    }
  }

  async function deleteProfileConnectionString(profileId: string) {
    connectionSecretCache.delete(profileId);
    if (activeProfileId() === profileId) {
      setActiveConnectionString("");
    }

    const res = await electrobun.rpc!.request.deleteProfileConnectionString({ profileId });
    if (!res.ok) throw new Error(res.error);
  }

  async function ensureActiveConnectionStringForProfile(profileId: string) {
    const requestId = ++activeSecretRequestId;
    const secret = await getProfileConnectionString(profileId);
    if (activeProfileId() === profileId && requestId === activeSecretRequestId) {
      setActiveConnectionString(secret);
    }
    return secret;
  }

  async function ensureActiveConnectionString() {
    const profile = activeProfile();
    if (!profile) throw new Error("No active profile.");
    return ensureActiveConnectionStringForProfile(profile.id);
  }

  const activeTableTab = createMemo(() => {
    const tab = activeTab();
    return isTableTab(tab) ? tab.slice("table:".length) : null;
  });

  const activeTableSchema = createMemo(() => {
    const tableName = activeTableTab();
    if (!tableName) return null;
    return tableSchemas()[tableName] ?? null;
  });

  const activeColumnTypeMap = createMemo(() => {
    const schema = activeTableSchema();
    if (!schema) return {};

    const out: Record<string, string> = {};
    for (const col of schema) out[col.name] = col.type;
    return out;
  });

  const activePrimaryKeyColumns = createMemo(() => {
    const schema = activeTableSchema();
    if (!schema) return [];
    return schema.filter((c) => c.primaryKey).map((c) => c.name);
  });

  const sqlCompletionSchema = createMemo(() =>
    buildSqlCompletionSchema(adapter(), tables(), tableSchemas())
  );

  const filteredProfiles = createMemo(() => {
    const filter = connectionsSearch().trim().toLowerCase();
    if (!filter) return profiles();
    return profiles().filter(
      (p) =>
        p.name.toLowerCase().includes(filter) || p.connectionStringDisplay.toLowerCase().includes(filter)
    );
  });

  const filteredHistory = createMemo(() => {
    const filter = historyFilter().trim().toLowerCase();
    if (!filter) return sqlHistory();
    return sqlHistory().filter((item) => {
      const name = item.profileName || "Unknown";
      return item.query.toLowerCase().includes(filter) || name.toLowerCase().includes(filter);
    });
  });

  const filteredSnippets = createMemo(() => {
    const filter = snippetFilter().trim().toLowerCase();
    if (!filter) return sqlSnippets();
    return sqlSnippets().filter(
      (item) => item.name.toLowerCase().includes(filter) || item.query.toLowerCase().includes(filter)
    );
  });

  const visibleGraphTables = createMemo<TableInfo[]>(() => {
    const g = graph();
    if (!g) return [];

    const q = graphFilter().trim().toLowerCase();
    if (!q) return g.tables;
    return g.tables.filter((t) => t.name.toLowerCase().includes(q));
  });

  const visibleGraphTableSet = createMemo(() => new Set(visibleGraphTables().map((t) => t.name)));

  const visibleGraphRelationships = createMemo<RelationshipInfo[]>(() => {
    const g = graph();
    if (!g) return [];
    const set = visibleGraphTableSet();
    return g.relationships.filter((r) => set.has(r.fromTable) && set.has(r.toTable));
  });

  const graphLayout = createMemo(() => {
    const NODE_W = 280;
    const NODE_H = 136;
    const PAD = 24;
    const GAP_X = 34;
    const GAP_Y = 24;
    const CLUSTER_GAP = 56;

    const vp = graphViewport();
    const targetWidth = Math.max(1100, Math.floor((vp.width || 1200) * 1.25));

    const tableList = visibleGraphTables();
    const byName = new Map<string, TableInfo>();
    for (const t of tableList) byName.set(t.name, t);

    const adjacency = new Map<string, Set<string>>();
    for (const name of byName.keys()) adjacency.set(name, new Set());

    for (const rel of visibleGraphRelationships()) {
      const a = adjacency.get(rel.fromTable);
      const b = adjacency.get(rel.toTable);
      if (!a || !b) continue;
      a.add(rel.toTable);
      b.add(rel.fromTable);
    }

    const degree = (name: string) => adjacency.get(name)?.size ?? 0;

    const visited = new Set<string>();
    const components: string[][] = [];

    for (const name of byName.keys()) {
      if (visited.has(name)) continue;
      visited.add(name);
      const queue = [name];
      const comp: string[] = [];
      while (queue.length) {
        const cur = queue.shift()!;
        comp.push(cur);
        for (const next of adjacency.get(cur) ?? []) {
          if (visited.has(next)) continue;
          visited.add(next);
          queue.push(next);
        }
      }
      components.push(comp);
    }

    components.sort((a, b) => b.length - a.length);

    let stageWidth = 0;
    let stageHeight = 0;
    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;

    const nodes: Array<{ table: TableInfo; x: number; y: number }> = [];
    const positions: Record<string, { x: number; y: number }> = {};

    for (const comp of components) {
      const compSet = new Set(comp);
      const root = comp.slice().sort((a, b) => degree(b) - degree(a))[0]!;

      const dist = new Map<string, number>();
      dist.set(root, 0);
      const q: string[] = [root];
      while (q.length) {
        const cur = q.shift()!;
        const d = dist.get(cur)!;
        for (const next of adjacency.get(cur) ?? []) {
          if (!compSet.has(next) || dist.has(next)) continue;
          dist.set(next, d + 1);
          q.push(next);
        }
      }

      const maxDist = Math.max(0, ...dist.values());
      for (const n of comp) {
        if (!dist.has(n)) dist.set(n, maxDist + 1);
      }

      const levels = new Map<number, string[]>();
      for (const n of comp) {
        const level = dist.get(n) ?? 0;
        const list = levels.get(level) ?? [];
        list.push(n);
        levels.set(level, list);
      }

      const sortedLevels = Array.from(levels.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([level, list]) => [level, list.sort((a, b) => degree(b) - degree(a))] as const);

      const innerCols = Math.min(7, Math.max(2, Math.ceil(Math.sqrt(comp.length))));

      let rowCursorLocal = 0;
      const localPositions: Record<string, { x: number; y: number }> = {};
      for (const [, list] of sortedLevels) {
        const rowsNeeded = Math.max(1, Math.ceil(list.length / innerCols));
        for (let i = 0; i < list.length; i++) {
          const name = list[i]!;
          const col = i % innerCols;
          const row = rowCursorLocal + Math.floor(i / innerCols);
          localPositions[name] = {
            x: PAD + col * (NODE_W + GAP_X),
            y: PAD + row * (NODE_H + GAP_Y),
          };
        }
        rowCursorLocal += rowsNeeded;
      }

      const compRows = Math.max(1, rowCursorLocal);
      const compWidth = PAD * 2 + innerCols * NODE_W + (innerCols - 1) * GAP_X;
      const compHeight = PAD * 2 + compRows * NODE_H + (compRows - 1) * GAP_Y;

      if (cursorX > 0 && cursorX + compWidth > targetWidth) {
        cursorX = 0;
        cursorY += rowHeight + CLUSTER_GAP;
        rowHeight = 0;
      }

      const baseX = cursorX;
      const baseY = cursorY;

      for (const name of comp) {
        const pos = localPositions[name];
        const table = byName.get(name);
        if (!pos || !table) continue;
        const x = baseX + pos.x;
        const y = baseY + pos.y;
        nodes.push({ table, x, y });
        positions[name] = { x, y };
      }

      cursorX += compWidth + CLUSTER_GAP;
      rowHeight = Math.max(rowHeight, compHeight);
      stageWidth = Math.max(stageWidth, baseX + compWidth);
      stageHeight = Math.max(stageHeight, baseY + compHeight);
    }

    if (nodes.length === 0) {
      stageWidth = PAD * 2 + NODE_W;
      stageHeight = PAD * 2 + NODE_H;
    }

    return { NODE_W, NODE_H, stageWidth, stageHeight, nodes, positions };
  });

  const graphEdges = createMemo(() => {
    const { NODE_W, NODE_H, positions } = graphLayout();
    const edges = visibleGraphRelationships();

    return edges
      .map((rel) => {
        const from = positions[rel.fromTable];
        const to = positions[rel.toTable];
        if (!from || !to) return null;

        const fromC = { x: from.x + NODE_W / 2, y: from.y + NODE_H / 2 };
        const toC = { x: to.x + NODE_W / 2, y: to.y + NODE_H / 2 };
        const dx = toC.x - fromC.x;
        const dy = toC.y - fromC.y;

        const horizontal = Math.abs(dx) >= Math.abs(dy);

        const dirX = dx >= 0 ? 1 : -1;
        const dirY = dy >= 0 ? 1 : -1;

        const startX = horizontal ? fromC.x + dirX * (NODE_W / 2) : fromC.x;
        const startY = horizontal ? fromC.y : fromC.y + dirY * (NODE_H / 2);
        const endX = horizontal ? toC.x - dirX * (NODE_W / 2) : toC.x;
        const endY = horizontal ? toC.y : toC.y - dirY * (NODE_H / 2);

        const bend = horizontal
          ? Math.min(220, Math.max(80, Math.abs(endX - startX) * 0.45))
          : Math.min(220, Math.max(80, Math.abs(endY - startY) * 0.45));

        const c1x = horizontal ? startX + dirX * bend : startX;
        const c1y = horizontal ? startY : startY + dirY * bend;
        const c2x = horizontal ? endX - dirX * bend : endX;
        const c2y = horizontal ? endY : endY - dirY * bend;

        const label = truncateText(`${rel.fromColumn} → ${rel.toColumn || "?"}`, 32);

        return {
          rel,
          d: `M ${startX} ${startY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${endX} ${endY}`,
          label,
          labelX: (startX + endX) / 2,
          labelY: (startY + endY) / 2 - 8,
        };
      })
      .filter(Boolean) as Array<{
      rel: RelationshipInfo;
      d: string;
      label: string;
      labelX: number;
      labelY: number;
    }>;
  });

  const graphTransform = createMemo(() => {
    const scale = clampFloat(Number(graphScale()) || 1, 0.2, 2.5);
    const pan = graphPan();
    return `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
  });

  const selectedGraphTableInfo = createMemo<TableInfo | null>(() => {
    const name = graphSelectedTable();
    if (!name) return null;
    return graph()?.tables.find((t) => t.name === name) ?? null;
  });

  const selectedGraphOutgoing = createMemo<RelationshipInfo[]>(() => {
    const name = graphSelectedTable();
    if (!name) return [];
    return graph()?.relationships.filter((r) => r.fromTable === name) ?? [];
  });

  const selectedGraphIncoming = createMemo<RelationshipInfo[]>(() => {
    const name = graphSelectedTable();
    if (!name) return [];
    return graph()?.relationships.filter((r) => r.toTable === name) ?? [];
  });

  pushLog = (entry) => setLogs((prev) => [entry, ...prev].slice(0, 200));

  const activeSqlDocument = createMemo<SqlDocument | null>(() => {
    const docs = sqlDocuments();
    if (docs.length === 0) return null;

    const id = activeSqlDocumentId();
    if (id) return docs.find((d) => d.id === id) ?? docs[0] ?? null;
    return docs[0] ?? null;
  });

  createEffect(() => {
    const docs = sqlDocuments();
    if (docs.length === 0) {
      const doc = createSqlDocument({ query: "SELECT * FROM customers LIMIT 100;" });
      setSqlDocuments([doc]);
      setActiveSqlDocumentId(doc.id);
      return;
    }

    const id = activeSqlDocumentId();
    if (!id || !docs.some((d) => d.id === id)) {
      setActiveSqlDocumentId(docs[0].id);
    }
  });

  const activeSqlQueryText = createMemo(() => activeSqlDocument()?.query ?? "");
  const activeSqlRunsList = createMemo(() => activeSqlDocument()?.runs ?? ([] as SqlRun[]));
  const activeSqlRunIndexValue = createMemo(() => activeSqlDocument()?.activeRunIndex ?? 0);

  const activeSqlRun = createMemo<SqlRun | null>(() => {
    const doc = activeSqlDocument();
    if (!doc) return null;
    const idx = clampInt(Number(doc.activeRunIndex) || 0, 0, Math.max(0, doc.runs.length - 1));
    return doc.runs[idx] ?? null;
  });

  const activeSqlResult = createMemo<QueryResult | null>(() => activeSqlRun()?.result ?? null);
  const canCancelQuery = createMemo(() => isRunning() && Boolean(activeQueryId()));

  const insertColumns = createMemo(() => {
    const tableName = activeTableTab();
    if (!tableName) return [] as ColumnInfo[];
    return (tableSchemas()[tableName] ?? []).slice().sort((a, b) => a.ordinal - b.ordinal);
  });

  const tableDatasource = createMemo<IDatasource | null>(() => {
    const tableName = activeTableTab();
    const conn = activeConnectionString().trim();
    if (!tableName || !conn) return null;

    const schema = tableSchemas()[tableName];
    if (!schema || schema.length === 0) return null;

    return {
      getRows: (params: IGetRowsParams) => {
        void (async () => {
          const requestStart = performance.now();

          const limit = Math.max(1, params.endRow - params.startRow);

          const schema = tableSchemas()[tableName] ?? [];
          const pkCols = schema
            .filter((c) => c.primaryKey)
            .slice()
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((c) => c.name);

          const fallbackSort: SortModelItem[] = [];
          const sortCols = pkCols.length ? pkCols : schema[0]?.name ? [schema[0].name] : [];
          for (const colId of sortCols.slice(0, 3)) {
            fallbackSort.push({ colId, sort: "asc" });
          }

          const effectiveSort = (params.sortModel.length ? params.sortModel : fallbackSort).slice(0, 4).map((s) => ({
            colId: s.colId,
            sort: s.sort === "desc" ? ("desc" as const) : ("asc" as const),
          }));

          const res = await electrobun.rpc!.request.queryTableRows({
            connectionString: conn,
            table: tableName,
            startRow: params.startRow,
            endRow: params.endRow,
            where: tableWhere().trim() || undefined,
            sortModel: effectiveSort,
            filterModel: params.filterModel,
          });

          if (!res.ok) {
            setError(res.error);
            params.failCallback();
            return;
          }

          const elapsedMs = performance.now() - requestStart;
          setError(null);
          const at = Date.now();
          setTableLastFetch({ table: tableName, startRow: params.startRow, rows: res.rows.length, elapsedMs, at });

          const lastRow = res.rows.length < limit ? params.startRow + res.rows.length : undefined;
          params.successCallback(res.rows, lastRow);
        })();
      },
    };
  });

  const columnDefs = createMemo<Array<ColDef<Record<string, unknown>, unknown>>>(() => {
    const tableName = activeTableTab();
    const cols = tableName
      ? (tableSchemas()[tableName] ?? [])
          .slice()
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((c) => c.name)
      : activeSqlResult()?.columns ?? [];
    const typeMap = tableName ? activeColumnTypeMap() : activeSqlDocument()?.typeMap ?? {};
    const pkCols = tableName ? activePrimaryKeyColumns() : [];
    const canEdit = Boolean(tableName);

    const defs: Array<ColDef<Record<string, unknown>, unknown>> = [];

    if (canEdit) {
      defs.push({
        headerName: "",
        width: 42,
        pinned: "left",
        resizable: false,
        sortable: false,
        filter: false,
        editable: false,
        suppressMenu: true,
        checkboxSelection: true,
        headerCheckboxSelection: true,
      });
    }

      defs.push({
        headerName: "#",
        width: 56,
        pinned: "left",
        resizable: false,
        sortable: false,
        filter: false,
        editable: false,
        suppressMenu: true,
        valueGetter: (params) => {
          const rowIndex = params.node?.rowIndex;
          return typeof rowIndex === "number" ? rowIndex + 1 : "";
        },
        cellClass: "cell-rownum",
      });

    for (const field of cols) {
      const typeText = typeMap[field] ?? "";
      const typeInfo = classifyColumnType(typeText);
      const dialogKind = canEdit ? getCellEditorKind(typeText) : null;

      const filterComponent = (() => {
        if (typeInfo.isNumber) return "agNumberColumnFilter";
        if (typeInfo.isDate || typeInfo.isDateTime) return "agDateColumnFilter";
        if (typeInfo.isBool) return "agSetColumnFilter";
        return "agTextColumnFilter";
      })();

      defs.push({
        field,
        headerName: field,
        headerComponent: TypedColumnHeader,
        headerComponentParams: { typeText },
        sortable: true,
        filter: filterComponent,
        filterParams: typeInfo.isBool ? { values: [true, false] } : undefined,
        resizable: true,
        editable: (p: unknown) => {
          if (!canEdit) return false;
          if (pkCols.includes(field)) return false;

          const value = (p as { value?: unknown } | null)?.value;
          if (dialogKind && dialogKind !== "longText") return false;
          if (dialogKind === "longText") {
            if (typeof value === "string") {
              if (value.length >= LONG_TEXT_DIALOG_MIN_CHARS || value.includes("\n")) return false;
            } else if (value !== null && value !== undefined) {
              return false;
            }
          }

          return (
            value === null ||
            value === undefined ||
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          );
        },
        cellClassRules: {
          "cell-null": (p) => p.value === null || p.value === undefined,
          "cell-number": (p) => typeof p.value === "number",
          "cell-uuid": (p) => typeof p.value === "string" && p.value.length === 36 && p.value.includes("-"),
        },
        valueFormatter: (p) => {
          if (p.value === null || p.value === undefined) return "NULL";
          if (typeof p.value === "string") return truncateText(p.value, 240);

          const bytes = toBytes(p.value);
          if (bytes) return `<BLOB ${bytes.length} bytes>`;

          if (typeof p.value === "object") {
            try {
              return truncateText(JSON.stringify(p.value), 240);
            } catch {
              return "[object]";
            }
          }

          return String(p.value);
        },
      });
    }

    return defs;
  });

  function refreshActiveTableGrid(opts: { resetScroll?: boolean } = {}) {
    const api = tableGridApi();
    if (!api) return;
    if (api.isDestroyed()) {
      setTableGridApi(null);
      return;
    }
    api.deselectAll();
    setSelectedRowCount(0);
    api.purgeInfiniteCache?.();
    if (opts.resetScroll !== false) {
      api.ensureIndexVisible?.(0, "top");
    }
  }

  const handleTableGridReady = (e: GridReadyEvent) => {
    setTableGridApi(e.api);
    setSelectedRowCount(0);
  };

  const handleTableSelectionChanged = (e: SelectionChangedEvent) => {
    setSelectedRowCount(e.api.getSelectedRows().length);
  };

  const handleCellEditOpenChange = (open: boolean) => {
    setCellEditOpen(open);
    if (!open) {
      setCellEditContext(null);
      setCellEditMode("value");
      setCellEditValue("");
      setCellEditError(null);
      setCellEditSaving(false);
      cellEditNode = null;
    }
  };

  type RowIdentityKind = "primaryKey" | "rowid" | "ctid";

  function buildRowIdentityFor(args: {
    operation?: "update" | "delete";
    adapter: string;
    tableName: string;
    row: Record<string, unknown>;
    primaryKeyColumns: string[];
  }): { ok: true; primaryKey: Record<string, unknown>; kind: RowIdentityKind } | { ok: false; error: string } {
    const op = args.operation ?? "update";
    if (args.primaryKeyColumns.length > 0) {
      const primaryKey: Record<string, unknown> = {};
      for (const col of args.primaryKeyColumns) primaryKey[col] = args.row[col];
      for (const [k, v] of Object.entries(primaryKey)) {
        if (v === null || v === undefined) {
          return { ok: false, error: `Cannot ${op} ${args.tableName}: missing PK value for ${k}.` };
        }
      }
      return { ok: true, primaryKey, kind: "primaryKey" };
    }

    if (args.adapter === "sqlite") {
      const rowid = args.row[INTERNAL_SQLITE_ROWID];
      if (rowid === null || rowid === undefined) {
        return { ok: false, error: `Cannot ${op} ${args.tableName}: no primary key (and no rowid).` };
      }
      return { ok: true, primaryKey: { [INTERNAL_SQLITE_ROWID]: rowid }, kind: "rowid" };
    }

    if (args.adapter === "postgres") {
      const ctid = args.row[INTERNAL_POSTGRES_CTID];
      if (ctid === null || ctid === undefined) {
        return { ok: false, error: `Cannot ${op} ${args.tableName}: no primary key (and no ctid).` };
      }
      return { ok: true, primaryKey: { [INTERNAL_POSTGRES_CTID]: ctid }, kind: "ctid" };
    }

    return { ok: false, error: `Cannot ${op} ${args.tableName}: no primary key detected.` };
  }

  const handleTableCellDoubleClicked = (e: CellDoubleClickedEvent<Record<string, unknown>, unknown>) => {
    const tableName = activeTableTab();
    const field = String(e.colDef?.field ?? "");
    if (!tableName || !field) return;

    const pkCols = activePrimaryKeyColumns();
    if (pkCols.includes(field)) return;

    const typeText = activeColumnTypeMap()[field] ?? "";
    const kind = getCellEditorKind(typeText);
    if (!kind) return;

    const row = (e.data ?? {}) as Record<string, unknown>;
    const identity = buildRowIdentityFor({ adapter: adapter(), tableName, row, primaryKeyColumns: pkCols });
    if (!identity.ok) {
      setError(identity.error);
      return;
    }

    const currentValue = row[field];
    if (
      kind === "longText" &&
      typeof currentValue === "string" &&
      currentValue.length < LONG_TEXT_DIALOG_MIN_CHARS &&
      !currentValue.includes("\n")
    ) {
      return;
    }
    setCellEditContext({ table: tableName, column: field, typeText, kind, primaryKey: identity.primaryKey });
    setCellEditMode(currentValue === null || currentValue === undefined ? "null" : "value");
    setCellEditValue(formatCellEditorValue(kind, currentValue));
    setCellEditError(null);
    setCellEditSaving(false);
    cellEditNode = e.node ?? null;
    setCellEditOpen(true);
  };

  async function submitCellEdit() {
    const ctx = cellEditContext();
    if (!ctx) return;

    const conn = activeConnectionString().trim();
    if (!conn) {
      setCellEditError("Connection string is empty.");
      return;
    }

    const parsed = parseCellEditorValue({
      kind: ctx.kind,
      mode: cellEditMode(),
      raw: cellEditValue(),
    });
    if (!parsed.ok) {
      setCellEditError(parsed.error);
      return;
    }

    setCellEditSaving(true);
    setCellEditError(null);
    try {
      const res = await electrobun.rpc!.request.updateCell({
        connectionString: conn,
        table: ctx.table,
        primaryKey: ctx.primaryKey,
        column: ctx.column,
        value: parsed.value,
        valueEncoding: parsed.valueEncoding,
      });

      if (!res.ok || res.affectedRows !== 1) {
        setCellEditError(res.ok ? `Update affected ${res.affectedRows} rows.` : res.error);
        return;
      }

      setError(null);
      const node = cellEditNode;
      handleCellEditOpenChange(false);

      const usesCtid = Object.prototype.hasOwnProperty.call(ctx.primaryKey, INTERNAL_POSTGRES_CTID);

      if (ctx.kind === "blob" || usesCtid) {
        refreshActiveTableGrid({ resetScroll: false });
        return;
      }

      if (!node) return;

      suppressEditRollback = true;
      node.setDataValue?.(ctx.column, parsed.value);
      queueMicrotask(() => {
        suppressEditRollback = false;
      });
    } finally {
      setCellEditSaving(false);
    }
  }

  const handleTableCellValueChanged = async (e: CellValueChangedEvent<Record<string, unknown>>) => {
    if (suppressEditRollback) return;

    const tableName = activeTableTab();
    const field = String(e.colDef?.field ?? "");
    if (!tableName || !field) return;

    const pkCols = activePrimaryKeyColumns();
    const row = (e.data ?? {}) as Record<string, unknown>;
    const identity = buildRowIdentityFor({ adapter: adapter(), tableName, row, primaryKeyColumns: pkCols });
    if (!identity.ok) {
      setError(identity.error);
      suppressEditRollback = true;
      e.node?.setDataValue?.(field, e.oldValue);
      queueMicrotask(() => {
        suppressEditRollback = false;
      });
      return;
    }

    const conn = activeConnectionString().trim();
    if (!conn) return;

    const typeText = activeColumnTypeMap()[field] ?? "";
    const nextValue = normalizeEditedValue(typeText, e.oldValue, e.newValue);
    const res = await electrobun.rpc!.request.updateCell({
      connectionString: conn,
      table: tableName,
      primaryKey: identity.primaryKey,
      column: field,
      value: nextValue,
    });

    if (!res.ok || res.affectedRows !== 1) {
      setError(res.ok ? `Update affected ${res.affectedRows} rows.` : res.error);
      suppressEditRollback = true;
      e.node?.setDataValue?.(field, e.oldValue);
      queueMicrotask(() => {
        suppressEditRollback = false;
      });
      return;
    }

    setError(null);

    if (identity.kind === "ctid") {
      refreshActiveTableGrid({ resetScroll: false });
    }
  };

  const schemaInFlight = new Map<string, Promise<void>>();

  async function ensureSchema(tableName: string) {
    if (tableSchemas()[tableName]) return;

    const existing = schemaInFlight.get(tableName);
    if (existing) return existing;

    const conn = activeConnectionString().trim();
    if (!conn) return;

    const task = (async () => {
      const res = await electrobun.rpc!.request.describeTable({ connectionString: conn, table: tableName });
      if (!res.ok) {
        setError(res.error);
        return;
      }

      setTableSchemas((prev) => ({ ...prev, [tableName]: res.columns }));
    })().finally(() => {
      schemaInFlight.delete(tableName);
    });

    schemaInFlight.set(tableName, task);
    return task;
  }

  async function retryActiveTableSchema() {
    const tableName = activeTableTab();
    if (!tableName) return;
    setError(null);
    await ensureSchema(tableName);
    refreshActiveTableGrid({ resetScroll: false });
  }

  async function connectAndRefresh() {
    setIsConnecting(true);
    setError(null);
    setTableSchemas({});
    resetSqlDocumentsRuntimeState();
    setGraph(null);
    setGraphConnectionKey("");
    setGraphSelectedTable(null);
    setGraphSelectedRelationship(null);
    setGraphHasFit(false);

    let conn = activeConnectionString().trim();
    if (!conn) {
      try {
        conn = (await ensureActiveConnectionString()).trim();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setAdapter("—");
        setTables([]);
        setTableLastFetch(null);
        setError(message);
        setIsConnecting(false);
        return;
      }
    }

    if (!conn) {
      setAdapter("—");
      setTables([]);
      setTableLastFetch(null);
      setError("Connection string is empty.");
      setIsConnecting(false);
      return;
    }

    const connected = await electrobun.rpc!.request.connect({ connectionString: conn });
    if (!connected.ok) {
      setAdapter("—");
      setTables([]);
      setTableLastFetch(null);
      setError(connected.error);
      setIsConnecting(false);
      return;
    }

    setAdapter(connected.adapter);

    const tableRes = await electrobun.rpc!.request.listTables({ connectionString: conn });
    if (tableRes.ok) setTables(tableRes.tables);
    else setError(tableRes.error);

    if (tableRes.ok) {
      void prefetchSchemas(tableRes.tables.slice(0, 40));
    }

    setIsConnecting(false);
  }

  async function loadSchemaGraph(opts: { force?: boolean } = {}) {
    if (graphLoading()) return;

    let conn = activeConnectionString().trim();
    if (!conn) {
      try {
        conn = (await ensureActiveConnectionString()).trim();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setError(message);
        return;
      }
    }

    if (!conn) {
      setError("Connection string is empty.");
      return;
    }

    if (!opts.force && graph() && graphConnectionKey() === conn) return;

    setGraphLoading(true);
    setError(null);

    const res = await electrobun.rpc!.request.getSchemaGraph({ connectionString: conn });
    if (!res.ok) {
      setError(res.error);
      setGraphLoading(false);
      return;
    }

    setAdapter(res.adapter);
    setTables(res.tables.map((t) => t.name));
    setGraph({ adapter: res.adapter, tables: res.tables, relationships: res.relationships });
    setGraphConnectionKey(conn);

    const schemaMap: Record<string, ColumnInfo[]> = {};
    for (const t of res.tables) schemaMap[t.name] = t.columns;
    setTableSchemas(schemaMap);

    setGraphSelectedTable(null);
    setGraphSelectedRelationship(null);
    setGraphHasFit(false);

    setGraphLoading(false);
  }

  function fitGraphToViewport() {
    const vp = graphViewport();
    if (vp.width <= 0 || vp.height <= 0) return;

    const { stageWidth, stageHeight } = graphLayout();
    if (stageWidth <= 0 || stageHeight <= 0) return;

    const margin = 24;
    const scale = clampFloat(
      Math.min((vp.width - margin * 2) / stageWidth, (vp.height - margin * 2) / stageHeight),
      0.2,
      2.5
    );

    setGraphScale(scale);
    setGraphPan({
      x: (vp.width - stageWidth * scale) / 2,
      y: (vp.height - stageHeight * scale) / 2,
    });
    setGraphHasFit(true);
  }

  function focusGraphOnTable(tableName: string, opts: { minScale?: number } = {}) {
    const vp = graphViewport();
    if (vp.width <= 0 || vp.height <= 0) return;

    const { NODE_W, NODE_H, positions } = graphLayout();
    const pos = positions[tableName];
    if (!pos) return;

    const minScale = opts.minScale ?? 1;
    const currentScale = clampFloat(Number(graphScale()) || 1, 0.2, 2.5);
    const nextScale = clampFloat(Math.max(currentScale, minScale), 0.2, 2.5);

    if (nextScale !== currentScale) setGraphScale(nextScale);

    const cx = pos.x + NODE_W / 2;
    const cy = pos.y + NODE_H / 2;

    setGraphPan({
      x: vp.width / 2 - cx * nextScale,
      y: vp.height / 2 - cy * nextScale,
    });
    setGraphHasFit(true);
  }

  function addSqlHistoryEntry(queryText: string) {
    const query = queryText.trim();
    if (!query) return;

    const profile = activeProfile();
    const profileId = profile?.id ?? null;
    const profileName = profile?.name ?? "Unknown";
    const now = Date.now();

    setSqlHistory((prev) => {
      const next = prev.filter((item) => item.query !== query || item.profileId !== profileId);
      next.unshift({ id: createRequestId(), query, createdAt: now, profileId, profileName });
      return next.slice(0, HISTORY_LIMIT);
    });
  }

  function clearSqlHistory() {
    const proceed = window.confirm("Clear SQL history?");
    if (!proceed) return;
    setSqlHistory([]);
    setHistoryFilter("");
  }

  function withViewTransition(update: () => void) {
    type ViewTransitionDoc = { startViewTransition?: (cb: () => void) => unknown };
    const start = (document as unknown as ViewTransitionDoc).startViewTransition;
    if (typeof start === "function") {
      try {
        start(() => {
          update();
        });
        return;
      } catch {
        // Some embedded WebKit builds expose `startViewTransition` but throw when invoked.
      }
    }
    update();
  }

  function createSqlDocument(args: { query: string; title?: string }): SqlDocument {
    const query = args.query;
    const title = (args.title ?? summarizeQuery(query, 42)).trim() || "Untitled";

    return {
      id: createRequestId(),
      title,
      query,
      runs: [],
      activeRunIndex: 0,
      lastRunAt: null,
      typeMap: {},
    };
  }

  function resetSqlDocumentsRuntimeState() {
    setSqlDocuments((prev) =>
      prev.map((doc) => ({
        ...doc,
        runs: [],
        activeRunIndex: 0,
        lastRunAt: null,
        typeMap: {},
      }))
    );
  }

  function setActiveSqlQuery(nextQuery: string) {
    const id = activeSqlDocument()?.id;
    if (!id) return;

    setSqlDocuments((prev) => prev.map((doc) => (doc.id === id ? { ...doc, query: nextQuery } : doc)));
  }

  function setActiveSqlRunIndex(nextIndex: number) {
    const id = activeSqlDocument()?.id;
    if (!id) return;

    setSqlDocuments((prev) =>
      prev.map((doc) => (doc.id === id ? { ...doc, activeRunIndex: nextIndex } : doc))
    );
  }

  function createNewSqlDocument(args: { query?: string; title?: string } = {}) {
    const query = args.query ?? "SELECT 1 as ok;";
    const doc = createSqlDocument({ query, title: args.title });

    withViewTransition(() => {
      setSqlDocuments((prev) => {
        const docs = prev.length ? prev.slice() : [];
        const activeId = activeSqlDocumentId();
        const activeIndex = activeId ? docs.findIndex((d) => d.id === activeId) : -1;
        const insertIndex = activeIndex >= 0 ? activeIndex + 1 : docs.length;
        docs.splice(insertIndex, 0, doc);
        return docs;
      });
      setActiveSqlDocumentId(doc.id);
    });
  }

  function closeSqlDocument(id: string) {
    const docs = sqlDocuments();
    if (docs.length <= 1) return;

    const idx = docs.findIndex((d) => d.id === id);
    if (idx === -1) return;

    const activeId = activeSqlDocumentId();
    const nextActiveId =
      activeId === id ? docs[idx - 1]?.id ?? docs[idx + 1]?.id ?? docs[0]?.id ?? null : activeId;

    withViewTransition(() => {
      setSqlDocuments((prev) => prev.filter((d) => d.id !== id));
      if (nextActiveId) setActiveSqlDocumentId(nextActiveId);
    });
  }

  function reorderSqlDocuments(args: { startId: string; targetId: string; edge: "left" | "right" }) {
    if (args.startId === args.targetId) return;

    withViewTransition(() => {
      setSqlDocuments((prev) => {
        const startIndex = prev.findIndex((d) => d.id === args.startId);
        const targetIndex = prev.findIndex((d) => d.id === args.targetId);
        if (startIndex === -1 || targetIndex === -1) return prev;

        let insertIndex = targetIndex + (args.edge === "right" ? 1 : 0);
        if (startIndex < insertIndex) insertIndex -= 1;
        insertIndex = clampInt(insertIndex, 0, prev.length - 1);
        if (insertIndex === startIndex) return prev;

        const next = prev.slice();
        const [moved] = next.splice(startIndex, 1);
        next.splice(insertIndex, 0, moved!);
        return next;
      });
    });
  }

  function reorderSqlPanels(args: { startId: SqlPanelId; targetId: SqlPanelId; edge: "top" | "bottom" }) {
    if (args.startId === args.targetId) return;

    withViewTransition(() => {
      setSqlPanelOrder((prev) => {
        const startIndex = prev.indexOf(args.startId);
        const targetIndex = prev.indexOf(args.targetId);
        if (startIndex === -1 || targetIndex === -1) return prev;

        let insertIndex = targetIndex + (args.edge === "bottom" ? 1 : 0);
        if (startIndex < insertIndex) insertIndex -= 1;
        insertIndex = clampInt(insertIndex, 0, prev.length - 1);
        if (insertIndex === startIndex) return prev;

        const next = prev.slice();
        const [moved] = next.splice(startIndex, 1);
        next.splice(insertIndex, 0, moved!);
        return next as SqlPanelId[];
      });
    });
  }

  function loadQueryIntoEditor(queryText: string, opts: { run?: boolean } = {}) {
    setActiveSqlQuery(queryText);
    setActiveTab("sql");
    if (opts.run) void runSql();
  }

  function startNewSnippet(queryText: string) {
    const query = queryText.trim();
    if (!query) {
      setSnippetError("Query is empty.");
      return;
    }

    setSnippetEditId(null);
    setSnippetName(summarizeQuery(query));
    setSnippetQuery(query);
    setSnippetError(null);
    setSnippetDialogOpen(true);
  }

  function startEditSnippet(snippet: SqlSnippet) {
    setSnippetEditId(snippet.id);
    setSnippetName(snippet.name);
    setSnippetQuery(snippet.query);
    setSnippetError(null);
    setSnippetDialogOpen(true);
  }

  function saveSnippet() {
    setSnippetError(null);
    const name = snippetName().trim();
    const query = snippetQuery().trim();
    if (!name) {
      setSnippetError("Name is required.");
      return;
    }
    if (!query) {
      setSnippetError("Query is required.");
      return;
    }

    const now = Date.now();
    const existingId = snippetEditId();
    if (!existingId) {
      const next: SqlSnippet = {
        id: createRequestId(),
        name,
        query,
        createdAt: now,
        updatedAt: now,
      };
      setSqlSnippets((prev) => [next, ...prev]);
    } else {
      setSqlSnippets((prev) => {
        const idx = prev.findIndex((item) => item.id === existingId);
        if (idx === -1) return prev;
        const updated: SqlSnippet = {
          ...prev[idx]!,
          name,
          query,
          updatedAt: now,
        };
        const next = prev.slice();
        next.splice(idx, 1);
        return [updated, ...next];
      });
    }

    setSnippetDialogOpen(false);
  }

  function deleteSnippet(id: string) {
    const proceed = window.confirm("Delete this snippet?");
    if (!proceed) return;
    setSqlSnippets((prev) => prev.filter((item) => item.id !== id));
  }

  async function cancelActiveQuery() {
    const queryId = activeQueryId();
    if (!queryId) return;
    const res = await electrobun.rpc!.request.cancelQuery({ queryId });
    if (!res.ok) {
      const msg = res.error.toLowerCase();
      if (msg.includes("finished") || msg.includes("not found")) return;
      setError(res.error);
    }
  }

  async function runSqlFromText(args: { text: string; updateTitle: boolean }) {
    if (isRunning()) return;
    setIsRunning(true);
    setError(null);
    setActiveQueryId(null);

    try {
      const doc = activeSqlDocument();
      if (!doc) return;
      const docId = doc.id;

      const conn = activeConnectionString().trim();
      if (!conn) {
        setError("Connection string is empty.");
        return;
      }

      const text = args.text.trim();
      const statements = splitSqlStatements(text);
      if (statements.length === 0) {
        setError("Query is empty.");
        return;
      }

      addSqlHistoryEntry(text);

      const runs: SqlRun[] = [];
      let firstError: { index: number; message: string } | null = null;

      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i]!;
        const queryId = createRequestId();
        setActiveQueryId(queryId);
        const res = await electrobun.rpc!.request.runQuery({ connectionString: conn, query: stmt, queryId });
        if (!res.ok) {
          runs.push({ statement: stmt, result: null, error: res.error, elapsedMs: res.elapsedMs });
          firstError = { index: i, message: res.error };
          break;
        }
        runs.push({ statement: stmt, result: res, error: null, elapsedMs: res.elapsedMs });
      }

      const now = Date.now();
      setSqlDocuments((prev) =>
        prev.map((d) =>
          d.id === docId
            ? {
                ...d,
                title: args.updateTitle ? summarizeQuery(text, 42) : d.title,
                runs,
                activeRunIndex: Math.max(0, runs.length - 1),
                lastRunAt: now,
                typeMap: {},
              }
            : d
        )
      );

      if (firstError) {
        setError(null);
        return;
      }

      let nextTypeMap: Record<string, string> = {};
      const lastWithRows = [...runs].reverse().find((r) => r.result && r.result.columns.length > 0) ?? null;
      if (lastWithRows) {
        const inferred = inferTableFromQuery(lastWithRows.statement, tables(), adapter());
        if (inferred) {
          await ensureSchema(inferred);
          const cols = tableSchemas()[inferred];
          if (cols) {
            nextTypeMap = {};
            for (const c of cols) nextTypeMap[c.name] = c.type;
          }
        }
      }

      setSqlDocuments((prev) =>
        prev.map((d) => (d.id === docId ? { ...d, typeMap: nextTypeMap } : d))
      );
    } finally {
      setActiveQueryId(null);
      setIsRunning(false);
    }
  }

  async function runSql() {
    const doc = activeSqlDocument();
    if (!doc) return;
    await runSqlFromText({ text: doc.query, updateTitle: true });
  }

  async function runSqlText(queryText: string) {
    await runSqlFromText({ text: queryText, updateTitle: false });
  }

  async function prefetchSchemas(tableList: string[]) {
    const conn = activeConnectionString().trim();
    if (!conn) return;

    for (const tableName of tableList) {
      if (tableSchemas()[tableName]) continue;
      try {
        const res = await electrobun.rpc!.request.describeTable({ connectionString: conn, table: tableName });
        if (res.ok) setTableSchemas((prev) => ({ ...prev, [tableName]: res.columns }));
      } catch {
        // ignore
      }
    }
  }

  async function pickSqliteFile() {
    const res = await electrobun.rpc!.request.pickSqliteFile({});
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (!res.path) return;

    const id = createProfileId();
    const now = Date.now();
    const filename = res.path.split("/").pop() || "database";
    const conn = `sqlite://${res.path}`;

    try {
      await setProfileConnectionString(id, conn);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(message);
      return;
    }

    const profile: ConnectionProfile = {
      id,
      name: `SQLite — ${filename}`,
      connectionStringDisplay: redactConnectionStringDisplay(conn),
      createdAt: now,
      updatedAt: now,
    };

    setProfiles((prev) => [profile, ...prev]);
    setActiveProfileId(id);
    setActiveConnectionString(conn);
    if (isConnectionsWindow()) {
      await openWindowForProfile(profile);
      return;
    }
    await connectAndRefresh();
  }

  function upsertProfile(next: ConnectionProfile) {
    setProfiles((prev) => {
      const idx = prev.findIndex((p) => p.id === next.id);
      if (idx === -1) return [next, ...prev];
      const copy = prev.slice();
      copy[idx] = next;
      return copy;
    });
  }

  async function selectProfile(profileId: string, opts: { connect?: boolean } = {}) {
    const shouldConnect = opts.connect !== false && !isConnectionsWindow();
    setActiveProfileId(profileId);
    activeSecretRequestId += 1;
    setActiveConnectionString("");
    setOpenTables([]);
    setActiveTable(null);
    setActiveTab("sql");
    setTables([]);
    resetSqlDocumentsRuntimeState();
    setTableLastFetch(null);
    setAdapter("—");
    setTableSchemas({});
    setGraph(null);
    setGraphConnectionKey("");
    setGraphSelectedTable(null);
    setGraphSelectedRelationship(null);
    setGraphHasFit(false);
    setGraphPan({ x: 24, y: 24 });
    setError(null);

    if (shouldConnect) {
      await connectAndRefresh();
    }
  }

  function getSuggestedNewWindowSize() {
    const outerW = Number(window.outerWidth);
    const outerH = Number(window.outerHeight);

    const width = Number.isFinite(outerW) && outerW > 0 ? outerW : Number(window.innerWidth);
    const height = Number.isFinite(outerH) && outerH > 0 ? outerH : Number(window.innerHeight);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

    return { width: Math.round(width), height: Math.round(height) };
  }

  async function openWindowForProfile(profile: ConnectionProfile, opts: { matchCurrentSize?: boolean } = {}) {
    const res = await electrobun.rpc!.request.openWindow({
      profileId: profile.id,
      title: `${profile.name} — DB Explorer`,
      frame: opts.matchCurrentSize ? getSuggestedNewWindowSize() ?? undefined : undefined,
    });
    if (!res.ok) setError(res.error);
  }

  async function openConnectionsWindow(action?: "new") {
    const res = await electrobun.rpc!.request.openConnectionsWindow({ action });
    if (!res.ok) setError(res.error);
  }

  async function openDevtoolsWindow() {
    const res = await electrobun.rpc!.request.openDevtoolsWindow({});
    if (!res.ok) setError(res.error);
  }

  function importConnectionFromUrl() {
    const value = importConn().trim();
    if (!value) {
      setImportError("Connection string is empty.");
      return;
    }

    const id = createProfileId();
    const now = Date.now();

    void (async () => {
      try {
        await setProfileConnectionString(id, value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setImportError(message);
        return;
      }

      const profile: ConnectionProfile = {
        id,
        name: inferProfileName(value),
        connectionStringDisplay: redactConnectionStringDisplay(value),
        createdAt: now,
        updatedAt: now,
      };

      setProfiles((prev) => [profile, ...prev]);
      setActiveProfileId(profile.id);
      setActiveConnectionString(value);
      setImportOpen(false);
      setImportConn("");
      setImportError(null);

      if (!isConnectionsWindow()) {
        await connectAndRefresh();
      }
    })();
  }

  function startCreateProfile() {
    const id = createProfileId();
    setIsTestingConnection(false);
    setTestConnectionResult(null);
    setEditProfileId(id);
    setEditName("New Connection");
    setEditConn(":memory:");
    setEditConnectionOpen(true);
  }

  function startEditProfile(profile: ConnectionProfile) {
    setIsTestingConnection(false);
    setTestConnectionResult(null);
    setEditProfileId(profile.id);
    setEditName(profile.name);
    setEditConn("");
    setEditConnectionOpen(true);

    void (async () => {
      try {
        const secret = await getProfileConnectionString(profile.id);
        setEditConn(secret);
      } catch {
        setEditConn("");
      }
    })();
  }

  const handleEditConnectionOpenChange = (open: boolean) => {
    setEditConnectionOpen(open);
    if (!open) {
      setIsTestingConnection(false);
      setTestConnectionResult(null);
    }
  };

  const handleEditConnectionStringChange = (next: string) => {
    setEditConn(next);
    setTestConnectionResult(null);
  };

  async function testEditedConnection() {
    if (isTestingConnection()) return;

    const connectionString = editConn().trim();
    if (!connectionString) {
      setTestConnectionResult({ ok: false, message: "Connection string is empty." });
      return;
    }

    setIsTestingConnection(true);
    setTestConnectionResult(null);
    try {
      const res = await electrobun.rpc!.request.connect({ connectionString });
      if (res.ok) {
        setTestConnectionResult({ ok: true, message: `Connected (${res.adapter}).` });
      } else {
        setTestConnectionResult({ ok: false, message: res.error });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTestConnectionResult({ ok: false, message });
    } finally {
      setIsTestingConnection(false);
    }
  }

  async function saveEditedProfile() {
    const id = editProfileId();
    if (!id) return;

    const name = editName().trim() || "Untitled";
    const connectionString = editConn().trim();
    if (!connectionString) {
      setError("Connection string is empty.");
      return;
    }

    try {
      await setProfileConnectionString(id, connectionString);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(message);
      return;
    }

    const existing = profiles().find((p) => p.id === id);
    const now = Date.now();
    upsertProfile({
      id,
      name,
      connectionStringDisplay: redactConnectionStringDisplay(connectionString),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    handleEditConnectionOpenChange(false);

    await selectProfile(id);
  }

  async function deleteProfile(profileId: string) {
    try {
      await deleteProfileConnectionString(profileId);
    } catch {
      // ignore
    }

    const remaining = profiles().filter((p) => p.id !== profileId);

    if (remaining.length === 0) {
      const now = Date.now();
      const id = createProfileId();
      const conn = ":memory:";

      try {
        await setProfileConnectionString(id, conn);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setError(message);
      }

      setProfiles([
        {
          id,
          name: "SQLite (:memory:)",
          connectionStringDisplay: conn,
          createdAt: now,
          updatedAt: now,
        },
      ]);
      await selectProfile(id);
      return;
    }

    setProfiles(remaining);

    if (activeProfileId() === profileId) {
      await selectProfile(remaining[0].id);
    }
  }

  async function openTable(tableName: string) {
    setError(null);
    setActiveTable(tableName);
    setActiveTab(`table:${tableName}`);
    setOpenTables((prev) => (prev.includes(tableName) ? prev : [...prev, tableName]));
    await ensureSchema(tableName);
    setTableLastFetch(null);
    queueMicrotask(() => refreshActiveTableGrid());
  }

  function closeTable(tableName: string) {
    setOpenTables((prev) => prev.filter((t) => t !== tableName));

    const tabId: TabId = `table:${tableName}`;
    if (activeTab() === tabId) {
      setActiveTab("sql");
    }
  }

  function openInsertDialog() {
    const tableName = activeTableTab();
    if (!tableName) return;

    const schema = tableSchemas()[tableName];
    if (!schema) {
      setError("Load schema before inserting rows.");
      return;
    }

    const next: Record<string, InsertFieldState> = {};
    for (const col of schema) {
      const useDefault = col.primaryKey || col.defaultValue !== null;
      next[col.name] = {
        mode: useDefault ? "default" : "value",
        value: "",
      };
    }

    setInsertFields(next);
    setInsertError(null);
    setInsertOpen(true);
  }

  function updateInsertField(name: string, patch: Partial<InsertFieldState>) {
    setInsertFields((prev) => ({
      ...prev,
      [name]: {
        mode: patch.mode ?? prev[name]?.mode ?? "value",
        value: patch.value ?? prev[name]?.value ?? "",
      },
    }));
  }

  async function submitInsertRow() {
    const tableName = activeTableTab();
    if (!tableName) return;

    const conn = activeConnectionString().trim();
    if (!conn) {
      setInsertError("Connection string is empty.");
      return;
    }

    const schema = tableSchemas()[tableName];
    if (!schema) {
      setInsertError("Schema not loaded.");
      return;
    }

    const fields = insertFields();
    const values: Record<string, unknown> = {};

    for (const col of schema) {
      const state = fields[col.name];
      if (!state) continue;

      if (state.mode === "default") continue;
      if (state.mode === "null") {
        values[col.name] = null;
        continue;
      }

      const parsed = parseInsertValue(col, state.value);
      if (!parsed.ok) {
        setInsertError(parsed.error);
        return;
      }
      values[col.name] = parsed.value;
    }

    setIsInserting(true);
    setInsertError(null);
    try {
      const res = await electrobun.rpc!.request.insertRow({ connectionString: conn, table: tableName, values });
      if (!res.ok) {
        setInsertError(res.error);
        return;
      }

      setInsertOpen(false);
      refreshActiveTableGrid();
    } finally {
      setIsInserting(false);
    }
  }

  function downloadTextFile(filename: string, contents: string, mimeType: string) {
    const blob = new Blob([contents], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function stripInternalRowFields(row: Record<string, unknown>) {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith("__eb_")) continue;
      next[key] = value;
    }
    return next;
  }

  async function copyToClipboard(text: string) {
    try {
      if (!navigator.clipboard?.writeText) {
        setError("Clipboard not available.");
        return;
      }
      await navigator.clipboard.writeText(text);
    } catch {
      setError("Clipboard access denied.");
    }
  }

  function exportTableCsv() {
    const tableName = activeTableTab();
    const api = tableGridApi();
    if (!tableName || !api) return;

    const selectedCount = api.getSelectedRows().length;
    const csv = api.getDataAsCsv({ onlySelected: selectedCount > 0 });
    if (!csv) {
      setError("No rows loaded to export.");
      return;
    }
    downloadTextFile(`${tableName}.csv`, csv, "text/csv");
  }

  function exportTableJson() {
    const tableName = activeTableTab();
    const api = tableGridApi();
    if (!tableName || !api) return;

    const selected = api.getSelectedRows();
    const rows: Record<string, unknown>[] = [];
    if (selected.length > 0) {
      rows.push(...(selected as Record<string, unknown>[]));
    } else {
      api.forEachNode((node) => {
        if (node.data) rows.push(node.data as Record<string, unknown>);
      });
    }

    if (rows.length === 0) {
      setError("No rows loaded to export.");
      return;
    }

    const json = JSON.stringify(rows.map(stripInternalRowFields), null, 2);
    downloadTextFile(`${tableName}.json`, json, "application/json");
  }

  function copyTableCsv() {
    const api = tableGridApi();
    if (!api) return;

    const selectedCount = api.getSelectedRows().length;
    const csv = api.getDataAsCsv({ onlySelected: selectedCount > 0 });
    if (!csv) {
      setError("No rows loaded to copy.");
      return;
    }
    void copyToClipboard(csv);
  }

  function copyTableJson() {
    const api = tableGridApi();
    if (!api) return;

    const selected = api.getSelectedRows();
    const rows: Record<string, unknown>[] = [];
    if (selected.length > 0) rows.push(...(selected as Record<string, unknown>[]));
    else {
      api.forEachNode((node) => {
        if (node.data) rows.push(node.data as Record<string, unknown>);
      });
    }

    if (rows.length === 0) {
      setError("No rows loaded to copy.");
      return;
    }
    void copyToClipboard(JSON.stringify(rows.map(stripInternalRowFields), null, 2));
  }

  async function deleteSelectedRows() {
    const tableName = activeTableTab();
    if (!tableName) return;

    const api = tableGridApi();
    if (!api || api.isDestroyed()) return;

    const selected = api.getSelectedRows() as Array<Record<string, unknown>>;
    if (selected.length === 0) return;

    const pkCols = activePrimaryKeyColumns();
    const primaryKeys: Array<Record<string, unknown>> = [];
    for (const row of selected) {
      const identity = buildRowIdentityFor({
        operation: "delete",
        adapter: adapter(),
        tableName,
        row,
        primaryKeyColumns: pkCols,
      });
      if (!identity.ok) {
        setError(identity.error);
        return;
      }

      primaryKeys.push(identity.primaryKey);
    }

    const proceed = window.confirm(`Delete ${primaryKeys.length} row(s) from ${tableName}?`);
    if (!proceed) return;

    const conn = activeConnectionString().trim();
    if (!conn) {
      setError("Connection string is empty.");
      return;
    }

    setIsMutating(true);
    setError(null);
    try {
      const res = await electrobun.rpc!.request.deleteRows({ connectionString: conn, table: tableName, primaryKeys });
      if (!res.ok) {
        setError(res.error);
        return;
      }

      api.deselectAll();
      refreshActiveTableGrid();
    } finally {
      setIsMutating(false);
    }
  }

  const statusText = createMemo(() => {
    const tableName = activeTableTab();
    if (tableName) {
      const info = tableLastFetch();
      if (!info || info.table !== tableName) return "Ready";
      return `${info.rows} rows • offset=${info.startRow} • ${formatMs(info.elapsedMs)}`;
    }

    const r = activeSqlResult();
    if (!r) return "Ready";

    const parts = [`${r.command}`, `count=${r.count}`, formatMs(r.elapsedMs)];
    if (r.lastInsertRowid !== null) parts.push(`lastInsertRowid=${r.lastInsertRowid}`);
    return parts.join(" • ");
  });

  const bottomStats = createMemo(() => {
    const tableName = activeTableTab();
    if (tableName) {
      const info = tableLastFetch();
      if (!info || info.table !== tableName) return "—";
      return `${info.rows} rows • offset=${info.startRow} • ${formatMs(info.elapsedMs)} • ${formatAge(info.at)}`;
    }

    const r = activeSqlResult();
    if (!r) return "—";
    const doc = activeSqlDocument();
    const age = doc?.lastRunAt ?? null;
    const rows = r.rows?.length ?? 0;
    const cols = r.columns?.length ?? 0;
    return `${rows} rows • ${cols} cols • ${formatMs(r.elapsedMs)} • ${formatAge(age)}`;
  });

  const commands = createMemo<CommandItem[]>(() => [
    {
      id: "connections",
      name: "Connections",
      description: "Manage connection profiles",
      run: async () => {
        setPaletteOpen(false);
        await openConnectionsWindow();
      },
    },
    {
      id: "devtools-window",
      name: "Devtools Window",
      description: "Open logs in a separate window",
      run: async () => {
        setPaletteOpen(false);
        await openDevtoolsWindow();
      },
    },
    {
      id: "new-window",
      name: "Open in New Window",
      description: "Open the active connection in a new window",
      disabled: !activeProfile(),
      run: async () => {
        setPaletteOpen(false);
        const profile = activeProfile();
        if (!profile) return;
        await openWindowForProfile(profile, { matchCurrentSize: true });
      },
    },
    {
      id: "new-connection",
      name: "New Connection",
      description: "Create a new connection profile",
      run: async () => {
        setPaletteOpen(false);
        await openConnectionsWindow("new");
      },
    },
    {
      id: "connect",
      name: "Connect",
      description: "Connect and load tables",
      shortcut: "⏎",
      disabled: isConnecting(),
      run: async () => {
        setPaletteOpen(false);
        await connectAndRefresh();
      },
    },
    {
      id: "open-sqlite",
      name: "Open SQLite file…",
      description: "Pick a local .db file and connect",
      run: async () => {
        setPaletteOpen(false);
        await pickSqliteFile();
      },
    },
    {
      id: "run",
      name: "Run",
      description: isTableTab(activeTab()) ? "Refresh table rows" : "Run selection / statement",
      shortcut: isTableTab(activeTab()) ? "⏎" : "⌘/Ctrl+⏎",
      disabled: isRunning(),
      run: async () => {
        setPaletteOpen(false);
        const tableName = activeTableTab();
        if (tableName) {
          setTableLastFetch(null);
          refreshActiveTableGrid();
          return;
        }
        const handle = sqlEditorHandle();
        if (handle) {
          handle.runSelectionOrStatement();
          return;
        }
        await runSql();
      },
    },
    {
      id: "run-all",
      name: "Run All",
      description: "Run all statements in the SQL editor",
      shortcut: isTableTab(activeTab()) ? undefined : "⇧⌘/Ctrl+⏎",
      disabled: isRunning() || isTableTab(activeTab()),
      run: async () => {
        setPaletteOpen(false);
        await runSql();
      },
    },
    {
      id: "cancel-run",
      name: "Cancel Query",
      description: "Cancel the active SQL execution",
      shortcut: "Esc",
      disabled: !canCancelQuery(),
      run: async () => {
        setPaletteOpen(false);
        await cancelActiveQuery();
      },
    },
    {
      id: "save-snippet",
      name: "Save Query as Snippet",
      description: "Store the current SQL in snippets",
      disabled: !(activeSqlDocument()?.query ?? "").trim(),
      run: () => {
        setPaletteOpen(false);
        startNewSnippet(activeSqlDocument()?.query ?? "");
      },
    },
    {
      id: "clear-sql-history",
      name: "Clear SQL History",
      description: "Remove all stored history entries",
      disabled: sqlHistory().length === 0,
      run: () => {
        setPaletteOpen(false);
        clearSqlHistory();
      },
    },
    {
      id: "open-sql",
      name: "Open SQL Editor",
      description: "Switch to the SQL tab",
      run: () => {
        setPaletteOpen(false);
        setActiveTab("sql");
      },
    },
    {
      id: "open-logs",
      name: "Open Recent Logs",
      description: "Switch to Recent logs",
      run: () => {
        setPaletteOpen(false);
        setActiveTab("logs");
      },
    },
    {
      id: "toggle-theme",
      name: theme() === "dark" ? "Switch to Light Theme" : "Switch to Dark Theme",
      description: "Toggle app theme",
      run: () => {
        setPaletteOpen(false);
        setTheme((t) => (t === "dark" ? "light" : "dark"));
      },
    },
  ]);

  const filteredCommands = createMemo(() => {
    const q = paletteFilter().trim().toLowerCase();
    if (!q) return commands();
    return commands().filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(q) || cmd.description.toLowerCase().includes(q)
    );
  });

  onMount(() => {
    hasMounted = true;
    const width = Math.max(180, Math.min(420, Number(sidebarWidth()) || 260));
    if (width !== sidebarWidth()) setSidebarWidth(width);

    // If bootstrapping fails (RPC not ready, unexpected URL parsing issues, etc.),
    // don't leave the UI stuck on the splash screen.
    scheduleMicrotask(() => {
      if (windowMode() === "boot") setWindowMode("main");
    });

    void (async () => {
      let requestedProfileId: string | null = null;
      let requestedMode: string | null = null;
      let requestedAction: string | null = null;

      for (let attempt = 0; attempt < 80; attempt++) {
        try {
          const boot = await electrobun.rpc?.request.getBootInfo({});
          if (boot && typeof boot === "object" && "ok" in boot && boot.ok) {
            requestedProfileId = typeof boot.profileId === "string" ? boot.profileId : null;
            requestedMode = boot.mode;
            requestedAction = boot.action;
            break;
          }
        } catch {
          // ignore
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      if (!requestedProfileId || !requestedMode) {
        const url = new URL(window.location.href);
        const params = url.searchParams;
        const hash = url.hash.startsWith("#") ? url.hash.slice(1) : "";
        const hashParams = new URLSearchParams(hash.startsWith("?") ? hash.slice(1) : hash);
        const getParam = (key: string) => hashParams.get(key) ?? params.get(key);
        requestedProfileId = requestedProfileId ?? getParam("profileId");
        requestedMode = requestedMode ?? getParam("mode");
        requestedAction = requestedAction ?? getParam("action");
      }

      const mode =
        requestedMode === "connections"
          ? "connections"
          : requestedMode === "devtools"
            ? "devtools"
            : "main";
      const isConnections = mode === "connections";
      setWindowMode(mode);

      let storedProfiles = profiles();

      if (storedProfiles.length === 0) {
        let legacyConn: string | null = null;
        try {
          const raw = localStorage.getItem("onecodeDbExplorer.connectionString");
          const parsed = raw ? JSON.parse(raw) : null;
          legacyConn = typeof parsed === "string" ? parsed : raw;
        } catch {
          legacyConn = null;
        }

        const now = Date.now();
        const id = createProfileId();
        const conn = (legacyConn ?? ":memory:").trim() || ":memory:";

        try {
          await setProfileConnectionString(id, conn);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setError(message);
        }

        const profile: ConnectionProfile = {
          id,
          name: conn === ":memory:" ? "SQLite (:memory:)" : "New Connection",
          connectionStringDisplay: redactConnectionStringDisplay(conn),
          createdAt: now,
          updatedAt: now,
        };

        setProfiles([profile]);
        setActiveProfileId(id);
        setActiveConnectionString(conn);
        storedProfiles = [profile];
      } else {
        // Migrate legacy profiles that stored raw connection strings in localStorage.
        const migrated: ConnectionProfile[] = [];
        const toStore: Array<{ profileId: string; connectionString: string }> = [];

        for (const entry of storedProfiles as unknown as Array<Record<string, unknown>>) {
          const id = typeof entry.id === "string" && entry.id.trim() ? entry.id : createProfileId();
          const createdAt = typeof entry.createdAt === "number" ? entry.createdAt : Date.now();
          const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : createdAt;

          const legacyConn = typeof entry.connectionString === "string" ? entry.connectionString.trim() : "";
          const display =
            typeof entry.connectionStringDisplay === "string" ? entry.connectionStringDisplay : null;

          if (legacyConn && !display) {
            toStore.push({ profileId: id, connectionString: legacyConn });
            migrated.push({
              id,
              name:
                typeof entry.name === "string" && entry.name.trim()
                  ? entry.name
                  : inferProfileName(legacyConn),
              connectionStringDisplay: redactConnectionStringDisplay(legacyConn),
              createdAt,
              updatedAt,
            });
            continue;
          }

          migrated.push({
            id,
            name: typeof entry.name === "string" && entry.name.trim() ? entry.name : "New Connection",
            connectionStringDisplay: display ?? "",
            createdAt,
            updatedAt,
          });
        }

        if (toStore.length > 0) {
          let storedOk = true;
          for (const item of toStore) {
            try {
              await setProfileConnectionString(item.profileId, item.connectionString);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              setError(message);
              storedOk = false;
              break;
            }
          }

          if (storedOk) {
            setProfiles(migrated);
            storedProfiles = migrated;
          }
        }
      }

      const currentId = activeProfileId();
      const desiredId =
        (requestedProfileId && storedProfiles.some((p) => p.id === requestedProfileId)
          ? requestedProfileId
          : currentId && storedProfiles.some((p) => p.id === currentId)
            ? currentId
            : storedProfiles[0]?.id) ?? null;

      if (desiredId && desiredId !== currentId) {
        setActiveProfileId(desiredId);
      }

      if (mode === "main") {
        await connectAndRefresh();
      } else if (isConnections && requestedAction === "new") {
        queueMicrotask(() => startCreateProfile());
      }
    })();

    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && key === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
      if (
        key === "escape" &&
        canCancelQuery() &&
        !paletteOpen() &&
        !editConnectionOpen() &&
        !insertOpen() &&
        !snippetDialogOpen()
      ) {
        e.preventDefault();
        void cancelActiveQuery();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    const onPointerDown = (e: PointerEvent) => {
      if (!connectionsMenuOpen()) return;
      const target = e.target as Node;
      if (connectionsMenuEl?.contains(target) || connectionsMenuButtonEl?.contains(target)) return;
      setConnectionsMenuOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    });
  });

  createEffect(() => {
    if (!hasMounted) return;

    const list = profiles();
    if (list.length === 0) return;

    const id = activeProfileId();
    if (id && list.some((p) => p.id === id)) return;

    void selectProfile(list[0].id);
  });

  createEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (theme() === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  });

  createEffect(() => {
    const tableName = activeTableTab();
    if (tableName) setActiveTable(tableName);
  });

  createEffect(() => {
    const tableName = activeTableTab();
    if (!tableName) return;
    void ensureSchema(tableName);
  });

  createEffect(() => {
    const api = tableGridApi();
    if (!api) return;
    if (api.isDestroyed()) {
      setTableGridApi(null);
      return;
    }

    const ds = tableDatasource();
    api.setGridOption("datasource", ds ?? undefined);

    if (ds) {
      setTableLastFetch(null);
      api.purgeInfiniteCache();
    }
  });

  createEffect(() => {
    if (!paletteOpen()) return;
    setPaletteFilter("");
    queueMicrotask(() => paletteInputEl?.focus());
  });

  createEffect(() => {
    if (activeTab() !== "graph") return;
    void loadSchemaGraph();
  });

  createEffect(() => {
    if (activeTab() !== "graph") return;
    if (!graph() || graphHasFit()) return;
    const vp = graphViewport();
    if (vp.width <= 0 || vp.height <= 0) return;
    fitGraphToViewport();
  });

  const handleProfileSelect = (value: string) => {
    if (value === "__manage__") {
      void openConnectionsWindow();
      return;
    }
    if (value === "__new__") {
      void openConnectionsWindow("new");
      return;
    }
    if (!profiles().some((p) => p.id === value)) return;
    void selectProfile(value);
  };

  const handleOpenActiveProfileWindow = () => {
    const profile = activeProfile();
    if (!profile) return;
    void openWindowForProfile(profile, { matchCurrentSize: true });
  };

  const handleTableRun = () => {
    setTableLastFetch(null);
    refreshActiveTableGrid();
  };

  const handleTableClear = () => {
    setTableWhere("");
    setTableLastFetch(null);
    refreshActiveTableGrid();
  };

  const handleTableLimitInput = (value: string) => {
    const next = clampInt(Number(value) || 100, 1, 1000);
    setTableLimit(next);
    refreshActiveTableGrid({ resetScroll: false });
  };

  const editConnectionDialog = (
    <EditConnectionDialog
      open={editConnectionOpen()}
      onOpenChange={handleEditConnectionOpenChange}
      name={editName()}
      onNameChange={setEditName}
      connectionString={editConn()}
      onConnectionStringChange={handleEditConnectionStringChange}
      onTest={() => void testEditedConnection()}
      isTesting={isTestingConnection()}
      testResult={testConnectionResult()}
      onSave={() => void saveEditedProfile()}
      isConnectionsWindow={isConnectionsWindow()}
    />
  );

  const connectionsView = (
    <ConnectionsView
      filteredProfiles={filteredProfiles()}
      activeProfileId={activeProfileId()}
      setActiveProfileId={setActiveProfileId}
      selectedProfile={selectedProfile()}
      openWindowForProfile={openWindowForProfile}
      startEditProfile={startEditProfile}
      deleteProfile={deleteProfile}
      startCreateProfile={startCreateProfile}
      connectionsSearch={connectionsSearch()}
      setConnectionsSearch={setConnectionsSearch}
      connectionsMenuOpen={connectionsMenuOpen()}
      setConnectionsMenuOpen={setConnectionsMenuOpen}
      setConnectionsMenuButtonEl={(el) => {
        connectionsMenuButtonEl = el;
      }}
      setConnectionsMenuEl={(el) => {
        connectionsMenuEl = el;
      }}
      importOpen={importOpen()}
      setImportOpen={setImportOpen}
      importConn={importConn()}
      setImportConn={setImportConn}
      importError={importError()}
      setImportError={setImportError}
      importConnectionFromUrl={importConnectionFromUrl}
      pickSqliteFile={pickSqliteFile}
      editDialog={editConnectionDialog}
    />
  );

  const bootView = (
    <div class="h-full grid place-items-center bg-background text-foreground select-none font-sans">
      <div class="min-w-[320px] px-5 py-4 rounded-2xl border border-border bg-card text-center shadow-[var(--shadow-soft)]">
        <div class="font-bold tracking-[0.4px]">1Code DB Explorer</div>
        <div class="mt-1.5 text-xs text-muted-foreground">Starting…</div>
      </div>
    </div>
  );

  const devtoolsView = (
    <div class="app">
      <div class="titlebar">
        <div class="brand">
          <div class="brand-title">Devtools</div>
          <div class="brand-subtitle">Logs • Solid ({__SOLID_COMPILER__}) • Bun.SQL</div>
        </div>
        <div class="toolbar">
          <button class="btn btn-secondary" onClick={() => setLogs([])}>
            Clear logs
          </button>
          <button class="btn btn-ghost" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
            {theme() === "dark" ? "Light" : "Dark"}
          </button>
        </div>
      </div>

      <div class="shell">
        <div class="main">
          <LogsView logs={logs()} />
        </div>
      </div>
    </div>
  );

  const mainView = (
    <div class="app">
      <TitleBar
        title="DB Explorer"
        subtitle={`${activeProfile()?.name ?? "No connection"} • ${adapter()} • Solid (${__SOLID_COMPILER__}) • Bun.SQL`}
        profiles={profiles()}
        activeProfileId={activeProfileId()}
        onProfileSelect={handleProfileSelect}
        onOpenConnections={openConnectionsWindow}
        onOpenDevtools={openDevtoolsWindow}
        onOpenWindow={handleOpenActiveProfileWindow}
        onOpenPalette={() => setPaletteOpen(true)}
        onToggleTheme={() => setTheme((t: "light" | "dark") => (t === "dark" ? "light" : "dark"))}
        theme={theme()}
        onConnect={connectAndRefresh}
        isConnecting={isConnecting()}
        hasActiveProfile={Boolean(activeProfile())}
      />

      <div class="shell">
        <TablesSidebar
          sidebarWidth={sidebarWidth()}
          setSidebarWidth={setSidebarWidth}
          adapter={adapter()}
          tables={tables()}
          tableSchemas={tableSchemas()}
          ensureSchema={ensureSchema}
          activeTable={activeTable()}
          openTable={openTable}
          tableFilter={tableFilter()}
          setTableFilter={setTableFilter}
          onRefresh={connectAndRefresh}
          onOpenGraph={() => setActiveTab("graph")}
          onOpenNewTable={() => setActiveTab("newTable")}
          isConnecting={isConnecting()}
        />

        <div class="main">
          <TabBar
            staticTabs={staticTabs}
            activeTab={activeTab()}
            setActiveTab={setActiveTab}
            openTables={openTables()}
            closeTable={closeTable}
            showTableToolbar={Boolean(activeTableTab())}
            tableToolbar={
              <TableToolbar
                tableWhere={tableWhere()}
                setTableWhere={setTableWhere}
                tableLimit={tableLimit()}
                onLimitInput={handleTableLimitInput}
                onRun={handleTableRun}
                onClear={handleTableClear}
                onInsert={openInsertDialog}
                isInserting={isInserting()}
                onCopyCsv={copyTableCsv}
                onCopyJson={copyTableJson}
                onExportCsv={exportTableCsv}
                onExportJson={exportTableJson}
                onDeleteSelected={deleteSelectedRows}
                isMutating={isMutating()}
                selectedRowCount={selectedRowCount()}
              />
            }
          />

          <Switch>
            <Match when={activeTab() === "dashboard"}>
              <DashboardView />
            </Match>

            <Match when={activeTab() === "sql"}>
              <SqlView
                documents={sqlDocuments()}
                activeDocumentId={activeSqlDocument()?.id ?? ""}
                setActiveDocumentId={(nextId) => setActiveSqlDocumentId(nextId)}
                createDocument={() => createNewSqlDocument()}
                closeDocument={closeSqlDocument}
                reorderDocuments={reorderSqlDocuments}
                panelOrder={sqlPanelOrder()}
                reorderPanels={reorderSqlPanels}
                sqlQuery={activeSqlQueryText()}
                setSqlQuery={setActiveSqlQuery}
                runSql={runSql}
                runSqlText={runSqlText}
                cancelActiveQuery={cancelActiveQuery}
                canCancelQuery={canCancelQuery()}
                isRunning={isRunning()}
                startNewSnippet={startNewSnippet}
                adapter={adapter()}
                knownTables={tables()}
                ensureTableSchema={ensureSchema}
                sqlCompletionSchema={sqlCompletionSchema()}
                defaultTable={inferTableFromQuery(activeSqlQueryText(), tables(), adapter())}
                statusText={statusText()}
                error={error()}
                sqlRuns={activeSqlRunsList()}
                activeSqlRun={activeSqlRun()}
                activeSqlRunIndex={activeSqlRunIndexValue()}
                setActiveSqlRunIndex={setActiveSqlRunIndex}
                activeSqlResult={activeSqlResult()}
                columnDefs={columnDefs()}
                gridThemeClass={gridThemeClass()}
                logs={logs()}
                sqlHistory={sqlHistory()}
                clearSqlHistory={clearSqlHistory}
                historyFilter={historyFilter()}
                setHistoryFilter={setHistoryFilter}
                filteredHistory={filteredHistory()}
                loadQueryIntoEditor={loadQueryIntoEditor}
                summarizeQuery={summarizeQuery}
                formatAge={formatAge}
                snippetFilter={snippetFilter()}
                setSnippetFilter={setSnippetFilter}
                filteredSnippets={filteredSnippets()}
                truncateText={truncateText}
                startEditSnippet={startEditSnippet}
                deleteSnippet={deleteSnippet}
                setSqlEditorHandle={setSqlEditorHandle}
              />
            </Match>

            <Match when={activeTab() === "graph"}>
              <SchemaGraphView
                graphFilter={graphFilter()}
                setGraphFilter={setGraphFilter}
                visibleGraphTables={visibleGraphTables()}
                visibleGraphRelationships={visibleGraphRelationships()}
                graphLoading={graphLoading()}
                error={error()}
                loadSchemaGraph={loadSchemaGraph}
                setGraphScale={setGraphScale}
                clampFloat={clampFloat}
                setGraphHasFit={setGraphHasFit}
                fitGraphToViewport={fitGraphToViewport}
                graph={graph()}
                graphLayout={graphLayout()}
                graphTransform={graphTransform()}
                graphEdges={graphEdges()}
                graphSelectedRelationship={graphSelectedRelationship()}
                setGraphSelectedRelationship={setGraphSelectedRelationship}
                graphSelectedTable={graphSelectedTable()}
                setGraphSelectedTable={setGraphSelectedTable}
                selectedGraphTableInfo={selectedGraphTableInfo()}
                selectedGraphOutgoing={selectedGraphOutgoing()}
                selectedGraphIncoming={selectedGraphIncoming()}
                focusGraphOnTable={focusGraphOnTable}
                graphPan={graphPan()}
                setGraphPan={setGraphPan}
                setGraphViewport={setGraphViewport}
                openTable={openTable}
                isRunning={isRunning()}
                setActiveTable={setActiveTable}
                ensureSchema={ensureSchema}
                setActiveTab={setActiveTab}
              />
            </Match>

            <Match when={activeTableTab()}>
              <TableDataView
                tableName={activeTableTab() ?? ""}
                columnCount={activeTableSchema()?.length ?? 0}
                onRetrySchema={retryActiveTableSchema}
                onOpenSchemaManager={() => setActiveTab("schema")}
                error={error()}
                statusText={statusText()}
                adapter={adapter()}
                gridThemeClass={gridThemeClass()}
                tableLimit={tableLimit()}
                clampInt={clampInt}
                tableDatasource={tableDatasource()}
                columnDefs={columnDefs()}
                onGridReady={handleTableGridReady}
                onSelectionChanged={handleTableSelectionChanged}
                onCellValueChanged={handleTableCellValueChanged}
                onCellDoubleClicked={handleTableCellDoubleClicked}
                logs={logs()}
              />
            </Match>

            <Match when={activeTab() === "schema"}>
              <SchemaManagerView activeTable={activeTable()} tableSchemas={tableSchemas()} ensureSchema={ensureSchema} />
            </Match>

            <Match when={activeTab() === "logs"}>
              <LogsView logs={logs()} />
            </Match>

            <Match when={activeTab() === "newTable"}>
                <NewTableView />
              </Match>
          </Switch>

          <StatusBar
            connectionLabel={activeProfile()?.connectionStringDisplay.trim() || "—"}
            tableCount={tables().length}
            bottomStats={bottomStats()}
          />
        </div>
      </div>

      <CommandPaletteDialog
        open={paletteOpen()}
        setOpen={setPaletteOpen}
        filter={paletteFilter()}
        setFilter={setPaletteFilter}
        filteredCommands={filteredCommands()}
        setInputEl={(el) => {
          paletteInputEl = el;
        }}
      />

      {editConnectionDialog}

      <Show when={cellEditContext()} keyed>
        {(ctx) => (
          <EditCellDialog
            open={cellEditOpen()}
            onOpenChange={handleCellEditOpenChange}
            table={ctx.table}
            column={ctx.column}
            typeText={ctx.typeText}
            kind={ctx.kind}
            mode={cellEditMode()}
            onModeChange={setCellEditMode}
            value={cellEditValue()}
            onValueChange={setCellEditValue}
            error={cellEditError()}
            onSave={() => void submitCellEdit()}
            isSaving={cellEditSaving()}
          />
        )}
      </Show>

      <Dialog
        open={insertOpen()}
        onOpenChange={(open) => {
          setInsertOpen(open);
          if (!open) setInsertError(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <div class="insert-dialog">
              <div class="insert-header">
                <div>
                  <div class="insert-title">Insert Row</div>
                  <div class="insert-subtitle">{activeTableTab() ?? "No table selected"}</div>
                </div>
                <Dialog.Close class="btn btn-ghost" aria-label="close">
                  Close <span class="kbd">Esc</span>
                </Dialog.Close>
              </div>

              <div class="insert-body">
                <div class="insert-meta">
                  <span class="pill">{insertColumns().length} columns</span>
                  <Show when={insertColumns().length === 0}>
                    <span class="pill pill-error">Load schema to insert</span>
                  </Show>
                </div>

                <div class="insert-grid">
                  <For each={insertColumns()}>
                    {(col) => {
                      const state = insertFields()[col.name] ?? { mode: "value", value: "" };
                      const typeInfo = classifyColumnType(col.type);
                      const showDefault = col.defaultValue !== null || col.primaryKey;
                      return (
                        <div class="insert-row">
                          <div class="insert-label">
                            <div class="insert-name">{col.name}</div>
                            <div class="insert-meta-row">
                              <span>{col.type || "type"}</span>
                              <span>{col.nullable ? "nullable" : "required"}</span>
                              <Show when={col.primaryKey}>
                                <span>pk</span>
                              </Show>
                              <Show when={col.defaultValue !== null}>
                                <span>default: {col.defaultValue}</span>
                              </Show>
                            </div>
                          </div>

                          <div class="insert-input">
                            <Switch>
                              <Match when={typeInfo.isBool}>
                                <select
                                  class="select select-compact"
                                  value={state.value}
                                  disabled={state.mode !== "value"}
                                  onChange={(e) => updateInsertField(col.name, { value: e.currentTarget.value })}
                                >
                                  <option value="">—</option>
                                  <option value="true">true</option>
                                  <option value="false">false</option>
                                </select>
                              </Match>
                              <Match when={typeInfo.isJson}>
                                <textarea
                                  class="textarea insert-textarea"
                                  value={state.value}
                                  disabled={state.mode !== "value"}
                                  onInput={(e) => updateInsertField(col.name, { value: e.currentTarget.value })}
                                  placeholder='{"key":"value"}'
                                />
                              </Match>
                              <Match when={typeInfo.isDateTime || typeInfo.isDate || typeInfo.isTime}>
                                <input
                                  class="input input-compact"
                                  type={typeInfo.isDate ? "date" : typeInfo.isTime ? "time" : "datetime-local"}
                                  value={state.value}
                                  disabled={state.mode !== "value"}
                                  onInput={(e) => updateInsertField(col.name, { value: e.currentTarget.value })}
                                />
                              </Match>
                              <Match when={typeInfo.isNumber}>
                                <input
                                  class="input input-compact"
                                  type="number"
                                  value={state.value}
                                  disabled={state.mode !== "value"}
                                  onInput={(e) => updateInsertField(col.name, { value: e.currentTarget.value })}
                                />
                              </Match>
                              <Match when={typeInfo.isText}>
                                <input
                                  class="input input-compact"
                                  value={state.value}
                                  disabled={state.mode !== "value"}
                                  onInput={(e) => updateInsertField(col.name, { value: e.currentTarget.value })}
                                />
                              </Match>
                              <Match when={true}>
                                <input
                                  class="input input-compact"
                                  value={state.value}
                                  disabled={state.mode !== "value"}
                                  onInput={(e) => updateInsertField(col.name, { value: e.currentTarget.value })}
                                />
                              </Match>
                            </Switch>
                          </div>

                          <div class="insert-mode">
                            <button
                              class="mode-btn"
                              data-active={state.mode === "value" ? "true" : "false"}
                              onClick={() => updateInsertField(col.name, { mode: "value" })}
                            >
                              Value
                            </button>
                            <button
                              class="mode-btn"
                              data-active={state.mode === "null" ? "true" : "false"}
                              onClick={() => updateInsertField(col.name, { mode: "null" })}
                            >
                              NULL
                            </button>
                            <Show when={showDefault}>
                              <button
                                class="mode-btn"
                                data-active={state.mode === "default" ? "true" : "false"}
                                onClick={() => updateInsertField(col.name, { mode: "default" })}
                              >
                                Default
                              </button>
                            </Show>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>

                <Show when={insertError()}>
                  <div class="pill pill-error">{insertError()}</div>
                </Show>

                <div class="insert-actions">
                  <button class="btn btn-secondary" onClick={() => setInsertOpen(false)}>
                    Cancel
                  </button>
                  <button class="btn btn-primary" onClick={() => void submitInsertRow()} disabled={isInserting()}>
                    {isInserting() ? "Inserting…" : "Insert row"}
                  </button>
                </div>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      <Dialog
        open={snippetDialogOpen()}
        onOpenChange={(open) => {
          setSnippetDialogOpen(open);
          if (!open) {
            setSnippetError(null);
            setSnippetEditId(null);
            setSnippetName("");
            setSnippetQuery("");
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <div class="snippet-dialog">
              <div class="snippet-header">
                <div>
                  <div class="snippet-title">{snippetEditId() ? "Edit Snippet" : "Save Snippet"}</div>
                  <div class="snippet-subtitle">{activeProfile()?.name ?? "No connection"}</div>
                </div>
                <Dialog.Close class="btn btn-ghost" aria-label="close">
                  Close <span class="kbd">Esc</span>
                </Dialog.Close>
              </div>

              <div class="snippet-body">
                <label class="field">
                  <div class="field-label">Name</div>
                  <input class="input" value={snippetName()} onInput={(e) => setSnippetName(e.currentTarget.value)} />
                </label>

                <label class="field">
                  <div class="field-label">SQL</div>
                  <textarea
                    class="textarea"
                    value={snippetQuery()}
                    onInput={(e) => setSnippetQuery(e.currentTarget.value)}
                    spellcheck={false}
                  />
                </label>

                <Show when={snippetError()}>
                  <div class="pill pill-error">{snippetError()}</div>
                </Show>

                <div class="snippet-actions">
                  <button class="btn btn-secondary" onClick={() => setSnippetDialogOpen(false)}>
                    Cancel
                  </button>
                  <button
                    class="btn btn-primary"
                    onClick={saveSnippet}
                    disabled={!snippetName().trim() || !snippetQuery().trim()}
                  >
                    {snippetEditId() ? "Update snippet" : "Save snippet"}
                  </button>
                </div>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );

  return (
    <Switch>
      <Match when={windowMode() === "boot"}>{bootView}</Match>
      <Match when={windowMode() === "connections"}>{connectionsView}</Match>
      <Match when={windowMode() === "devtools"}>{devtoolsView}</Match>
      <Match when>{mainView}</Match>
    </Switch>
  );
}
