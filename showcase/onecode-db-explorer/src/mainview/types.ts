import type { RelationshipInfo, TableInfo } from "../bun/index";

export type LogEntry = {
  ts: number;
  level: "info" | "error";
  message: string;
};

export type QueryResult = {
  command: string;
  count: number;
  lastInsertRowid: number | null;
  elapsedMs: number;
  columns: string[];
  rows: Record<string, unknown>[];
};

export type SqlRun = {
  statement: string;
  result: QueryResult | null;
  error: string | null;
  elapsedMs: number;
};

export type SqlDocument = {
  id: string;
  title: string;
  query: string;
  runs: SqlRun[];
  activeRunIndex: number;
  lastRunAt: number | null;
  typeMap: Record<string, string>;
};

export type SqlPanelId = "editor" | "results";

export type SqlHistoryItem = {
  id: string;
  query: string;
  createdAt: number;
  profileId: string | null;
  profileName: string;
};

export type SqlSnippet = {
  id: string;
  name: string;
  query: string;
  createdAt: number;
  updatedAt: number;
};

export type TabId =
  | "dashboard"
  | "sql"
  | "graph"
  | "schema"
  | "logs"
  | "newTable"
  | `table:${string}`;

export type ConnectionProfile = {
  id: string;
  name: string;
  connectionStringDisplay: string;
  createdAt: number;
  updatedAt: number;
};

export type SchemaGraph = {
  adapter: string;
  tables: TableInfo[];
  relationships: RelationshipInfo[];
};

export type CommandItem = {
  id: string;
  name: string;
  description: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
};
