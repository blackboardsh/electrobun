import { For } from "solid-js";
import type { ConnectionProfile } from "../types";

type TitleBarProps = {
  title: string;
  subtitle: string;
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  onProfileSelect: (value: string) => void;
  onOpenConnections: (action?: "new") => void | Promise<void>;
  onOpenDevtools: () => void | Promise<void>;
  onOpenWindow: () => void | Promise<void>;
  onOpenPalette: () => void;
  onToggleTheme: () => void;
  theme: "light" | "dark";
  onConnect: () => void | Promise<void>;
  isConnecting: boolean;
  hasActiveProfile: boolean;
};

export default function TitleBar(props: TitleBarProps) {
  return (
    <div class="titlebar">
      <div class="brand">
        <div class="brand-title">{props.title}</div>
        <div class="brand-subtitle">{props.subtitle}</div>
      </div>

      <div class="toolbar">
        <button class="btn btn-secondary" onClick={() => void props.onOpenConnections()}>
          Connections
        </button>

        <select
          class="select"
          value={props.activeProfileId ?? ""}
          disabled={props.profiles.length === 0}
          onChange={(e) => props.onProfileSelect(e.currentTarget.value)}
          title="Active connection profile"
        >
          <For each={props.profiles}>
            {(profile) => <option value={profile.id}>{profile.name}</option>}
          </For>
          <option value="__manage__">Manage…</option>
          <option value="__new__">New connection…</option>
        </select>

        <button
          class="btn btn-ghost"
          onClick={() => void props.onOpenWindow()}
          disabled={!props.hasActiveProfile}
          title="Open this connection in a new window"
        >
          New window
        </button>

        <button class="btn btn-secondary" onClick={props.onOpenPalette} title="Cmd/Ctrl+K">
          Commands <span class="kbd">⌘K</span>
        </button>

        <button class="btn btn-ghost" onClick={() => void props.onOpenDevtools()} title="Open devtools window">
          Devtools
        </button>

        <button class="btn btn-ghost" onClick={props.onToggleTheme} title="Toggle theme">
          {props.theme === "dark" ? "Light" : "Dark"}
        </button>

        <button class="btn btn-primary" onClick={() => void props.onConnect()} disabled={props.isConnecting}>
          {props.isConnecting ? "Connecting…" : "Connect"}
        </button>
      </div>
    </div>
  );
}
