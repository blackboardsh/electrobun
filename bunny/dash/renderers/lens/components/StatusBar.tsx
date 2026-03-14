import { getWindow } from "../store";
import { state, setState } from "../store";
import { createSignal, onMount, For } from "solid-js";
import { aiCompletionService } from "../services/aiCompletionService";
import { electrobun } from "../init";

// Type for status bar items from plugins
interface PluginStatusBarItem {
  id: string;
  text: string;
  tooltip?: string;
  color?: string;
  priority?: number;
  alignment?: 'left' | 'right';
  pluginName: string;
  hasSettings: boolean;
}

export const StatusBar = () => {
  const [pluginItems, setPluginItems] = createSignal<PluginStatusBarItem[]>([]);

  // Fetch plugin status bar items periodically
  onMount(() => {
    const fetchPluginItems = async () => {
      try {
        const items = await electrobun.rpc?.request.pluginGetStatusBarItems();
        if (items) {
          setPluginItems(items);
        }
      } catch (err) {
        console.warn('Failed to fetch plugin status bar items:', err);
      }
    };

    fetchPluginItems();
    const interval = setInterval(fetchPluginItems, 2000); // Refresh every 2 seconds
    return () => clearInterval(interval);
  });

  const leftPluginItems = () => pluginItems()
    .filter(item => item.alignment === 'left')
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  const rightPluginItems = () => pluginItems()
    .filter(item => item.alignment !== 'left')
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  return (
    <div
      style={{
        display: "flex",
        height: "22px",
        width: "100%",
        background: "#181818",
        "border-top": "1px solid #111",
        color: "#fff",
        "font-size": "11px",
        "align-items": "center",
        padding: "10px",
        "box-sizing": "border-box",
      }}
    >
      <div style={{ display: "flex", height: "18px", "align-items": "center" }}>
        <Workspace />
        <For each={leftPluginItems()}>
          {(item) => (
            <>
              <span>|</span>
              <div
                style={{
                  margin: "0 5px",
                  color: item.color || "#999",
                  cursor: item.hasSettings ? "pointer" : "default",
                }}
                title={item.hasSettings ? `${item.tooltip || item.text} (click to configure)` : item.tooltip}
                onClick={() => {
                  if (item.hasSettings) {
                    // Toggle: close if already open for this plugin, otherwise open
                    const currentData = state.settingsPane.data as { pluginName?: string } | undefined;
                    if (state.settingsPane.type === "plugin-settings" && currentData?.pluginName === item.pluginName) {
                      setState("settingsPane", { type: "", data: {} });
                    } else {
                      setState("settingsPane", { type: "plugin-settings", data: { pluginName: item.pluginName } });
                    }
                  }
                }}
              >
                {item.text}
              </div>
            </>
          )}
        </For>
      </div>
      <div style={{ "flex-grow": 1 }} />
      <div style={{ display: "flex", height: "18px", "align-items": "center" }}>
        <For each={rightPluginItems()}>
          {(item) => (
            <>
              <div
                style={{
                  margin: "0 5px",
                  color: item.color || "#999",
                  cursor: item.hasSettings ? "pointer" : "default",
                }}
                title={item.hasSettings ? `${item.tooltip || item.text} (click to configure)` : item.tooltip}
                onClick={() => {
                  if (item.hasSettings) {
                    // Toggle: close if already open for this plugin, otherwise open
                    const currentData = state.settingsPane.data as { pluginName?: string } | undefined;
                    if (state.settingsPane.type === "plugin-settings" && currentData?.pluginName === item.pluginName) {
                      setState("settingsPane", { type: "", data: {} });
                    } else {
                      setState("settingsPane", { type: "plugin-settings", data: { pluginName: item.pluginName } });
                    }
                  }
                }}
              >
                {item.text}
              </div>
              <span>|</span>
            </>
          )}
        </For>
        <Git />
        <span>|</span>
        <Bun />
        <span>|</span>
        <Biome />
        <span>|</span>
        <Typescript />
        <span>|</span>
        <Llama />
        <span>|</span>
        <GitHub />
        <span>|</span>
        <ColabCloud />
        <span>|</span>
        <Plugins />
        <AnalyticsConsent />
        <span>|</span>
        <Colab />
      </div>
    </div>
  );
};

