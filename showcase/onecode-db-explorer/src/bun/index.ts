import { SQL } from "bun";
import { BrowserView, BrowserWindow, Utils, type RPCSchema } from "electrobun/bun";

type Adapter = "sqlite" | "postgres" | "mysql";

const INTERNAL_SQLITE_ROWID = "__eb_rowid";
const INTERNAL_POSTGRES_CTID = "__eb_ctid";

const KEYCHAIN_SERVICE = "electrobun.onecode-db-explorer.connectionString";
const securityCmd = "/usr/bin/security";
const textDecoder = new TextDecoder();

function runSecurity(args: string[]) {
  const proc = Bun.spawnSync([securityCmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = textDecoder.decode(proc.stdout).trimEnd();
  const stderr = textDecoder.decode(proc.stderr).trimEnd();

  if (proc.exitCode !== 0) {
    throw new Error(stderr || stdout || `security exited with code ${proc.exitCode}`);
  }

  return stdout;
}

function isMissingKeychainItem(message: string) {
  const lower = message.toLowerCase();
  return lower.includes("could not be found") || lower.includes("errsecitemnotfound");
}

function keychainSetSecret(service: string, account: string, secret: string) {
  if (process.platform !== "darwin") {
    throw new Error("OS keychain support is only implemented on macOS for now.");
  }

  // NOTE: security(1) requires the password as a CLI argument. This is a stopgap until we wire
  // a native keychain bridge directly into Electrobun.
  runSecurity(["add-generic-password", "-a", account, "-s", service, "-w", secret, "-U"]);
}

function keychainGetSecret(service: string, account: string) {
  if (process.platform !== "darwin") return null;

  try {
    return runSecurity(["find-generic-password", "-a", account, "-s", service, "-w"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingKeychainItem(message)) return null;
    throw error;
  }
}

function keychainDeleteSecret(service: string, account: string) {
  if (process.platform !== "darwin") return;

  try {
    runSecurity(["delete-generic-password", "-a", account, "-s", service]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingKeychainItem(message)) return;
    throw error;
  }
}

export type ColumnInfo = {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
  ordinal: number;
};

export type RelationshipInfo = {
  constraintName: string | null;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
};

export type TableInfo = {
  name: string;
  columns: ColumnInfo[];
};

export type DbExplorerRPC = {
  bun: RPCSchema<{
    requests: {
      getBootInfo: {
        params: {};
        response:
          | {
              ok: true;
              profileId: string | null;
              mode: "main" | "connections" | "devtools";
              action: "new" | null;
            }
          | { ok: false; error: string };
      };
      setProfileConnectionString: {
        params: { profileId: string; connectionString: string };
        response: { ok: true } | { ok: false; error: string };
      };
      getProfileConnectionString: {
        params: { profileId: string };
        response: { ok: true; connectionString: string } | { ok: false; error: string };
      };
      deleteProfileConnectionString: {
        params: { profileId: string };
        response: { ok: true } | { ok: false; error: string };
      };
      connect: {
        params: { connectionString: string };
        response: { ok: true; adapter: Adapter } | { ok: false; error: string };
      };
      listTables: {
        params: { connectionString: string };
        response: { ok: true; tables: string[] } | { ok: false; error: string };
      };
      openWindow: {
        params: { profileId?: string | null; title?: string; frame?: { width: number; height: number } };
        response: { ok: true; windowId: number } | { ok: false; error: string };
      };
      openConnectionsWindow: {
        params: { action?: "new" };
        response: { ok: true; windowId: number } | { ok: false; error: string };
      };
      openDevtoolsWindow: {
        params: {};
        response: { ok: true; windowId: number } | { ok: false; error: string };
      };
      getSchemaGraph: {
        params: { connectionString: string };
        response:
          | { ok: true; adapter: Adapter; tables: TableInfo[]; relationships: RelationshipInfo[] }
          | { ok: false; error: string };
      };
      describeTable: {
        params: { connectionString: string; table: string };
        response: { ok: true; table: string; columns: ColumnInfo[] } | { ok: false; error: string };
      };
      runQuery: {
        params: { connectionString: string; query: string; queryId?: string };
        response:
          | {
              ok: true;
              command: string;
              count: number;
              lastInsertRowid: number | null;
              elapsedMs: number;
              columns: string[];
              rows: Record<string, unknown>[];
            }
          | { ok: false; error: string; elapsedMs: number };
      };
      cancelQuery: {
        params: { queryId: string };
        response: { ok: true } | { ok: false; error: string };
      };
      queryTableRows: {
        params: {
          connectionString: string;
          table: string;
          startRow: number;
          endRow: number;
          where?: string;
          sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
          filterModel?: unknown;
        };
        response: { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string };
      };
      updateCell: {
        params: {
          connectionString: string;
          table: string;
          primaryKey: Record<string, unknown>;
          column: string;
          value: unknown;
          valueEncoding?: "base64";
        };
        response: { ok: true; affectedRows: number } | { ok: false; error: string };
      };
      insertRow: {
        params: {
          connectionString: string;
          table: string;
          values: Record<string, unknown>;
        };
        response:
          | { ok: true; affectedRows: number; lastInsertRowid: number | null }
          | { ok: false; error: string };
      };
      deleteRows: {
        params: {
          connectionString: string;
          table: string;
          primaryKeys: Array<Record<string, unknown>>;
        };
        response: { ok: true; affectedRows: number } | { ok: false; error: string };
      };
      pickSqliteFile: {
        params: {};
        response: { ok: true; path: string | null } | { ok: false; error: string };
      };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      log: { level: "info" | "error"; message: string };
    };
  }>;
};

function detectAdapter(connectionString: string): Adapter {
  const value = connectionString.trim();

  if (
    value === ":memory:" ||
    value.startsWith("sqlite:") ||
    value.startsWith("file:") ||
    value.endsWith(".db") ||
    value.endsWith(".sqlite") ||
    value.endsWith(".sqlite3")
  ) {
    return "sqlite";
  }

  if (value.startsWith("mysql://") || value.startsWith("mysql2://")) return "mysql";

  return "postgres";
}

const clients = new Map<string, SQL>();
const runningQueries = new Map<
  string,
  {
    query: ReturnType<InstanceType<typeof SQL>["unsafe"]>;
    startedAt: number;
  }
>();
const sqliteRowidCache = new Map<string, Map<string, boolean>>();

function getClient(connectionString: string): SQL {
  const existing = clients.get(connectionString);
  if (existing) return existing;
  const created = new SQL(connectionString);
  clients.set(connectionString, created);
  return created;
}

function redactConnectionStringForLog(connectionString: string) {
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

function quoteIdentifier(adapter: Adapter, identifier: string) {
  if (adapter === "mysql") return `\`${identifier.replaceAll("`", "``")}\``;
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteQualified(adapter: Adapter, qualifiedName: string) {
  return qualifiedName
    .split(".")
    .filter((p) => p.length > 0)
    .map((p) => quoteIdentifier(adapter, p))
    .join(".");
}

function splitSchemaTable(qualifiedName: string): { schema: string | null; table: string } {
  const trimmed = qualifiedName.trim();
  const idx = trimmed.indexOf(".");
  if (idx === -1) return { schema: null, table: trimmed };
  return { schema: trimmed.slice(0, idx), table: trimmed.slice(idx + 1) };
}

function numberOrZero(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectProp(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" && typeof value !== "function") return undefined;
  return (value as Record<string, unknown>)[key];
}

function toStringOrEmpty(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  const message = objectProp(error, "message");
  if (typeof message === "string" && message.trim()) return message;
  return String(error);
}

function affectedRowsFromResult(result: unknown) {
  return numberOrZero(objectProp(result, "affectedRows") ?? objectProp(result, "count"));
}

function lastInsertRowidFromResult(result: unknown): number | null {
  const raw = objectProp(result, "lastInsertRowid");
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function commandFromResult(result: unknown) {
  const raw = objectProp(result, "command");
  if (typeof raw === "string" && raw.trim()) return raw;
  return String(raw ?? "UNKNOWN");
}

function countFromResult(result: unknown, fallback: number) {
  const raw = objectProp(result, "count");
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

async function sqliteTableHasRowid(connectionString: string, tableName: string): Promise<boolean> {
  const cached = sqliteRowidCache.get(connectionString);
  if (cached?.has(tableName)) return cached.get(tableName)!;

  const client = getClient(connectionString);
  const { schema, table } = splitSchemaTable(tableName);
  const sqliteMaster = schema ? `${quoteIdentifier("sqlite", schema)}.sqlite_master` : "sqlite_master";

  let hasRowid = true;
  try {
    const rows = await client.unsafe(
      `SELECT sql FROM ${sqliteMaster} WHERE type = 'table' AND name = $1 LIMIT 1;`,
      [table]
    );
    const sql = toStringOrEmpty(Array.isArray(rows) ? objectProp(rows[0], "sql") : undefined).toUpperCase();
    if (sql && sql.includes("WITHOUT ROWID")) hasRowid = false;
  } catch {
    hasRowid = true;
  }

  const map = cached ?? new Map<string, boolean>();
  map.set(tableName, hasRowid);
  if (!cached) sqliteRowidCache.set(connectionString, map);

  return hasRowid;
}

function resolveRowIdentityColumn(adapter: Adapter, column: string) {
  if (adapter === "sqlite" && column === INTERNAL_SQLITE_ROWID) return "_rowid_";
  if (adapter === "postgres" && column === INTERNAL_POSTGRES_CTID) return "ctid";
  return quoteIdentifier(adapter, column);
}

function buildAgGridFilterClause(args: {
  adapter: Adapter;
  filterModel: unknown;
  addParam: (value: unknown) => string;
}) {
  if (!isPlainObject(args.filterModel)) return null;

  const parts: string[] = [];
  for (const [field, model] of Object.entries(args.filterModel)) {
    const clause = buildAgGridColumnFilterClause(args.adapter, field, model, args.addParam);
    if (clause) parts.push(clause);
  }

  if (parts.length === 0) return null;
  return parts.map((p) => `(${p})`).join(" AND ");
}

function buildAgGridColumnFilterClause(
  adapter: Adapter,
  field: string,
  model: unknown,
  addParam: (value: unknown) => string
): string | null {
  if (!isPlainObject(model)) return null;
  if (!field.trim() || field.includes(".")) return null;

  const operator = typeof model.operator === "string" ? model.operator.toUpperCase() : null;
  if (operator && (model.condition1 || model.condition2)) {
    const c1 = buildAgGridColumnFilterClause(adapter, field, model.condition1, addParam);
    const c2 = buildAgGridColumnFilterClause(adapter, field, model.condition2, addParam);
    if (c1 && c2) return `(${c1} ${operator === "OR" ? "OR" : "AND"} ${c2})`;
    return c1 || c2;
  }

  const filterTypeRaw = model.filterType;
  const filterType = typeof filterTypeRaw === "string" ? filterTypeRaw : "";

  const col = quoteIdentifier(adapter, field);

  if (filterType === "set") {
    const values = Array.isArray(model.values) ? model.values.slice(0, 1000) : [];
    const nonNull = values.filter((v) => v !== null && v !== undefined);
    const hasNull = values.length !== nonNull.length;

    const placeholders = nonNull.map((v) => addParam(v));
    const inClause = placeholders.length ? `${col} IN (${placeholders.join(", ")})` : null;

    if (hasNull && inClause) return `(${col} IS NULL OR ${inClause})`;
    if (hasNull) return `${col} IS NULL`;
    return inClause;
  }

  if (filterType === "text" || filterType === "number" || filterType === "date") {
    const type = typeof model.type === "string" ? model.type : "";

    if (type === "blank") return `${col} IS NULL`;
    if (type === "notBlank") return `${col} IS NOT NULL`;

    if (filterType === "text") {
      const filterTextRaw = model.filter;
      const filterText = filterTextRaw === null || filterTextRaw === undefined ? "" : String(filterTextRaw);
      if (!filterText && type !== "equals" && type !== "notEqual") return null;

      const likeOp = adapter === "postgres" ? "ILIKE" : "LIKE";
      const lowerCol = `LOWER(${col})`;
      const equalsParam = addParam(filterText);

      switch (type) {
        case "equals":
          return `${lowerCol} = LOWER(${equalsParam})`;
        case "notEqual":
          return `${lowerCol} <> LOWER(${equalsParam})`;
        case "contains":
          return `${col} ${likeOp} ${addParam(`%${filterText}%`)}`;
        case "notContains":
          return `${col} NOT ${likeOp} ${addParam(`%${filterText}%`)}`;
        case "startsWith":
          return `${col} ${likeOp} ${addParam(`${filterText}%`)}`;
        case "endsWith":
          return `${col} ${likeOp} ${addParam(`%${filterText}`)}`;
        default:
          return null;
      }
    }

    if (filterType === "number") {
      const filterValue = Number(model.filter);
      const filterTo = Number(model.filterTo);

      const p = addParam(filterValue);
      switch (type) {
        case "equals":
          return `${col} = ${p}`;
        case "notEqual":
          return `${col} <> ${p}`;
        case "lessThan":
          return `${col} < ${p}`;
        case "lessThanOrEqual":
          return `${col} <= ${p}`;
        case "greaterThan":
          return `${col} > ${p}`;
        case "greaterThanOrEqual":
          return `${col} >= ${p}`;
        case "inRange":
          if (!Number.isFinite(filterTo)) return null;
          return `${col} BETWEEN ${p} AND ${addParam(filterTo)}`;
        default:
          return null;
      }
    }

    if (filterType === "date") {
      const from = typeof model.dateFrom === "string" ? model.dateFrom : null;
      const to = typeof model.dateTo === "string" ? model.dateTo : null;
      if (!from) return null;

      const p = addParam(from);
      switch (type) {
        case "equals":
          return `${col} = ${p}`;
        case "notEqual":
          return `${col} <> ${p}`;
        case "lessThan":
          return `${col} < ${p}`;
        case "greaterThan":
          return `${col} > ${p}`;
        case "inRange":
          if (!to) return null;
          return `${col} BETWEEN ${p} AND ${addParam(to)}`;
        default:
          return null;
      }
    }
  }

  return null;
}

async function ensureDemoSqliteDatabase(client: SQL) {
  // Create demo schema/data on demand so the app works out-of-the-box.
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      total_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );
  `);

  const existing = await client.unsafe(`SELECT COUNT(*) as count FROM customers;`);
  const count = Number(existing?.[0]?.count ?? 0);
  if (count > 0) return;

  await client.unsafe(`
    INSERT INTO customers (name, email, created_at) VALUES
      ('Ada Lovelace', 'ada@example.com', datetime('now', '-10 days')),
      ('Grace Hopper', 'grace@example.com', datetime('now', '-6 days')),
      ('Linus Torvalds', 'linus@example.com', datetime('now', '-3 days'));

    INSERT INTO orders (customer_id, total_cents, status, created_at) VALUES
      (1, 1299, 'paid',   datetime('now', '-9 days')),
      (1, 2599, 'paid',   datetime('now', '-8 days')),
      (2,  799, 'refund', datetime('now', '-5 days')),
      (3, 4999, 'paid',   datetime('now', '-2 days'));
  `);
}

async function listTablesFor(connectionString: string): Promise<string[]> {
  const adapter = detectAdapter(connectionString);
  const client = getClient(connectionString);

  if (adapter === "sqlite") {
    const rows = await client.unsafe(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name;
    `);
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => toStringOrEmpty(objectProp(r, "name"))).filter((name) => name !== "");
  }

  if (adapter === "mysql") {
    const rows = await client.unsafe(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ORDER BY table_schema, table_name;
    `);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => {
        const schema = toStringOrEmpty(objectProp(r, "table_schema"));
        const table = toStringOrEmpty(objectProp(r, "table_name"));
        return schema && table ? `${schema}.${table}` : "";
      })
      .filter((name) => name !== "");
  }

  const rows = await client.unsafe(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name;
  `);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => {
      const schema = toStringOrEmpty(objectProp(r, "table_schema"));
      const table = toStringOrEmpty(objectProp(r, "table_name"));
      return schema && table ? `${schema}.${table}` : "";
    })
    .filter((name) => name !== "");
}

async function describeTableFor(connectionString: string, tableName: string): Promise<ColumnInfo[]> {
  const adapter = detectAdapter(connectionString);
  const client = getClient(connectionString);

  if (adapter === "sqlite") {
    // PRAGMA functions don't support parameterized queries, so we use a quoted string literal
    const quotedTable = quoteIdentifier(adapter, tableName);
    const rows = await client.unsafe(`
      SELECT *
      FROM pragma_table_info(${quotedTable})
      ORDER BY cid;
    `);

    if (!Array.isArray(rows)) return [];
    return rows.flatMap((r) => {
      const name = toStringOrEmpty(objectProp(r, "name"));
      if (!name) return [];

      const type = toStringOrEmpty(objectProp(r, "type"));
      const notnull = objectProp(r, "notnull");
      const pk = objectProp(r, "pk");
      const dflt = objectProp(r, "dflt_value");
      const cid = objectProp(r, "cid");

      return [
        {
          name,
          type,
          nullable: Number(notnull ?? 0) === 0,
          primaryKey: Number(pk ?? 0) > 0,
          defaultValue: dflt === null || dflt === undefined ? null : String(dflt),
          ordinal: numberOrZero(cid),
        },
      ];
    });
  }

  const { schema, table } = splitSchemaTable(tableName);
  if (!schema || !table) return [];

  if (adapter === "mysql") {
    const rows = await client.unsafe(
      `
        SELECT
          column_name AS name,
          column_type AS type,
          is_nullable AS is_nullable,
          column_default AS column_default,
          column_key AS column_key,
          ordinal_position AS ordinal
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position;
      `,
      [schema, table]
    );

    if (!Array.isArray(rows)) return [];
    return rows.flatMap((r) => {
      const name = toStringOrEmpty(objectProp(r, "name"));
      if (!name) return [];

      const type = toStringOrEmpty(objectProp(r, "type"));
      const isNullable = toStringOrEmpty(objectProp(r, "is_nullable")).toUpperCase();
      const columnKey = toStringOrEmpty(objectProp(r, "column_key"));
      const def = objectProp(r, "column_default");
      const ordinal = objectProp(r, "ordinal");

      return [
        {
          name,
          type,
          nullable: isNullable === "YES",
          primaryKey: columnKey === "PRI",
          defaultValue: def === null || def === undefined ? null : String(def),
          ordinal: numberOrZero(ordinal),
        },
      ];
    });
  }

  const rows = await client.unsafe(
    `
      SELECT
        c.column_name AS name,
        COALESCE(c.udt_name, c.data_type) AS type,
        c.is_nullable AS is_nullable,
        c.column_default AS column_default,
        c.ordinal_position AS ordinal,
        CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END AS primary_key
      FROM information_schema.columns c
      LEFT JOIN information_schema.key_column_usage kcu
        ON kcu.table_schema = c.table_schema
       AND kcu.table_name = c.table_name
       AND kcu.column_name = c.column_name
      LEFT JOIN information_schema.table_constraints tc
        ON tc.table_schema = kcu.table_schema
       AND tc.table_name = kcu.table_name
       AND tc.constraint_name = kcu.constraint_name
       AND tc.constraint_type = 'PRIMARY KEY'
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position;
  `,
    [schema, table]
  );

  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const name = toStringOrEmpty(objectProp(r, "name"));
    if (!name) return [];

    const type = toStringOrEmpty(objectProp(r, "type"));
    const isNullable = toStringOrEmpty(objectProp(r, "is_nullable")).toUpperCase();
    const primaryKey = Boolean(objectProp(r, "primary_key"));
    const def = objectProp(r, "column_default");
    const ordinal = objectProp(r, "ordinal");

    return [
      {
        name,
        type,
        nullable: isNullable === "YES",
        primaryKey,
        defaultValue: def === null || def === undefined ? null : String(def),
        ordinal: numberOrZero(ordinal),
      },
    ];
  });
}

async function updateCellFor(args: {
  connectionString: string;
  table: string;
  primaryKey: Record<string, unknown>;
  column: string;
  value: unknown;
}) {
  const adapter = detectAdapter(args.connectionString);
  const client = getClient(args.connectionString);

  const pkEntries = Object.entries(args.primaryKey).filter(([k]) => k.trim().length > 0 && !k.includes("."));
  if (pkEntries.length === 0) throw new Error("Missing primary key values for update.");

  const where = pkEntries
    .map(([col], idx) => `${resolveRowIdentityColumn(adapter, col)} = $${idx + 2}`)
    .join(" AND ");

  const sql = `UPDATE ${quoteQualified(adapter, args.table)} SET ${quoteIdentifier(
    adapter,
    args.column
  )} = $1 WHERE ${where};`;

  const params = [args.value, ...pkEntries.map(([, v]) => v)];
  const result = await client.unsafe(sql, params);
  return affectedRowsFromResult(result);
}

async function insertRowFor(args: {
  connectionString: string;
  table: string;
  values: Record<string, unknown>;
}) {
  const adapter = detectAdapter(args.connectionString);
  const client = getClient(args.connectionString);

  const entries = Object.entries(args.values).filter(([k]) => k.trim().length > 0);
  if (entries.length === 0) {
    const sql =
      adapter === "mysql"
        ? `INSERT INTO ${quoteQualified(adapter, args.table)} () VALUES ();`
        : `INSERT INTO ${quoteQualified(adapter, args.table)} DEFAULT VALUES;`;
    const result = await client.unsafe(sql);
    return {
      affectedRows: affectedRowsFromResult(result),
      lastInsertRowid: lastInsertRowidFromResult(result),
    };
  }

  const columns = entries.map(([col]) => quoteIdentifier(adapter, col));
  const placeholders = entries.map((_, idx) => `$${idx + 1}`);
  const params = entries.map(([, value]) => value);

  const sql = `INSERT INTO ${quoteQualified(adapter, args.table)} (${columns.join(
    ", "
  )}) VALUES (${placeholders.join(", ")});`;
  const result = await client.unsafe(sql, params);
  return {
    affectedRows: affectedRowsFromResult(result),
    lastInsertRowid: lastInsertRowidFromResult(result),
  };
}

async function deleteRowsFor(args: {
  connectionString: string;
  table: string;
  primaryKeys: Array<Record<string, unknown>>;
}) {
  const adapter = detectAdapter(args.connectionString);
  const client = getClient(args.connectionString);

  if (args.primaryKeys.length === 0) return 0;

  let total = 0;
  for (const pk of args.primaryKeys) {
    const pkEntries = Object.entries(pk)
      .filter(([k]) => k.trim().length > 0 && !k.includes("."))
      .sort(([a], [b]) => a.localeCompare(b));
    if (pkEntries.length === 0) continue;

    const where = pkEntries
      .map(([col], idx) => `${resolveRowIdentityColumn(adapter, col)} = $${idx + 1}`)
      .join(" AND ");

    const sql = `DELETE FROM ${quoteQualified(adapter, args.table)} WHERE ${where};`;
    const params = pkEntries.map(([, v]) => v);
    const result = await client.unsafe(sql, params);
    total += affectedRowsFromResult(result);
  }

  return total;
}

async function listRelationshipsFor(connectionString: string): Promise<RelationshipInfo[]> {
  const adapter = detectAdapter(connectionString);
  const client = getClient(connectionString);

  if (adapter === "sqlite") {
    const tables = await listTablesFor(connectionString);
    const out: RelationshipInfo[] = [];

    for (const tableName of tables) {
      // PRAGMA functions don't support parameterized queries, so we use a quoted string literal
      const quotedTable = quoteIdentifier(adapter, tableName);
      const rows = await client.unsafe(`
        SELECT id, seq, "table" as to_table, "from" as from_column, "to" as to_column
        FROM pragma_foreign_key_list(${quotedTable})
        ORDER BY id, seq;
      `);

      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        const id = toStringOrEmpty(objectProp(r, "id"));
        const seq = toStringOrEmpty(objectProp(r, "seq"));
        out.push({
          constraintName: `fk_${tableName}_${id}_${seq}`,
          fromTable: tableName,
          fromColumn: toStringOrEmpty(objectProp(r, "from_column")),
          toTable: toStringOrEmpty(objectProp(r, "to_table")),
          toColumn: toStringOrEmpty(objectProp(r, "to_column")),
        });
      }
    }

    return out;
  }

  if (adapter === "mysql") {
    const rows = await client.unsafe(`
      SELECT
        constraint_name,
        table_schema,
        table_name,
        column_name,
        referenced_table_schema,
        referenced_table_name,
        referenced_column_name
      FROM information_schema.key_column_usage
      WHERE referenced_table_name IS NOT NULL
        AND table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ORDER BY table_schema, table_name, ordinal_position;
    `);

    if (!Array.isArray(rows)) return [];
    return rows.flatMap((r) => {
      const schema = toStringOrEmpty(objectProp(r, "table_schema"));
      const table = toStringOrEmpty(objectProp(r, "table_name"));
      const toSchema = toStringOrEmpty(objectProp(r, "referenced_table_schema"));
      const toTable = toStringOrEmpty(objectProp(r, "referenced_table_name"));
      const fromColumn = toStringOrEmpty(objectProp(r, "column_name"));
      const toColumn = toStringOrEmpty(objectProp(r, "referenced_column_name"));
      if (!schema || !table || !toSchema || !toTable || !fromColumn) return [];

      const constraintNameRaw = objectProp(r, "constraint_name");
      const constraintName = constraintNameRaw ? String(constraintNameRaw) : null;

      return [
        {
          constraintName,
          fromTable: `${schema}.${table}`,
          fromColumn,
          toTable: `${toSchema}.${toTable}`,
          toColumn,
        },
      ];
    });
  }

  const rows = await client.unsafe(`
    SELECT
      tc.constraint_name,
      tc.table_schema AS from_schema,
      tc.table_name AS from_table,
      kcu.column_name AS from_column,
      ccu.table_schema AS to_schema,
      ccu.table_name AS to_table,
      ccu.column_name AS to_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
     AND rc.constraint_schema = tc.table_schema
    JOIN information_schema.key_column_usage ccu
      ON ccu.constraint_name = rc.unique_constraint_name
     AND ccu.constraint_schema = rc.unique_constraint_schema
     AND ccu.ordinal_position = kcu.position_in_unique_constraint
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position;
  `);

  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const fromSchema = toStringOrEmpty(objectProp(r, "from_schema"));
    const fromTable = toStringOrEmpty(objectProp(r, "from_table"));
    const toSchema = toStringOrEmpty(objectProp(r, "to_schema"));
    const toTable = toStringOrEmpty(objectProp(r, "to_table"));
    const fromColumn = toStringOrEmpty(objectProp(r, "from_column"));
    const toColumn = toStringOrEmpty(objectProp(r, "to_column"));
    if (!fromSchema || !fromTable || !toSchema || !toTable || !fromColumn) return [];

    const constraintNameRaw = objectProp(r, "constraint_name");
    const constraintName = constraintNameRaw ? String(constraintNameRaw) : null;

    return [
      {
        constraintName,
        fromTable: `${fromSchema}.${fromTable}`,
        fromColumn,
        toTable: `${toSchema}.${toTable}`,
        toColumn,
      },
    ];
  });
}

