import { For, Show } from "solid-js";
import type { LogEntry } from "../types";

type LogsViewProps = {
  logs: LogEntry[];
};

export default function LogsView(props: LogsViewProps) {
  return (
    <div class="view logs-view">
      <div class="view-card">
        <div class="view-title">Recent logs</div>
        <div class="view-text">Latest activity from Bun + DB operations.</div>
      </div>

      <div class="logs-list">
        <Show when={props.logs.length > 0} fallback={<div class="pill">No logs yet.</div>}>
          <For each={props.logs}>
            {(entry) => (
              <div class={`log-item log-${entry.level}`}>
                <span class="log-time">{new Date(entry.ts).toLocaleTimeString()}</span>
                <span class="log-msg">{entry.message}</span>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
