import { type JSXElement } from "solid-js";
import { state, setState } from "../store";

export const GitHubStatus = (): JSXElement => {
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
      return `GitHub (@${state.appSettings.github.username})`;
    }
    return "GitHub (not connected)";
  };

  const getStatusColor = () => {
    return isConnected() ? "#51cf66" : "#666"; // Green if connected, gray if not
  };

  const getIcon = () => {
    if (isConnected()) {
      return "✓"; // Check mark for connected
    }
    return "○"; // Circle for not connected
  };

  return (
    <div 
      style={{ 
        margin: "0 5px", 
        color: getStatusColor(),
        cursor: "pointer",
        display: "flex",
        "align-items": "center",
        gap: "4px",
        "font-size": "11px"
      }}
      onClick={handleGitHubClick}
      title="Click to open GitHub integration settings"
    >
      <span>{getIcon()}</span>
      <span>{getStatusText()}</span>
    </div>
  );
};