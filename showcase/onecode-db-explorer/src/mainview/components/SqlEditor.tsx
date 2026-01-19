import { MySQL, PostgreSQL, StandardSQL, sql as sqlLang, type SQLNamespace } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import type { CompletionSource } from "@codemirror/autocomplete";
import { EditorView, minimalSetup } from "codemirror";
import { keymap, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { createEffect, onCleanup, onMount } from "solid-js";
import { getSqlStatementAtCursor, inferSqlAliasMap, resolveTableReference } from "../lib/app-helpers";

export type SqlEditorRunRequest =
  | { kind: "all" }
  | { kind: "selection"; query: string }
  | { kind: "statement"; query: string };

export type SqlEditorHandle = {
  runSelectionOrStatement: () => void;
  runAll: () => void;
  focus: () => void;
};

type SqlEditorProps = {
  value: string;
  onChange: (nextValue: string) => void;
  onRun?: (request: SqlEditorRunRequest) => void;
  placeholder?: string;
  readOnly?: boolean;
  dialect?: "postgres" | "mysql" | "sqlite";
  schema?: SQLNamespace;
  defaultSchema?: string;
  defaultTable?: string;
  knownTables?: string[];
  ensureTableSchema?: (tableName: string) => void | Promise<void>;
  setHandle?: (handle: SqlEditorHandle | null) => void;
};

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    width: "100%",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
  },
  ".cm-scroller": {
    overflow: "auto",
    backgroundColor: "hsl(var(--tl-background))",
  },
  ".cm-content": {
    padding: "10px 12px",
    caretColor: "hsl(var(--foreground))",
  },
  ".cm-gutters": {
    backgroundColor: "hsl(var(--tl-background))",
    color: "hsl(var(--muted-foreground))",
    borderRight: "1px solid hsl(var(--border))",
  },
  ".cm-activeLine": {
    backgroundColor: "hsl(var(--foreground) / 0.04)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "hsl(var(--foreground) / 0.03)",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "hsl(var(--selection))",
  },
  "&.cm-focused": {
    outline: "none",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "hsl(var(--selection))",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "hsl(var(--foreground))",
  },
  "&.cm-focused .cm-activeLine": {
    backgroundColor: "hsl(var(--foreground) / 0.04)",
  },
});

const onecodeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "hsl(var(--syntax-keyword))", fontWeight: "650" },
  { tag: tags.operator, color: "hsl(var(--syntax-operator))" },
  { tag: tags.punctuation, color: "hsl(var(--syntax-operator))" },
  { tag: [tags.name, tags.variableName, tags.propertyName], color: "hsl(var(--syntax-variable))" },
  { tag: tags.typeName, color: "hsl(var(--syntax-type))" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "hsl(var(--syntax-function))" },
  { tag: [tags.string, tags.special(tags.string)], color: "hsl(var(--syntax-string))" },
  { tag: [tags.number, tags.bool, tags.null], color: "hsl(var(--syntax-number))" },
  { tag: tags.comment, color: "hsl(var(--syntax-comment))", fontStyle: "italic" },
]);

const placeholderTheme = EditorView.theme({
  ".cm-placeholder": {
    color: "hsl(var(--muted-foreground) / 0.75)",
    fontStyle: "italic",
  },
});