const Colab = () => {
  const channelText = () =>
    state.buildVars.channel === "stable" ? "" : `-${state.buildVars.channel}`;
  return (
    <div style={{ margin: "0 5px" }}>
      co(lab){channelText()} v{state.buildVars.version} - {state.buildVars.hash}
    </div>
  );
};

const Bun = () => {
  return (
    <div style={{ margin: "0 5px" }}>
      Bun v{state.peerDependencies.bun.version}
    </div>
  );
};

const Typescript = () => {
  return (
    <div style={{ margin: "0 5px" }}>
      Typescript v{state.peerDependencies.typescript.version}
    </div>
  );
};

const Biome = () => {
  return (
    <div style={{ margin: "0 5px" }}>
      Biome v{state.peerDependencies.biome.version}
    </div>
  );
};

const Git = () => {
  return (
    <div style={{ margin: "0 5px" }}>
      Git v{state.peerDependencies.git.version}
    </div>
  );
};

const Homebrew = () => {
  return (
    <div style={{ margin: "0 5px" }}>
      Homebrew
    </div>
  );
};

const Workspace = () => {
  const getTotalTabs = () => {
    return Object.keys(getWindow()?.tabs || {}).length;
  };

  return (
    <div style={{ margin: "0 5px" }}>
      win: {state.workspace.windows.length} | tabs: {getTotalTabs()}
    </div>
  );
};

const Llama = () => {
  const [llamaStatus, setLlamaStatus] = createSignal<{
    version: string | null;
    isRunning: boolean;
    isInstalled: boolean;
    isPending: boolean;
    modelAvailable: boolean;
    modelCount: number;
  }>({
    version: "bundled",
    isRunning: true, // Bundled with app
    isInstalled: true, // Bundled with app
    isPending: false,
    modelAvailable: false,
    modelCount: 0,
  });

  const checkLlamaStatus = async () => {
    try {
      // Check available models via our new RPC
      const result = await (electrobun.rpc as any)?.request.llamaListModels();
      if (result?.ok) {
        const modelCount = result.models.length;
        const modelAvailable = modelCount > 0;
        
        setLlamaStatus({
          version: "bundled",
          isRunning: true,
          isInstalled: true,
          isPending: false,
          modelAvailable,
          modelCount,
        });
      } else {
        console.log("StatusBar: RPC returned ok=false:", result);
        setLlamaStatus({
          version: "bundled",
          isRunning: true,
          isInstalled: true,
          isPending: false,
          modelAvailable: false,
          modelCount: 0,
        });
      }
    } catch (error) {
      console.error("StatusBar: Error calling llamaListModels:", error);
      setLlamaStatus({
        version: "bundled",
        isRunning: true,
        isInstalled: true,
        isPending: false,
        modelAvailable: false,
        modelCount: 0,
      });
    }
  };

  const handleLlamaClick = async () => {
    if (state.settingsPane.type === "llama-settings") {
      setState("settingsPane", { type: "", data: {} });
    } else {
      setState("settingsPane", { type: "llama-settings", data: {} });
    }
  };

  // Check status on mount and periodically
  onMount(() => {
    console.log("StatusBar: onMount called, starting checkLlamaStatus");
    // Delay the first check to ensure the main process is fully initialized
    setTimeout(() => {
      checkLlamaStatus();
    }, 2000);
    // Check every 30 seconds
    const interval = setInterval(checkLlamaStatus, 30000);
    return () => clearInterval(interval);
  });

  const getStatusText = () => {
    const status = llamaStatus();
    
    if (status.isPending) {
      return "llama.cpp (setting up...)";
    }
    
    if (!status.isInstalled || !status.isRunning) {
      return "llama.cpp (not running)";
    }
    
    if (!status.modelAvailable) {
      return "llama.cpp (model missing)";
    }
    
    return `llama.cpp v${status.version || 'unknown'} (${status.modelCount} models)`;
  };

  const getStatusColor = () => {
    const status = llamaStatus();
    
    if (status.isPending) {
      return "#ffa500"; // Orange for pending
    }
    
    if (!status.isInstalled || !status.isRunning || !status.modelAvailable) {
      return "#ff6b6b"; // Red for issues
    }
    
    return "#51cf66"; // Green for ready
  };

  const shouldShowSpinner = () => {
    const status = llamaStatus();
    const activeRequestsCount = aiCompletionService.getActiveRequestsCount();
    return status.isPending || activeRequestsCount() > 0;
  };

  return (
    <div 
      style={{ 
        margin: "0 5px", 
        color: getStatusColor(),
        cursor: "pointer",
        display: "flex",
        "align-items": "center",
        gap: "4px"
      }}
      onClick={handleLlamaClick}
      title="Click to open llama.cpp settings"
    >
      {shouldShowSpinner() && (
        <div 
          style={{
            width: "10px",
            height: "10px",
            border: "1px solid #666",
            "border-top": "1px solid #fff",
            "border-radius": "50%",
            animation: "spin 1s linear infinite"
          }}
        />
      )}
      <span>{getStatusText()}</span>
      <style>
        {`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        `}
      </style>
    </div>
  );
};

