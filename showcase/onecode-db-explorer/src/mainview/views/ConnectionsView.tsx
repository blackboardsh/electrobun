import Dialog from "@corvu/dialog";
import { For, Show, type JSX, type Setter } from "solid-js";
import type { ConnectionProfile } from "../types";

type ConnectionsViewProps = {
  filteredProfiles: ConnectionProfile[];
  activeProfileId: string | null;
  setActiveProfileId: (next: string | null) => void;
  selectedProfile: ConnectionProfile | null;
  openWindowForProfile: (profile: ConnectionProfile) => void | Promise<void>;
  startEditProfile: (profile: ConnectionProfile) => void;
  deleteProfile: (id: string) => void | Promise<void>;
  startCreateProfile: () => void;
  connectionsSearch: string;
  setConnectionsSearch: Setter<string>;
  connectionsMenuOpen: boolean;
  setConnectionsMenuOpen: Setter<boolean>;
  setConnectionsMenuButtonEl: (el: HTMLButtonElement | undefined) => void;
  setConnectionsMenuEl: (el: HTMLDivElement | undefined) => void;
  importOpen: boolean;
  setImportOpen: Setter<boolean>;
  importConn: string;
  setImportConn: Setter<string>;
  importError: string | null;
  setImportError: Setter<string | null>;
  importConnectionFromUrl: () => void;
  pickSqliteFile: () => void | Promise<void>;
  editDialog: JSX.Element;
};

export default function ConnectionsView(props: ConnectionsViewProps) {
  return (
    <div class="app connections-app">
      <div class="connections-shell">
        <div class="connections-sidebar">
          <div class="connections-sidebar-top">
            <div class="connections-sidebar-actions">
              <button class="btn btn-secondary" onClick={props.startCreateProfile}>
                New Connection
              </button>
              <div class="menu-anchor">
                <button
                  ref={(el) => {
                    props.setConnectionsMenuButtonEl(el);
                  }}
                  class="btn btn-ghost btn-icon"
                  onClick={() => props.setConnectionsMenuOpen((open) => !open)}
                  aria-label="More"
                >
                  ⋯
                </button>
                <Show when={props.connectionsMenuOpen}>
                  <div
                    class="menu"
                    ref={(el) => {
                      props.setConnectionsMenuEl(el);
                    }}
                  >
                    <button
                      class="menu-item"
                      onClick={() => {
                        props.setConnectionsMenuOpen(false);
                        props.setImportOpen(true);
                      }}
                    >
                      Import from URL…
                    </button>
                    <button
                      class="menu-item"
                      onClick={() => {
                        props.setConnectionsMenuOpen(false);
                        void props.pickSqliteFile();
                      }}
                    >
                      Open SQLite…
                    </button>
                  </div>
                </Show>
              </div>
            </div>

            <input
              class="input input-compact connections-search"
              value={props.connectionsSearch}
              onInput={(e) => props.setConnectionsSearch(e.currentTarget.value)}
              placeholder="Search…"
              spellcheck={false}
            />
          </div>

          <div class="connections-list">
            <Show
              when={props.filteredProfiles.length > 0}
              fallback={<div class="connections-empty">No connections.</div>}
            >
              <For each={props.filteredProfiles}>
                {(profile) => (
                  <button
                    class="connections-item"
                    data-active={props.activeProfileId === profile.id ? "true" : "false"}
                    onClick={() => props.setActiveProfileId(profile.id)}
                  >
                    <div class="connections-item-name">{profile.name}</div>
                    <div class="connections-item-conn">{profile.connectionStringDisplay}</div>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>

        <div class="connections-main">
          <Show
            when={props.selectedProfile}
            fallback={
              <div class="connections-empty-state">
                <div class="connections-empty-title">No connection selected</div>
                <div class="connections-empty-subtitle">Create or pick a profile to open a window.</div>
              </div>
            }
          >
            {(profile) => (
              <div class="connections-detail">
                <div class="connections-detail-title">{profile().name}</div>
                <div class="connections-detail-conn">{profile().connectionStringDisplay}</div>
                <div class="connections-detail-actions">
                  <button class="btn btn-primary" onClick={() => void props.openWindowForProfile(profile())}>
                    Open Window
                  </button>
                  <button class="btn btn-secondary" onClick={() => props.startEditProfile(profile())}>
                    Edit
                  </button>
                  <button class="btn btn-ghost btn-danger" onClick={() => void props.deleteProfile(profile().id)}>
                    Delete
                  </button>
                </div>
              </div>
            )}
          </Show>
        </div>
      </div>

      {props.editDialog}

      <Dialog
        open={props.importOpen}
        onOpenChange={(open) => {
          props.setImportOpen(open);
          if (!open) {
            props.setImportConn("");
            props.setImportError(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <div class="import-dialog">
              <div class="import-header">
                <div class="import-title">Import from URL</div>
                <Dialog.Close class="btn btn-ghost" aria-label="close">
                  Close <span class="kbd">Esc</span>
                </Dialog.Close>
              </div>
              <div class="import-body">
                <input
                  class="input import-input"
                  value={props.importConn}
                  onInput={(e) => props.setImportConn(e.currentTarget.value)}
                  placeholder="postgresql://user@localhost:5432/db"
                  spellcheck={false}
                />
                <Show when={props.importError}>
                  <div class="pill pill-error">{props.importError}</div>
                </Show>
                <button class="btn btn-primary" onClick={props.importConnectionFromUrl}>
                  Import
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}