async function mapLimit<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length) as R[];
  let nextIndex = 0;

  const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });

  await Promise.all(workers);
  return results;
}

async function getSchemaGraphFor(connectionString: string): Promise<{ adapter: Adapter; tables: TableInfo[]; relationships: RelationshipInfo[] }> {
  const adapter = detectAdapter(connectionString);
  const tableNames = await listTablesFor(connectionString);
  const tables = await mapLimit(tableNames, 8, async (name) => ({ name, columns: await describeTableFor(connectionString, name) }));
  const relationships = await listRelationshipsFor(connectionString);
  return { adapter, tables, relationships };
}

function buildWindowUrl() {
  return "views://mainview/index.html";
}

const windows = new Map<number, BrowserWindow>();
let nextWindowOffset = 0;

type WindowFrame = { width: number; height: number; x: number; y: number };

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function defaultWindowSize(mode: string | undefined) {
  if (mode === "connections") return { width: 980, height: 720 };
  if (mode === "devtools") return { width: 980, height: 720 };
  return { width: 1280, height: 820 };
}

function computeWindowFrame(options: { mode?: string; frame?: { width: number; height: number } }): WindowFrame {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };

  const padding = 48;
  const minWidth = 680;
  const minHeight = 520;

  const maxWidth = Math.max(minWidth, Math.floor(workArea.width - padding * 2));
  const maxHeight = Math.max(minHeight, Math.floor(workArea.height - padding * 2));

  const requested = options.frame && options.frame.width > 0 && options.frame.height > 0 ? options.frame : null;
  const base = requested ?? defaultWindowSize(options.mode);

  const width = clampNumber(Math.floor(base.width), minWidth, maxWidth);
  const height = clampNumber(Math.floor(base.height), minHeight, maxHeight);

  const offset = nextWindowOffset++ % 10;
  const baseX = Math.round(workArea.x + (workArea.width - width) / 2 + offset * 18);
  const baseY = Math.round(workArea.y + (workArea.height - height) / 2 + offset * 18);

  const minX = workArea.x + padding;
  const minY = workArea.y + padding;
  const maxX = workArea.x + workArea.width - width - padding;
  const maxY = workArea.y + workArea.height - height - padding;

  const x = clampNumber(baseX, minX, maxX);
  const y = clampNumber(baseY, minY, maxY);

  return { width, height, x, y };
}

