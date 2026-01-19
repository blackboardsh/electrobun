import { For, Show, type JSX } from "solid-js";
import type { TabId } from "../types";

type TabBarProps = {
  staticTabs: Array<{ id: Exclude<TabId, `table:${string}`>; label: string }>;
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  openTables: string[];
  closeTable: (tableName: string) => void;
  showTableToolbar: boolean;
  tableToolbar?: JSX.Element;
};

export default function TabBar(props: TabBarProps) {
  return (
    <div class="tabbar">
      <div class="tabbar-tabs" role="tablist" aria-label="Views">
        <For each={props.staticTabs}>
          {(tab) => (
            <button class="tab" data-active={props.activeTab === tab.id ? "true" : "false"} onClick={() => props.setActiveTab(tab.id)}>
              {tab.label}
            </button>
          )}
        </For>

        <Show when={props.openTables.length > 0}>
          <div class="tab-sep" />
        </Show>

        <For each={props.openTables}>
          {(tableName) => {
            const tabId: TabId = `table:${tableName}`;
            return (
              <div
                class="tab tab-table"
                data-active={props.activeTab === tabId ? "true" : "false"}
                role="tab"
                tabindex={0}
                onClick={() => props.setActiveTab(tabId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.setActiveTab(tabId);
                  }
                }}
                title={tableName}
              >
                <span class="tab-label">{tableName}</span>
                <button
                  class="tab-close"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    props.closeTable(tableName);
                  }}
                  aria-label="Close tab"
                >
                  ×
                </button>
              </div>
            );
          }}
        </For>
      </div>

      <Show when={props.showTableToolbar && props.tableToolbar}>
        <div class="tabbar-toolbar">
          {props.tableToolbar}
        </div>
      </Show>
    </div>
  );
}