const GitHub = () => {
  const isConnected = () => {
    return state.appSettings.github.accessToken && state.appSettings.github.username;
  };

  const handleGitHubClick = () => {
    if (state.settingsPane.type === "github-settings") {
      setState("settingsPane", { type: "", data: {} });
    } else {
      setState("settingsPane", { type: "github-settings", data: {} });
    }
  };

  const getStatusText = () => {
    if (isConnected()) {
      return `GitHub @${state.appSettings.github.username}`;
    }
    return "GitHub";
  };

  const getStatusColor = () => {
    return isConnected() ? "#51cf66" : "#666"; // Green if connected, gray if not
  };

  return (
    <div
      style={{
        margin: "0 5px",
        color: getStatusColor(),
        cursor: "pointer",
        "white-space": "nowrap", // Prevent wrapping
        "font-size": "11px"
      }}
      onClick={handleGitHubClick}
      title={isConnected() ? "GitHub connected - click to open settings" : "GitHub not connected - click to connect"}
    >
      {getStatusText()}
    </div>
  );
};

const ColabCloud = () => {
  const isConnected = () => {
    return state.appSettings.colabCloud?.accessToken && state.appSettings.colabCloud?.email;
  };

  const handleColabCloudClick = () => {
    if (state.settingsPane.type === "colab-cloud-settings") {
      setState("settingsPane", { type: "", data: {} });
    } else {
      setState("settingsPane", { type: "colab-cloud-settings", data: {} });
    }
  };

  const getStatusText = () => {
    if (isConnected()) {
      const displayName = state.appSettings.colabCloud.name || state.appSettings.colabCloud.email;
      return `Colab Cloud: ${displayName}`;
    }
    return "Colab Cloud";
  };

  const getStatusColor = () => {
    if (!isConnected()) return "#666"; // Gray if not connected
    if (!state.appSettings.colabCloud.emailVerified) return "#ffa500"; // Orange if email not verified
    return "#51cf66"; // Green if fully connected
  };

  return (
    <div
      style={{
        margin: "0 5px",
        color: getStatusColor(),
        cursor: "pointer",
        "white-space": "nowrap",
        "font-size": "11px"
      }}
      onClick={handleColabCloudClick}
      title={isConnected() ? "Colab Cloud connected - click to open settings" : "Colab Cloud - click to login"}
    >
      {getStatusText()}
    </div>
  );
};

const AnalyticsConsent = () => {
  const shouldShowConsent = () => {
    // Show if user hasn't been prompted yet
    return !state.appSettings.analyticsConsentPrompted;
  };

  const handleAnalyticsClick = () => {
    // Open global settings to analytics section
    setState("settingsPane", { type: "global-settings", data: {} });
  };

  if (!shouldShowConsent()) {
    return null;
  }

  return (
    <>
      <span>|</span>
      <div
        style={{
          margin: "0 5px",
          color: "#ffa500", // Orange to indicate action needed
          cursor: "pointer",
          "white-space": "nowrap",
          "font-size": "11px"
        }}
        onClick={handleAnalyticsClick}
        title="Click to enable analytics and help improve Colab"
      >
        Enable Analytics
      </div>
    </>
  );
};

const Plugins = () => {
  const handlePluginsClick = () => {
    if (state.settingsPane.type === "plugin-marketplace") {
      setState("settingsPane", { type: "", data: {} });
    } else {
      setState("settingsPane", { type: "plugin-marketplace", data: {} });
    }
  };

  return (
    <div
      style={{
        margin: "0 5px",
        color: "#999",
        cursor: "pointer",
        "white-space": "nowrap",
        "font-size": "11px"
      }}
      onClick={handlePluginsClick}
      title="Open Plugins"
    >
      Plugins
    </div>
  );
};