export default function SqlEditor(props: SqlEditorProps) {
  let mountEl: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  let suppressExternalSync = false;
  const sqlCompartment = new Compartment();

  const lookupTableColumns = (schema: SQLNamespace | undefined, tableName: string) => {
    if (!schema) return null;

    const root = schema as unknown as Record<string, unknown>;
    if (tableName.includes(".")) {
      const [schemaName, unqualified] = tableName.split(".", 2);
      const schemaEntry = schemaName ? root[schemaName] : undefined;
      if (schemaEntry && typeof schemaEntry === "object" && !Array.isArray(schemaEntry)) {
        const cols = (schemaEntry as Record<string, unknown>)[unqualified ?? ""];
        if (Array.isArray(cols)) return cols.filter((c): c is string => typeof c === "string");
      }
    }

    const cols = root[tableName];
    if (Array.isArray(cols)) return cols.filter((c): c is string => typeof c === "string");
    return null;
  };

  const aliasCompletionSource: CompletionSource = async (context) => {
    const adapter = props.dialect ?? "";
    if (!adapter) return null;

    const word = context.matchBefore(/[A-Za-z_][\w$]*(?:\.(?:[A-Za-z_][\w$]*)?)?/);
    if (!word) return null;

    const dotIndex = word.text.lastIndexOf(".");
    if (dotIndex === -1) return null;

    const qualifier = word.text.slice(0, dotIndex);
    const knownTables = props.knownTables ?? [];
    if (!qualifier) return null;

    const queryText = context.state.doc.toString();
    const aliasMap = inferSqlAliasMap(queryText, knownTables, adapter);

    const resolved =
      aliasMap[qualifier] ?? resolveTableReference(qualifier, knownTables, adapter) ?? null;
    if (!resolved) return null;

    let cols = lookupTableColumns(props.schema, resolved);
    if ((!cols || cols.length === 0) && props.ensureTableSchema) {
      await props.ensureTableSchema(resolved);
      cols = lookupTableColumns(props.schema, resolved);
    }

    if (!cols || cols.length === 0) return null;

    const from = word.from + dotIndex + 1;
    return {
      from,
      options: cols.map((col) => ({ label: col, type: "property", detail: resolved })),
      validFor: /^[\w$]*$/,
    };
  };

  const getRunRequest = (): SqlEditorRunRequest => {
    if (!view) return { kind: "all" };

    const main = view.state.selection.main;
    if (main.from !== main.to) {
      const selected = view.state.sliceDoc(main.from, main.to).trim();
      if (selected) return { kind: "selection", query: selected };
    }

    const statement = getSqlStatementAtCursor(view.state.doc.toString(), main.head);
    if (statement) return { kind: "statement", query: statement };

    return { kind: "all" };
  };

  const runSelectionOrStatement = () => {
    props.onRun?.(getRunRequest());
  };

  const runAll = () => {
    props.onRun?.({ kind: "all" });
  };

  const runKeymap = keymap.of([
    {
      key: "Shift-Mod-Enter",
      run: () => {
        runAll();
        return true;
      },
    },
    {
      key: "Mod-Enter",
      run: () => {
        runSelectionOrStatement();
        return true;
      },
    },
  ]);

  const buildSqlExtension = () => {
    const dialect =
      props.dialect === "postgres" ? PostgreSQL : props.dialect === "mysql" ? MySQL : StandardSQL;

    return sqlLang({
      dialect,
      schema: props.schema,
      defaultSchema: props.defaultSchema,
      defaultTable: props.defaultTable,
      upperCaseKeywords: true,
    });
  };

  onMount(() => {
    if (!mountEl) return;

    const state = EditorState.create({
      doc: props.value,
      extensions: [
        minimalSetup,
        syntaxHighlighting(onecodeHighlightStyle, { fallback: true }),
        runKeymap,
        editorTheme,
        placeholderTheme,
        props.placeholder ? placeholder(props.placeholder) : [],
        sqlCompartment.of(buildSqlExtension()),
        EditorState.languageData.of(() => [{ autocomplete: aliasCompletionSource }]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const next = update.state.doc.toString();
          suppressExternalSync = true;
          props.onChange(next);
          queueMicrotask(() => {
            suppressExternalSync = false;
          });
        }),
        EditorState.readOnly.of(Boolean(props.readOnly)),
      ],
    });

    view = new EditorView({
      state,
      parent: mountEl,
    });

    props.setHandle?.({
      runSelectionOrStatement,
      runAll,
      focus: () => view?.focus(),
    });

    onCleanup(() => {
      props.setHandle?.(null);
      view?.destroy();
      view = undefined;
    });
  });

  createEffect(() => {
    if (suppressExternalSync) return;
    if (!view) return;

    const current = view.state.doc.toString();
    const next = props.value;
    if (current === next) return;

    view.dispatch({
      changes: { from: 0, to: current.length, insert: next },
    });
  });

  createEffect(() => {
    if (!view) return;

    view.dispatch({
      effects: sqlCompartment.reconfigure(buildSqlExtension()),
    });
  });

  return (
    <div class="sql-editor" data-readonly={props.readOnly ? "true" : "false"}>
      <div class="sql-editor-mount" ref={mountEl} />
    </div>
  );
}
