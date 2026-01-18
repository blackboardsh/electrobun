import Dialog from "@corvu/dialog";
import { For, Show, type Setter } from "solid-js";
import type { CommandItem } from "../types";

type CommandPaletteDialogProps = {
  open: boolean;
  setOpen: Setter<boolean>;
  filter: string;
  setFilter: Setter<string>;
  filteredCommands: CommandItem[];
  setInputEl: (el: HTMLInputElement | undefined) => void;
};

export default function CommandPaletteDialog(props: CommandPaletteDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay class="dialog-overlay" />
        <Dialog.Content class="dialog-content">
          <div class="palette">
            <div class="palette-header">
              <div class="palette-title">Commands</div>
              <Dialog.Close class="btn btn-ghost" aria-label="close">
                Close <span class="kbd">Esc</span>
              </Dialog.Close>
            </div>
            <div class="palette-body">
              <input
                ref={(el) => props.setInputEl(el)}
                class="input"
                value={props.filter}
                onInput={(e) => props.setFilter(e.currentTarget.value)}
                placeholder="Type a command…"
                spellcheck={false}
              />
              <div class="palette-list">
                <For each={props.filteredCommands}>
                  {(cmd) => (
                    <button class="command" disabled={cmd.disabled} onClick={() => void cmd.run()}>
                      <div class="command-left">
                        <div class="command-name">{cmd.name}</div>
                        <div class="command-desc">{cmd.description}</div>
                      </div>
                      <Show when={cmd.shortcut}>
                        <span class="kbd">{cmd.shortcut}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
