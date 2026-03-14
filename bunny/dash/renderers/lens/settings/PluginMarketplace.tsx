import {
  type JSXElement,
  For,
  Show,
  createSignal,
  createEffect,
  onMount,
} from "solid-js";
import { setState, openNewTabForNode } from "../store";
import { electrobun } from "../init";
import {
  SettingsPaneFormSection,
} from "./forms";

interface SearchResultItem {
  name: string;
  version: string;
  description?: string;
  author?: string;
  keywords?: string[];
  date: string;
  score: number;
  hasColabPlugin: boolean;
}

interface InstalledPlugin {
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  state: string;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
  isLocal?: boolean;
  localPath?: string;
}

interface EntitlementSummary {
  category: string;
  level: 'low' | 'medium' | 'high';
  icon: string;
  label: string;
  description: string;
}

export const PluginMarketplace = (): JSXElement => {
  const [searchResults, setSearchResults] = createSignal<SearchResultItem[]>([]);
  const [installedPlugins, setInstalledPlugins] = createSignal<InstalledPlugin[]>([]);
  const [pluginEntitlements, setPluginEntitlements] = createSignal<Record<string, EntitlementSummary[]>>({});
  const [expandedEntitlements, setExpandedEntitlements] = createSignal<string | null>(null);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [installing, setInstalling] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [activeTab, setActiveTab] = createSignal<"browse" | "installed">("browse");

  const loadInstalledPlugins = async () => {
    try {
      const plugins = await electrobun.rpc?.request.pluginGetInstalled();
      setInstalledPlugins(plugins || []);

      // Load entitlements for each plugin
      const entitlements: Record<string, EntitlementSummary[]> = {};
      for (const plugin of plugins || []) {
        try {
          const pluginEntitlements = await electrobun.rpc?.request.pluginGetEntitlements({ pluginName: plugin.name });
          if (pluginEntitlements && pluginEntitlements.length > 0) {
            entitlements[plugin.name] = pluginEntitlements;
          }
        } catch (e) {
          // Ignore individual plugin errors
        }
      }
      setPluginEntitlements(entitlements);
    } catch (err) {
      console.error("Failed to load installed plugins:", err);
    }
  };

  const searchPlugins = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await electrobun.rpc?.request.pluginSearch({
        query: searchQuery(),
        size: 50,
      });
      setSearchResults(result?.results || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to search plugins");
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    loadInstalledPlugins();
    searchPlugins();
  });

  // Debounced search
  createEffect(() => {
    const query = searchQuery();
    const timeoutId = setTimeout(() => {
      if (query !== searchQuery()) return;
      searchPlugins();
    }, 500);
    return () => clearTimeout(timeoutId);
  });

  const isInstalled = (name: string) => {
    return installedPlugins().some((p) => p.name === name);
  };

  const handleInstall = async (packageName: string) => {
    setInstalling(packageName);
    try {
      const result = await electrobun.rpc?.request.pluginInstall({ packageName });
      if (result?.ok) {
        await loadInstalledPlugins();
      } else {
        setError(result?.error || "Installation failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Installation failed");
    } finally {
      setInstalling(null);
    }
  };

  const handleUninstall = async (packageName: string) => {
    setInstalling(packageName);
    try {
      const result = await electrobun.rpc?.request.pluginUninstall({ packageName });
      if (result?.ok) {
        await loadInstalledPlugins();
      } else {
        setError(result?.error || "Uninstallation failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Uninstallation failed");
    } finally {
      setInstalling(null);
    }
  };

  const handleToggleEnabled = async (packageName: string, enabled: boolean) => {
    try {
      await electrobun.rpc?.request.pluginSetEnabled({ packageName, enabled });
      await loadInstalledPlugins();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update plugin");
    }
  };

  const handleInstallFromFolder = async () => {
    try {
      // Open folder picker dialog
      const folders = await electrobun.rpc?.request.openFileDialog({
        startingFolder: "",
        allowedFileTypes: "",
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      });

      if (!folders || folders.length === 0) {
        return; // User cancelled
      }

      const folderPath = folders[0];
      setInstalling(folderPath);

      // Install from the selected folder path
      const result = await electrobun.rpc?.request.pluginInstall({
        packageName: folderPath,
      });

      if (result?.ok) {
        await loadInstalledPlugins();
        setActiveTab("installed"); // Switch to installed tab to show the new plugin
      } else {
        setError(result?.error || "Installation failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to install from folder");
    } finally {
      setInstalling(null);
    }
  };

  const onCloseClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    setState("settingsPane", { type: "", data: {} });
  };

  return (
    <div
      style={{
        background: "#404040",
        color: "#d9d9d9",
        height: "100vh",
        overflow: "hidden",
        display: "flex",
        "flex-direction": "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          "flex-direction": "row",
          height: "45px",
          "font-size": "20px",
          "line-height": "45px",
          padding: "0 10px",
          "align-items": "center",
          "border-bottom": "1px solid #333",
        }}
      >
        <h1
          style={{
            "font-family": "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            "font-weight": "400",
            margin: "0",
            "font-size": "20px",
            "line-height": "1.34",
          }}
        >
          Plugins
        </h1>
        <div style={{ "flex-grow": "1" }} />
        <button
          type="button"
          onClick={onCloseClick}
          style={{
            "border-color": "rgb(54, 54, 54)",
            outline: "0px",
            cursor: "pointer",
            padding: "0px 12px",
            "font-size": "12px",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            height: "32px",
            "border-radius": "2px",
            color: "rgb(235, 235, 235)",
            background: "rgb(94, 94, 94)",
            "border-width": "1px",
            "border-style": "solid",
          }}
        >
          Close
        </button>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          "border-bottom": "1px solid #333",
          background: "#2b2b2b",
        }}
      >
        <button
          onClick={() => setActiveTab("browse")}
          style={{
            padding: "10px 20px",
            background: activeTab() === "browse" ? "#404040" : "transparent",
            border: "none",
            "border-bottom": activeTab() === "browse" ? "2px solid #0073e6" : "2px solid transparent",
            color: activeTab() === "browse" ? "#fff" : "#999",
            cursor: "pointer",
            "font-size": "12px",
          }}
        >
          Browse
        </button>
        <button
          onClick={() => setActiveTab("installed")}
          style={{
            padding: "10px 20px",
            background: activeTab() === "installed" ? "#404040" : "transparent",
            border: "none",
            "border-bottom": activeTab() === "installed" ? "2px solid #0073e6" : "2px solid transparent",
            color: activeTab() === "installed" ? "#fff" : "#999",
            cursor: "pointer",
            "font-size": "12px",
          }}
        >
          Installed ({installedPlugins().length})
        </button>
        <div style={{ "flex-grow": "1" }} />
        <button
          onClick={handleInstallFromFolder}
          disabled={installing() !== null}
          style={{
            padding: "6px 12px",
            margin: "6px 8px",
            background: "#0073e6",
            border: "none",
            "border-radius": "3px",
            color: "#fff",
            cursor: installing() !== null ? "wait" : "pointer",
            "font-size": "11px",
            opacity: installing() !== null ? 0.6 : 1,
          }}
        >
          Install from Folder...
        </button>
      </div>

      {/* Search (only on browse tab) */}
      <Show when={activeTab() === "browse"}>
        <div
          style={{
            padding: "12px",
            "border-bottom": "1px solid #333",
            background: "#2b2b2b",
          }}
        >
          <input
            type="text"
            placeholder="Search plugins..."
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            style={{
              width: "100%",
              background: "#1a1a1a",
              border: "1px solid #555",
              color: "#d9d9d9",
              padding: "8px 12px",
              "border-radius": "4px",
              "font-size": "12px",
              outline: "none",
            }}
          />
          <div
            style={{
              "margin-top": "8px",
              "font-size": "11px",
              color: "#888",
            }}
          >
            You can write and publish your own plugins.{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setState("settingsPane", { type: "", data: {} });
                openNewTabForNode("__COLAB_INTERNAL__/web", false, {
                  url: "https://blackboard.sh/colab/docs/plugins/overview/",
                  focusNewTab: true,
                });
              }}
              style={{
                color: "#6bb5ff",
                "text-decoration": "none",
              }}
            >
              Read the docs
            </a>
          </div>
        </div>
      </Show>

      {/* Error display */}
      <Show when={error()}>
        <div
          style={{
            padding: "12px",
            background: "#4a1a1a",
            color: "#ff6b6b",
            "font-size": "12px",
            display: "flex",
            "align-items": "center",
            gap: "8px",
          }}
        >
          <span>{error()}</span>
          <button
            onClick={() => setError(null)}
            style={{
              background: "transparent",
              border: "none",
              color: "#ff6b6b",
              cursor: "pointer",
              padding: "2px 6px",
            }}
          >
            x
          </button>
        </div>
      </Show>

      {/* Content */}
      <div style={{ flex: "1", "overflow-y": "auto" }}>
        <Show when={activeTab() === "browse"}>
          <Show when={loading()}>
            <div
              style={{
                padding: "40px",
                "text-align": "center",
                color: "#999",
                "font-size": "12px",
              }}
            >
              Searching plugins...
            </div>
          </Show>

          <Show when={!loading() && searchResults().length === 0}>
            <div
              style={{
                padding: "40px",
                "text-align": "center",
                color: "#999",
                "font-size": "12px",
              }}
            >
              <div style={{ "margin-bottom": "8px" }}>No plugins found</div>
              <div style={{ "font-size": "11px", color: "#666" }}>
                Plugins must have "colab-plugin" in their keywords
              </div>
            </div>
          </Show>

          <Show when={!loading() && searchResults().length > 0}>
            <For each={searchResults()}>
              {(ext) => (
                <div
                  style={{
                    padding: "12px 16px",
                    "border-bottom": "1px solid #2a2a2a",
                    display: "flex",
                    "flex-direction": "column",
                    gap: "6px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "8px",
                    }}
                  >
                    <div
                      style={{
                        "font-size": "13px",
                        "font-weight": "500",
                        color: "#d9d9d9",
                        flex: "1",
                      }}
                    >
                      {ext.name}
                    </div>
                    <span
                      style={{
                        "font-size": "10px",
                        color: "#666",
                        "margin-right": "8px",
                      }}
                    >
                      v{ext.version}
                    </span>
                    <Show when={isInstalled(ext.name)}>
                      <button
                        onClick={() => handleUninstall(ext.name)}
                        disabled={installing() === ext.name}
                        style={{
                          background: "#ff6b6b",
                          color: "white",
                          border: "none",
                          padding: "4px 12px",
                          "border-radius": "3px",
                          cursor: installing() === ext.name ? "wait" : "pointer",
                          "font-size": "11px",
                          opacity: installing() === ext.name ? 0.6 : 1,
                        }}
                      >
                        {installing() === ext.name ? "..." : "Remove"}
                      </button>
                    </Show>
                    <Show when={!isInstalled(ext.name)}>
                      <button
                        onClick={() => handleInstall(ext.name)}
                        disabled={installing() === ext.name}
                        style={{
                          background: "#0073e6",
                          color: "white",
                          border: "none",
                          padding: "4px 12px",
                          "border-radius": "3px",
                          cursor: installing() === ext.name ? "wait" : "pointer",
                          "font-size": "11px",
                          opacity: installing() === ext.name ? 0.6 : 1,
                        }}
                      >
                        {installing() === ext.name ? "Installing..." : "Install"}
                      </button>
                    </Show>
                  </div>
                  <Show when={ext.description}>
                    <div
                      style={{
                        "font-size": "11px",
                        color: "#999",
                        "line-height": "1.4",
                      }}
                    >
                      {ext.description}
                    </div>
                  </Show>
                  <div
                    style={{
                      display: "flex",
                      gap: "12px",
                      "font-size": "10px",
                      color: "#666",
                    }}
                  >
                    <Show when={ext.author}>
                      <span>by {ext.author}</span>
                    </Show>
                    <span>
                      {new Date(ext.date).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </Show>

        <Show when={activeTab() === "installed"}>
          <Show when={installedPlugins().length === 0}>
            <div
              style={{
                padding: "40px",
                "text-align": "center",
                color: "#999",
                "font-size": "12px",
              }}
            >
              <div style={{ "margin-bottom": "8px" }}>No plugins installed</div>
              <div style={{ "font-size": "11px", color: "#666" }}>
                Browse the marketplace to find and install plugins
              </div>
            </div>
          </Show>

          <For each={installedPlugins()}>
            {(plugin) => (
              <div
                style={{
                  padding: "12px 16px",
                  "border-bottom": "1px solid #2a2a2a",
                  display: "flex",
                  "flex-direction": "column",
                  gap: "8px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "8px",
                  }}
                >
                  <div
                    style={{
                      "font-size": "13px",
                      "font-weight": "500",
                      color: "#d9d9d9",
                      flex: "1",
                    }}
                  >
                    {plugin.displayName || plugin.name}
                  </div>
                  <Show when={plugin.isLocal}>
                    <span
                      style={{
                        "font-size": "10px",
                        padding: "2px 6px",
                        "border-radius": "3px",
                        background: "#1a2d3d",
                        color: "#6bb5ff",
                      }}
                    >
                      local
                    </span>
                  </Show>
                  <span
                    style={{
                      "font-size": "10px",
                      padding: "2px 6px",
                      "border-radius": "3px",
                      background: plugin.state === "active" ? "#1a3d1a" : "#3d3d1a",
                      color: plugin.state === "active" ? "#51cf66" : "#ffa500",
                    }}
                  >
                    {plugin.state}
                  </span>
                  <span
                    style={{
                      "font-size": "10px",
                      color: "#666",
                    }}
                  >
                    v{plugin.version}
                  </span>
                </div>
                <Show when={plugin.isLocal && plugin.localPath}>
                  <div
                    style={{
                      "font-size": "10px",
                      color: "#666",
                      "font-family": "monospace",
                      "word-break": "break-all",
                    }}
                  >
                    {plugin.localPath}
                  </div>
                </Show>
                <Show when={plugin.description}>
                  <div
                    style={{
                      "font-size": "11px",
                      color: "#999",
                      "line-height": "1.4",
                    }}
                  >
                    {plugin.description}
                  </div>
                </Show>
                {/* Entitlements summary */}
                <Show when={pluginEntitlements()[plugin.name]?.length > 0}>
                  <div
                    style={{
                      display: "flex",
                      "flex-wrap": "wrap",
                      gap: "6px",
                      "margin-top": "4px",
                    }}
                  >
                    <For each={pluginEntitlements()[plugin.name]?.slice(0, expandedEntitlements() === plugin.name ? undefined : 3)}>
                      {(ent) => (
                        <span
                          style={{
                            "font-size": "10px",
                            padding: "2px 6px",
                            "border-radius": "3px",
                            background: ent.level === 'high' ? '#3d2020' :
                                       ent.level === 'medium' ? '#3d3520' : '#203520',
                            color: ent.level === 'high' ? '#ff8080' :
                                   ent.level === 'medium' ? '#ffc080' : '#80ff80',
                            display: "flex",
                            "align-items": "center",
                            gap: "4px",
                          }}
                          title={ent.description}
                        >
                          <span>{ent.icon}</span>
                          {ent.label}
                        </span>
                      )}
                    </For>
                    <Show when={(pluginEntitlements()[plugin.name]?.length || 0) > 3}>
                      <button
                        onClick={() => setExpandedEntitlements(
                          expandedEntitlements() === plugin.name ? null : plugin.name
                        )}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "#0073e6",
                          "font-size": "10px",
                          cursor: "pointer",
                          padding: "2px 4px",
                        }}
                      >
                        {expandedEntitlements() === plugin.name
                          ? "show less"
                          : `+${(pluginEntitlements()[plugin.name]?.length || 0) - 3} more`}
                      </button>
                    </Show>
                  </div>
                </Show>

                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    "align-items": "center",
                    "margin-top": "4px",
                  }}
                >
                  <label
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "6px",
                      "font-size": "11px",
                      color: "#999",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={plugin.enabled}
                      onChange={(e) =>
                        handleToggleEnabled(plugin.name, e.currentTarget.checked)
                      }
                      style={{ cursor: "pointer" }}
                    />
                    Enabled
                  </label>
                  <div style={{ flex: "1" }} />
                  <button
                    onClick={() => setState("settingsPane", { type: "plugin-settings", data: { pluginName: plugin.name } })}
                    style={{
                      background: "transparent",
                      color: "#0073e6",
                      border: "1px solid #0073e6",
                      padding: "4px 12px",
                      "border-radius": "3px",
                      cursor: "pointer",
                      "font-size": "11px",
                    }}
                  >
                    Settings
                  </button>
                  <button
                    onClick={() => handleUninstall(plugin.name)}
                    disabled={installing() === plugin.name}
                    style={{
                      background: "transparent",
                      color: "#ff6b6b",
                      border: "1px solid #ff6b6b",
                      padding: "4px 12px",
                      "border-radius": "3px",
                      cursor: installing() === plugin.name ? "wait" : "pointer",
                      "font-size": "11px",
                      opacity: installing() === plugin.name ? 0.6 : 1,
                    }}
                  >
                    {installing() === plugin.name ? "..." : "Uninstall"}
                  </button>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};
