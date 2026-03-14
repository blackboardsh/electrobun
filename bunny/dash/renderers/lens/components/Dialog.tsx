import { type Accessor, Show, onCleanup, createEffect } from "solid-js";

// Reusable Dialog Component
export const Dialog = ({
  isOpen,
  title,
  message,
  onConfirm,
  onCancel,
  confirmText = "Confirm",
  cancelText = "Cancel",
  type = "default",
}: {
  isOpen: Accessor<boolean>;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
  cancelText?: string;
  type?: "default" | "danger";
}) => {
  // Handle Escape key to close dialog, Enter key to confirm
  createEffect(() => {
    if (!isOpen()) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onConfirm();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  return (
    <Show when={isOpen()}>
    <div
      class="webview-overlay"
      style={{
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        "background-color": "rgba(0, 0, 0, 0.5)",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        "z-index": "10000",
      }}
      onClick={onCancel}
    >
      <div
        class="webview-overlay"
        style={{
          background: "#2d2d2d",
          border: "1px solid #454545",
          "border-radius": "6px",
          padding: "20px",
          "min-width": "300px",
          "max-width": "500px",
          "font-family": "'Segoe UI', system-ui, sans-serif",
          color: "#cccccc",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          style={{
            margin: "0 0 12px 0",
            "font-size": "16px",
            "font-weight": "600",
            color: type === "danger" ? "#f85149" : "#cccccc",
          }}
        >
          {title}
        </h3>
        <p
          style={{
            margin: "0 0 20px 0",
            "font-size": "14px",
            "line-height": "1.4",
            color: "#a3a3a3",
            "user-select": "text",
            cursor: "text",
            "white-space": "pre-wrap",
            "word-break": "break-word",
          }}
        >
          {message}
        </p>
        <div
          style={{
            display: "flex",
            gap: "8px",
            "justify-content": "flex-end",
          }}
        >
          <button
            onClick={onCancel}
            style={{
              background: "transparent",
              border: "1px solid #555",
              color: "#cccccc",
              "font-size": "12px",
              padding: "6px 12px",
              "border-radius": "4px",
              cursor: "pointer",
              "font-family": "'Segoe UI', system-ui, sans-serif",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#555")}
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            style={{
              background: type === "danger" ? "#da3633" : "#238636",
              border:
                "1px solid " + (type === "danger" ? "#f85149" : "#2ea043"),
              color: "#ffffff",
              "font-size": "12px",
              padding: "6px 12px",
              "border-radius": "4px",
              cursor: "pointer",
              "font-family": "'Segoe UI', system-ui, sans-serif",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background =
                type === "danger" ? "#b91c1c" : "#1f6333";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background =
                type === "danger" ? "#da3633" : "#238636";
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
    </Show>
  );
};