function broadcastLog(level: "info" | "error", message: string) {
  for (const win of windows.values()) {
    win.webview?.rpc?.send("log", { level, message });
  }
}

function createAppWindow(
  options: {
    profileId?: string | null;
    title?: string;
    mode?: string;
    action?: string;
    frame?: { width: number; height: number };
  } = {}
): BrowserWindow {
  let window: BrowserWindow | null = null;
  const sendLog = (level: "info" | "error", message: string) => broadcastLog(level, message);

  const rpc: unknown = BrowserView.defineRPC<DbExplorerRPC>({
    maxRequestTime: 60_000,
    handlers: {
      requests: {
        getBootInfo: async () => {
          try {
            return {
              ok: true,
              profileId: options.profileId ?? null,
              mode:
                options.mode === "connections"
                  ? "connections"
                  : options.mode === "devtools"
                    ? "devtools"
                    : "main",
              action: options.action === "new" ? "new" : null,
            };
          } catch (error) {
            return { ok: false, error: errorMessage(error) };
          }
        },
        setProfileConnectionString: async ({ profileId, connectionString }) => {
          try {
            keychainSetSecret(KEYCHAIN_SERVICE, profileId, connectionString);
            return { ok: true };
          } catch (error) {
            return { ok: false, error: errorMessage(error) };
          }
        },
        getProfileConnectionString: async ({ profileId }) => {
          try {
            const secret = keychainGetSecret(KEYCHAIN_SERVICE, profileId);
            if (!secret) return { ok: false, error: "Connection string not found in OS keychain." };
            return { ok: true, connectionString: secret };
          } catch (error) {
            return { ok: false, error: errorMessage(error) };
          }
        },
        deleteProfileConnectionString: async ({ profileId }) => {
          try {
            keychainDeleteSecret(KEYCHAIN_SERVICE, profileId);
            return { ok: true };
          } catch (error) {
            return { ok: false, error: errorMessage(error) };
          }
        },
        connect: async ({ connectionString }) => {
          const adapter = detectAdapter(connectionString);
          try {
            const client = getClient(connectionString);

            if (adapter === "sqlite" && connectionString.trim() === ":memory:") {
              await ensureDemoSqliteDatabase(client);
            }

            // Force a connection attempt for network DBs (and validate SQLite too).
            await client.unsafe("SELECT 1 as ok;");

            sendLog("info", `Connected: ${adapter} (${redactConnectionStringForLog(connectionString)})`);
            return { ok: true, adapter };
          } catch (error) {
            const message = errorMessage(error);
            sendLog("error", `Connect failed: ${message}`);
            return { ok: false, error: message };
          }
        },
        listTables: async ({ connectionString }) => {
          try {
            const tables = await listTablesFor(connectionString);
            return { ok: true, tables };
          } catch (error) {
            return { ok: false, error: errorMessage(error) };
          }
        },
        openWindow: async ({ profileId, title, frame }) => {
          try {
            const created = createAppWindow({ profileId, title, frame });
            return { ok: true, windowId: created.id };
          } catch (error) {
            return { ok: false, error: errorMessage(error) };
          }
        },
        openConnectionsWindow: async ({ action }) => {
          try {
            const created = createAppWindow({
              title: "Connections — DB Explorer",
              mode: "connections",
              action,
            });
            return { ok: true, windowId: created.id };
          } catch (error) {
            return { ok: false, error: errorMessage(error) };
          }
        },
        openDevtoolsWindow: async () => {
          try {
            const created = createAppWindow({
              title: "Devtools — DB Explorer",
              mode: "devtools",
            });
            return { ok: true, windowId: created.id };
          } catch (error) {
            return { ok: false, error: errorMessage(error) };
          }
        },
        getSchemaGraph: async ({ connectionString }) => {
          try {
            const graph = await getSchemaGraphFor(connectionString);
            return { ok: true, ...graph };
          } catch (error) {
            return { ok: false, error: errorMessage(error) };
          }
        },
        describeTable: async ({ connectionString, table }) => {
          try {
            const columns = await describeTableFor(connectionString, table);
            return { ok: true, table, columns };
          } catch (error) {
            return { ok: false, error: errorMessage(error) };
          }
        },
        runQuery: async ({ connectionString, query, queryId }) => {
          const client = getClient(connectionString);
          const start = performance.now();

          try {
            let result: unknown;
            if (queryId) {
              const pending = client.unsafe(query);
              runningQueries.set(queryId, { query: pending, startedAt: Date.now() });
              try {
                result = await pending;
              } finally {
                runningQueries.delete(queryId);
              }
            } else {
              result = await client.unsafe(query);
            }
            const elapsedMs = performance.now() - start;

            const rows = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
            const firstRow = rows[0];
            const columns = firstRow ? Object.keys(firstRow) : [];

            const command = commandFromResult(result);
            const count = countFromResult(result, rows.length);
            const lastInsertRowid = lastInsertRowidFromResult(result);

            sendLog("info", `${command} (${Math.round(elapsedMs)}ms, count=${count})`);
            return {
              ok: true,
              command,
              count,
              lastInsertRowid,
              elapsedMs,
              columns,
              rows,
            };
          } catch (error) {
            const elapsedMs = performance.now() - start;
            const message = errorMessage(error);
            sendLog("error", `Query failed (${Math.round(elapsedMs)}ms): ${message}`);
            return { ok: false, error: message, elapsedMs };
          }
        },
        cancelQuery: async ({ queryId }) => {
          try {
            const running = runningQueries.get(queryId);
            if (!running) {
              return { ok: false, error: "Query already finished or not found." };
            }

            const cancel = (running.query as { cancel?: () => void }).cancel;
            if (typeof cancel !== "function") {
              return { ok: false, error: "Query cancellation not supported." };
            }

            cancel.call(running.query);
            runningQueries.delete(queryId);
            sendLog("info", "Query cancelled.");
            return { ok: true };
          } catch (error) {
            const message = errorMessage(error);
            sendLog("error", `Cancel failed: ${message}`);
            return { ok: false, error: message };
          }
        },
        queryTableRows: async ({ connectionString, table, startRow, endRow, where, sortModel, filterModel }) => {
          try {
            const adapter = detectAdapter(connectionString);
            const client = getClient(connectionString);

            const safeStart = Math.max(0, Math.trunc(Number(startRow) || 0));
            const safeEnd = Math.max(safeStart + 1, Math.trunc(Number(endRow) || safeStart + 1));
            const limit = Math.max(1, Math.min(1000, safeEnd - safeStart));
            const offset = safeStart;

            const params: unknown[] = [];
            const addParam = (value: unknown) => {
              params.push(value);
              return `$${params.length}`;
            };

            const whereParts: string[] = [];
            if (typeof where === "string" && where.trim()) {
              whereParts.push(`(${where.trim()})`);
            }

            const filterClause = buildAgGridFilterClause({ adapter, filterModel, addParam });
            if (filterClause) whereParts.push(filterClause);

            const whereSql = whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : "";

            const orderParts: string[] = [];
            if (Array.isArray(sortModel)) {
              for (const entry of sortModel) {
                const colId = entry && typeof entry.colId === "string" ? entry.colId.trim() : "";
                if (!colId || colId.includes(".")) continue;
                const dir = entry && entry.sort === "desc" ? "DESC" : "ASC";
                orderParts.push(`${quoteIdentifier(adapter, colId)} ${dir}`);
              }
            }
            const orderSql = orderParts.length ? ` ORDER BY ${orderParts.join(", ")}` : "";

            const limitParam = addParam(limit);
            const offsetParam = addParam(offset);

            const selectPrefix = await (async () => {
              if (adapter === "postgres") return `ctid AS ${quoteIdentifier(adapter, INTERNAL_POSTGRES_CTID)}, *`;
              if (adapter === "sqlite") {
                const hasRowid = await sqliteTableHasRowid(connectionString, table);
                if (hasRowid) return `_rowid_ AS ${quoteIdentifier(adapter, INTERNAL_SQLITE_ROWID)}, *`;
              }
              return "*";
            })();

            const sql = `SELECT ${selectPrefix} FROM ${quoteQualified(adapter, table)}${whereSql}${orderSql} LIMIT ${limitParam} OFFSET ${offsetParam};`;
            const rows = await client.unsafe(sql, params);
            return { ok: true, rows: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [] };
          } catch (error) {
            return { ok: false, error: errorMessage(error) };
          }
        },
        updateCell: async ({ connectionString, table, primaryKey, column, value, valueEncoding }) => {
          try {
            let decodedValue = value;
            if (valueEncoding === "base64") {
              if (decodedValue === null || decodedValue === undefined) {
                decodedValue = null;
              } else if (typeof decodedValue === "string") {
                decodedValue = Buffer.from(decodedValue, "base64");
              } else {
                throw new Error("Expected base64 string for blob update.");
              }
            }

            const affectedRows = await updateCellFor({
              connectionString,
              table,
              primaryKey,
              column,
              value: decodedValue,
            });
            sendLog("info", `Updated ${table}.${column} (${affectedRows} row(s))`);
            return { ok: true, affectedRows };
          } catch (error) {
            const message = errorMessage(error);
            sendLog("error", `Update failed: ${message}`);
            return { ok: false, error: message };
          }
        },
        insertRow: async ({ connectionString, table, values }) => {
          try {
            const result = await insertRowFor({ connectionString, table, values });
            sendLog("info", `Inserted row into ${table}`);
            return { ok: true, ...result };
          } catch (error) {
            const message = errorMessage(error);
            sendLog("error", `Insert failed: ${message}`);
            return { ok: false, error: message };
          }
        },
        deleteRows: async ({ connectionString, table, primaryKeys }) => {
          try {
            const affectedRows = await deleteRowsFor({ connectionString, table, primaryKeys });
            sendLog("info", `Deleted ${affectedRows} row(s) from ${table}`);
            return { ok: true, affectedRows };
          } catch (error) {
            const message = errorMessage(error);
            sendLog("error", `Delete failed: ${message}`);
            return { ok: false, error: message };
          }
        },
        pickSqliteFile: async () => {
          try {
            const chosen = await Utils.openFileDialog({
              startingFolder: Bun.env.HOME || "/",
              allowedFileTypes: "db,sqlite,sqlite3",
              canChooseFiles: true,
              canChooseDirectory: false,
              allowsMultipleSelection: false,
            });

            const path = chosen[0] && chosen[0] !== "" ? chosen[0] : null;
            return { ok: true, path };
          } catch (error) {
            return { ok: false, error: errorMessage(error) };
          }
        },
      },
      messages: {
        "*": (messageName: string, payload: unknown) => {
          console.log(`[webview message] ${messageName}`, payload);
        },
      },
    },
  });

  const frame = computeWindowFrame(options);
  window = new BrowserWindow({
    title: options.title || "1Code DB Explorer",
    url: buildWindowUrl(),
    frame: {
      width: frame.width,
      height: frame.height,
      x: frame.x,
      y: frame.y,
    },
    titleBarStyle: "hiddenInset",
    rpc,
  });

  windows.set(window.id, window);
  window.on("close", () => {
    windows.delete(window!.id);
    if (windows.size === 0) process.exit(0);
  });

  return window!;
}

createAppWindow();
console.log("1Code DB Explorer app started!");
