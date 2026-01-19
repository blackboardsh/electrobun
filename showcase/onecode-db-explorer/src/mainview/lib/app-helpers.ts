import { type SQLNamespace } from "@codemirror/lang-sql";
import type { ColumnInfo } from "../../bun/index";
import type { CellEditMode, CellEditorKind } from "../components/EditCellDialog";
import type { TabId } from "../types";

export function formatMs(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

export function formatAge(ts: number | null) {
  if (!ts) return "—";
  const delta = Date.now() - ts;
  if (delta < 1000) return "just now";
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return `${Math.round(delta / 3_600_000)}h ago`;
}

export function isTableTab(tab: TabId): tab is `table:${string}` {
  return tab.startsWith("table:");
}

export function clampInt(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function clampFloat(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function createProfileId() {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export function createRequestId() {
  return createProfileId();
}

export function inferProfileName(connectionString: string) {
  const trimmed = connectionString.trim();
  if (!trimmed) return "New Connection";

  const lower = trimmed.toLowerCase();
  if (trimmed === ":memory:" || lower === "sqlite::memory:") return "SQLite (:memory:)";

  const sqlitePrefix =
    lower.startsWith("sqlite:") || lower.startsWith("file:") || lower.endsWith(".db") || lower.endsWith(".sqlite");
  if (sqlitePrefix) {
    const withoutScheme = trimmed.replace(/^sqlite:\/\//i, "").replace(/^sqlite:/i, "").replace(/^file:\/\//i, "");
    const filename = withoutScheme.split("/").filter(Boolean).pop() ?? "database";
    return `SQLite — ${filename}`;
  }

  if (lower.startsWith("postgres://") || lower.startsWith("postgresql://")) {
    try {
      const url = new URL(trimmed);
      const host = url.hostname || "localhost";
      const port = url.port ? `:${url.port}` : "";
      return `Postgres — ${host}${port}`;
    } catch {
      return "Postgres";
    }
  }

  if (lower.startsWith("mysql://") || lower.startsWith("mysql2://")) {
    try {
      const url = new URL(trimmed);
      const host = url.hostname || "localhost";
      const port = url.port ? `:${url.port}` : "";
      return `MySQL — ${host}${port}`;
    } catch {
      return "MySQL";
    }
  }

  return "Database";
}

export function redactConnectionStringDisplay(connectionString: string) {
  const trimmed = connectionString.trim();
  if (!trimmed) return trimmed;

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("postgres://") ||
    lower.startsWith("postgresql://") ||
    lower.startsWith("mysql://") ||
    lower.startsWith("mysql2://")
  ) {
    try {
      const url = new URL(trimmed);
      if (url.password) url.password = "******";
      if (url.searchParams.has("password")) url.searchParams.set("password", "******");
      return url.toString();
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

export function inferTableFromQuery(query: string, knownTables: string[], adapter: string) {
  const text = query.trim();
  if (!text) return null;

  const match = text.match(/\bfrom\s+([^\s;]+)/i);
  if (!match) return null;

  const raw = match[1] ?? "";
  const cleaned = raw.replace(/[;,)]$/g, "");
  const parts = cleaned
    .split(".")
    .filter((p) => p.length > 0)
    .map((p) => p.replace(/^["`]/, "").replace(/["`]$/, ""));
  const normalized = parts.join(".");
  if (!normalized) return null;

  if (knownTables.includes(normalized)) return normalized;

  const bySuffix = knownTables.filter((t) => t.split(".").pop() === normalized);
  if (bySuffix.length === 1) return bySuffix[0];

  if (adapter === "postgres") {
    const publicName = `public.${normalized}`;
    if (knownTables.includes(publicName)) return publicName;
  }

  if (adapter === "sqlite") return normalized;
  return null;
}

function stripSqlIdentifierQuotes(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === `"` && last === `"`) || (first === "`" && last === "`")) {
    return trimmed.slice(1, -1).replace(/""/g, `"`).replace(/``/g, "`");
  }

  return trimmed;
}

export function normalizeSqlTableReference(raw: string) {
  const cleaned = raw.replace(/[;,)]$/g, "");
  const parts = cleaned
    .split(".")
    .map((p) => stripSqlIdentifierQuotes(p))
    .filter((p) => p.length > 0);
  return parts.join(".");
}

export function resolveTableReference(reference: string, knownTables: string[], adapter: string) {
  const normalized = normalizeSqlTableReference(reference);
  if (!normalized) return null;

  if (knownTables.includes(normalized)) return normalized;

  const bySuffix = knownTables.filter((t) => t.split(".").pop() === normalized);
  if (bySuffix.length === 1) return bySuffix[0] ?? null;

  if (adapter === "postgres") {
    const publicName = `public.${normalized}`;
    if (knownTables.includes(publicName)) return publicName;
  }

  if (adapter === "sqlite") return normalized;
  return null;
}

export function inferSqlAliasMap(query: string, knownTables: string[], adapter: string) {
  const text = query;
  const out: Record<string, string> = {};

  const RESERVED = new Set([
    "on",
    "where",
    "group",
    "order",
    "limit",
    "offset",
    "inner",
    "left",
    "right",
    "full",
    "cross",
    "join",
    "union",
    "except",
    "intersect",
    "having",
    "returning",
    "window",
  ]);

  const re = /\b(from|join)\s+([^\s,()]+)(?:\s+(?:as\s+)?([^\s,()]+))?/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text))) {
    const tableToken = match[2];
    if (!tableToken) continue;
    if (tableToken.startsWith("(")) continue;

    const aliasToken = match[3];
    if (!aliasToken) continue;

    const alias = stripSqlIdentifierQuotes(aliasToken);
    if (!alias) continue;
    if (RESERVED.has(alias.toLowerCase())) continue;

    const resolvedTable = resolveTableReference(tableToken, knownTables, adapter);
    if (!resolvedTable) continue;

    out[alias] = resolvedTable;
  }

  return out;
}

export function splitSqlStatements(input: string) {
  if (!input.trim()) return [];

  const out: string[] = [];
  let start = 0;
  let i = 0;

  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarDelim: string | null = null;

  const pushStatement = (endIndex: number) => {
    const stmt = input.slice(start, endIndex).trim();
    if (stmt) out.push(stmt);
  };

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (dollarDelim) {
      const delim = dollarDelim;
      if (input.startsWith(delim, i)) {
        dollarDelim = null;
        i += delim.length;
        continue;
      }
      i += 1;
      continue;
    }

    if (inSingle) {
      if (ch === "'") {
        if (next === "'") {
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i += 1;
      continue;
    }

    if (inDouble) {
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }

    if (inBacktick) {
      if (ch === "`") inBacktick = false;
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      i += 1;
      continue;
    }

    if (ch === "`") {
      inBacktick = true;
      i += 1;
      continue;
    }

    if (ch === "$") {
      const rest = input.slice(i);
      const match = rest.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$/) ?? rest.match(/^\$\$/);
      if (match) {
        dollarDelim = match[0];
        i += dollarDelim.length;
        continue;
      }
    }

    if (ch === ";") {
      pushStatement(i);
      start = i + 1;
      i += 1;
      continue;
    }

    i += 1;
  }

  pushStatement(input.length);
  return out;
}

export function getSqlStatementAtCursor(input: string, cursorIndex: number): string | null {
  const source = input ?? "";
  if (!source.trim()) return null;

  const len = source.length;
  const cursor = Math.max(0, Math.min(len, Math.trunc(cursorIndex)));

  const segments: Array<{ start: number; end: number }> = [];
  let start = 0;
  let i = 0;

  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarDelim: string | null = null;

  const pushSegment = (endIndex: number) => {
    segments.push({ start, end: endIndex });
  };

  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (dollarDelim) {
      const delim = dollarDelim;
      if (source.startsWith(delim, i)) {
        dollarDelim = null;
        i += delim.length;
        continue;
      }
      i += 1;
      continue;
    }

    if (inSingle) {
      if (ch === "'") {
        if (next === "'") {
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i += 1;
      continue;
    }

    if (inDouble) {
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }

    if (inBacktick) {
      if (ch === "`") inBacktick = false;
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      i += 1;
      continue;
    }

    if (ch === "`") {
      inBacktick = true;
      i += 1;
      continue;
    }

    if (ch === "$") {
      const rest = source.slice(i);
      const match = rest.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$/) ?? rest.match(/^\$\$/);
      if (match) {
        dollarDelim = match[0];
        i += dollarDelim.length;
        continue;
      }
    }

    if (ch === ";") {
      pushSegment(i);
      start = i + 1;
      i += 1;
      continue;
    }

    i += 1;
  }

  pushSegment(len);
  if (segments.length === 0) return null;

  const rawIndex = segments.findIndex((s) => cursor >= s.start && cursor <= s.end);
  const segIndex = rawIndex === -1 ? Math.max(0, segments.length - 1) : rawIndex;

  const getText = (idx: number) => source.slice(segments[idx]!.start, segments[idx]!.end).trim();

  const initial = segIndex >= 0 ? getText(segIndex) : "";
  if (initial) return initial;

  for (let j = segIndex + 1; j < segments.length; j++) {
    const nextText = getText(j);
    if (nextText) return nextText;
  }

  for (let j = segIndex - 1; j >= 0; j--) {
    const prevText = getText(j);
    if (prevText) return prevText;
  }

  return null;
}

export function normalizeEditedValue(typeText: string, oldValue: unknown, nextValue: unknown) {
  if (typeof nextValue !== "string") return nextValue;

  const trimmed = nextValue.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "null") return null;

  const { isJson, isBool, isDateTime, isDate, isTime, isNumber, isBlob } = classifyColumnType(typeText);
  const treatEmptyAsNull = isJson || isBool || isDateTime || isDate || isTime || isNumber || isBlob;
  if (trimmed === "" && treatEmptyAsNull) return null;

  if (isBool) {
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
  }

  if (isNumber) {
    const n = Number(trimmed);
    if (!Number.isNaN(n)) return n;
  }

  if (isJson) {
    if (!trimmed) return null;
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return nextValue;
    }
  }

  if (typeof oldValue === "boolean") {
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
  }

  if (typeof oldValue === "number") {
    const n = Number(trimmed);
    if (!Number.isNaN(n)) return n;
  }

  return nextValue;
}

export function classifyColumnType(typeText: string) {
  const type = typeText.toLowerCase();
  const isJson = type.includes("json");
  const isBool = type.includes("bool") || type.includes("bit");
  const isBlob = type.includes("blob") || type.includes("bytea") || type.includes("binary");
  const isDateTime = type.includes("timestamp") || type.includes("datetime");
  const isDate = type.includes("date") && !isDateTime;
  const isTime = type.includes("time") && !isDateTime;
  const isNumber =
    type.includes("int") ||
    type.includes("numeric") ||
    type.includes("decimal") ||
    type.includes("float") ||
    type.includes("double") ||
    type.includes("real") ||
    type.includes("serial");
  const isLongText = type.includes("text") || type.includes("clob");
  const isText = type.includes("char") || isLongText || type.includes("uuid");

  return {
    isJson,
    isBool,
    isBlob,
    isDateTime,
    isDate,
    isTime,
    isNumber,
    isLongText,
    isText,
  };
}

export function summarizeQuery(query: string, maxLen = 72) {
  const line = query.trim().split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const compact = line.replace(/\s+/g, " ").trim();
  if (!compact) return "Untitled";
  return compact.length > maxLen ? `${compact.slice(0, maxLen - 1)}…` : compact;
}

export function parseInsertValue(column: ColumnInfo, raw: string) {
  const { isJson, isBool, isDateTime, isDate, isTime, isNumber, isText } = classifyColumnType(column.type);
  const trimmed = raw.trim();

  if ((isNumber || isBool || isJson || isDateTime || isDate || isTime) && trimmed === "") {
    return { ok: true as const, value: null };
  }

  if (isBool) {
    const lower = trimmed.toLowerCase();
    if (lower === "true" || lower === "1") return { ok: true as const, value: true };
    if (lower === "false" || lower === "0") return { ok: true as const, value: false };
    return { ok: false as const, error: `Invalid boolean for ${column.name}` };
  }

  if (isNumber) {
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return { ok: false as const, error: `Invalid number for ${column.name}` };
    return { ok: true as const, value: num };
  }

  if (isJson) {
    if (!trimmed) return { ok: true as const, value: null };
    try {
      JSON.parse(trimmed);
      return { ok: true as const, value: trimmed };
    } catch {
      return { ok: false as const, error: `Invalid JSON for ${column.name}` };
    }
  }

  if (isDateTime || isDate || isTime) {
    return { ok: true as const, value: trimmed };
  }

  if (isText) return { ok: true as const, value: raw };
  return { ok: true as const, value: raw };
}

export function getCellEditorKind(typeText: string): CellEditorKind | null {
  const { isJson, isBlob, isDateTime, isDate, isTime, isLongText } = classifyColumnType(typeText);
  if (isJson) return "json";
  if (isBlob) return "blob";
  if (isDateTime) return "datetime";
  if (isDate) return "date";
  if (isTime) return "time";
  if (isLongText) return "longText";
  return null;
}

function isBufferJson(value: unknown): value is { type: "Buffer"; data: number[] } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "Buffer") return false;
  const data = record.data;
  return Array.isArray(data) && data.every((entry) => typeof entry === "number");
}

export function toBytes(value: unknown): Uint8Array | null {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (isBufferJson(value)) return Uint8Array.from(value.data);
  return null;
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function formatCellEditorValue(kind: CellEditorKind, value: unknown) {
  if (value === null || value === undefined) return "";

  if (kind === "blob") {
    const bytes = toBytes(value);
    if (!bytes) return "";
    const maxBytes = 64 * 1024;
    if (bytes.length > maxBytes) return bytesToBase64(bytes.subarray(0, maxBytes));
    return bytesToBase64(bytes);
  }

  if (kind === "json") {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return JSON.stringify(JSON.parse(trimmed), null, 2);
        } catch {
          return value;
        }
      }
      return value;
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function parseCellEditorValue(args: { kind: CellEditorKind; mode: CellEditMode; raw: string }) {
  if (args.mode === "null") return { ok: true as const, value: null as unknown };

  if (args.kind === "longText") return { ok: true as const, value: args.raw };

  const trimmed = args.raw.trim();
  if (!trimmed) return { ok: true as const, value: null as unknown };

  if (args.kind === "json") {
    try {
      JSON.parse(trimmed);
      return { ok: true as const, value: trimmed };
    } catch {
      return { ok: false as const, error: "Invalid JSON." };
    }
  }

  if (args.kind === "blob") {
    return { ok: true as const, value: trimmed, valueEncoding: "base64" as const };
  }

  return { ok: true as const, value: trimmed };
}

export function buildSqlCompletionSchema(
  adapter: string,
  tableNames: string[],
  tableSchemas: Record<string, ColumnInfo[]>
): SQLNamespace {
  const out: Record<string, unknown> = {};

  const addTable = (schemaName: string | null, tableName: string, columns: string[]) => {
    if (schemaName) {
      const existing = out[schemaName];
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        out[schemaName] = {};
      }
      (out[schemaName] as Record<string, string[]>)[tableName] = columns;
      return;
    }

    out[tableName] = columns;
  };

  for (const fullName of tableNames) {
    const cols = (tableSchemas[fullName] ?? []).map((c) => c.name);

    if (adapter === "postgres" || adapter === "mysql") {
      const [schemaName, tableName] = fullName.split(".", 2);
      if (schemaName && tableName) {
        addTable(schemaName, tableName, cols);
        continue;
      }
    }

    addTable(null, fullName, cols);
  }

  return out as unknown as SQLNamespace;
}
