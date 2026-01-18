import Dialog from "@corvu/dialog";

type EditConnectionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onNameChange: (next: string) => void;
  connectionString: string;
  onConnectionStringChange: (next: string) => void;
  onTest: () => void | Promise<void>;
  isTesting: boolean;
  testResult: null | { ok: boolean; message: string };
  onSave: () => void;
  isConnectionsWindow: boolean;
};

export default function EditConnectionDialog(props: EditConnectionDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="dialog-overlay" />
        <Dialog.Content class="dialog-content">
          <div class="connections">
            <div class="connections-header">
              <div class="connections-title">Edit Connection</div>
              <div class="connections-header-actions">
                <Dialog.Close class="btn btn-ghost" aria-label="close">
                  Close <span class="kbd">Esc</span>
                </Dialog.Close>
              </div>
            </div>

            <div class="connections-body">
              <div class="form">
                <label class="field">
                  <div class="field-label">Name</div>
                  <input
                    class="input"
                    value={props.name}
                    onInput={(e) => props.onNameChange(e.currentTarget.value)}
                  />
                </label>

                <label class="field">
                  <div class="field-label">Connection string</div>
                  <input
                    class="input"
                    value={props.connectionString}
                    onInput={(e) => props.onConnectionStringChange(e.currentTarget.value)}
                    spellcheck={false}
                  />
                </label>

                <div class="form-actions form-actions-between">
                  <div class="form-actions-left">
                    <button class="btn btn-secondary" onClick={() => void props.onTest()} disabled={props.isTesting}>
                      {props.isTesting ? "Testing…" : "Test"}
                    </button>
                    {props.testResult ? (
                      <div class={`pill ${props.testResult.ok ? "pill-success" : "pill-error"}`}>
                        {props.testResult.message}
                      </div>
                    ) : null}
                  </div>
                  <div class="form-actions-right">
                    <button class="btn btn-secondary" onClick={() => props.onOpenChange(false)}>
                      Cancel
                    </button>
                    <button class="btn btn-primary" onClick={props.onSave}>
                      {props.isConnectionsWindow ? "Save" : "Save & Connect"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
