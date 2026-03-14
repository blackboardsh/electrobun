import {
  type JSXElement,
  createSignal,
  onMount,
  Show,
} from "solid-js";
import { state, setState, updateSyncedAppSettings } from "../store";
import {
  SettingsPaneSaveClose,
  SettingsPaneFormSection,
  SettingsPaneField,
} from "./forms";
import {
  uploadSettings,
  downloadSettings,
  getSyncStatus,
} from "../services/settingsSyncService";

// API URLs - use 127.0.0.1 in dev, canary-cloud for canary, cloud for stable
const getApiBaseUrl = () => {
  const channel = state.buildVars.channel;
  if (channel === "dev") return "http://127.0.0.1:8788";
  if (channel === "canary") return "https://canary-cloud.blackboard.sh";
  return "https://cloud.blackboard.sh";
};

const getDashboardUrl = () => {
  return `${getApiBaseUrl()}/dashboard`;
};

export const ColabCloudSettings = (): JSXElement => {
  const [isLoggingIn, setIsLoggingIn] = createSignal(false);
  const [loginError, setLoginError] = createSignal<string>("");
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [connectionStatus, setConnectionStatus] = createSignal<string>("");

  // Sync-related state
  const [isSettingPassphrase, setIsSettingPassphrase] = createSignal(false);
  const [newPassphrase, setNewPassphrase] = createSignal("");
  const [confirmPassphrase, setConfirmPassphrase] = createSignal("");
  const [isSyncing, setIsSyncing] = createSignal(false);
  const [syncMessage, setSyncMessage] = createSignal<{ type: 'success' | 'error'; text: string } | null>(null);
  const [syncStatus, setSyncStatus] = createSignal<{
    hasSyncedSettings: boolean;
    storage?: {
      used: number;
      limit: number;
      usedFormatted: string;
      limitFormatted: string;
      percentUsed: number;
    };
    lastSync?: { at: number | null };
  } | null>(null);

  // Check if passphrase is set
  const hasPassphrase = () => !!state.appSettings.colabCloud?.syncPassphrase;

  const isConnected = () => {
    return state.appSettings.colabCloud?.accessToken && state.appSettings.colabCloud?.email;
  };

  const formatDate = (timestamp: number | undefined | null) => {
    if (!timestamp) return "Never";
    return new Date(timestamp * 1000).toLocaleString();
  };

  const formatDateShort = (timestamp: number | undefined) => {
    if (!timestamp) return "Never";
    return new Date(timestamp).toLocaleDateString();
  };

  onMount(() => {
    // If we have a token, verify it's still valid
    if (isConnected()) {
      verifyConnection();
      fetchSyncStatus();
    }
  });

  const fetchSyncStatus = async () => {
    const status = await getSyncStatus();
    if (!status.error) {
      setSyncStatus(status);
    }
  };

  const verifyConnection = async () => {
    if (!state.appSettings.colabCloud?.accessToken) return;

    setConnectionStatus("Verifying connection...");

    try {
      const response = await fetch(`${getApiBaseUrl()}/api/user/profile`, {
        headers: {
          'Authorization': `Bearer ${state.appSettings.colabCloud.accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        // Update user info if changed
        setState("appSettings", "colabCloud", {
          ...state.appSettings.colabCloud,
          email: data.user.email,
          name: data.user.name,
          emailVerified: data.user.email_verified === 1,
        });
        setConnectionStatus("Connected");
        updateSyncedAppSettings();
      } else if (response.status === 401) {
        // Token expired, try to refresh
        await refreshToken();
      } else {
        setConnectionStatus("Connection error");
      }
    } catch (error) {
      console.error("Error verifying Colab Cloud connection:", error);
      setConnectionStatus("Failed to verify connection");
    }
  };

  const refreshToken = async () => {
    const refreshTokenValue = state.appSettings.colabCloud?.refreshToken;
    if (!refreshTokenValue) {
      disconnect();
      return;
    }

    try {
      const response = await fetch(`${getApiBaseUrl()}/api/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken: refreshTokenValue }),
      });

      if (response.ok) {
        const data = await response.json();
        setState("appSettings", "colabCloud", {
          ...state.appSettings.colabCloud,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
        });
        setConnectionStatus("Connected");
        updateSyncedAppSettings();
      } else {
        // Refresh token invalid, need to re-login
        disconnect();
        setConnectionStatus("Session expired, please login again");
      }
    } catch (error) {
      console.error("Error refreshing token:", error);
      setConnectionStatus("Failed to refresh session");
    }
  };

  const login = async () => {
    if (!email() || !password()) {
      setLoginError("Email and password are required");
      return;
    }

    setIsLoggingIn(true);
    setLoginError("");

    try {
      const response = await fetch(`${getApiBaseUrl()}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email(),
          password: password(),
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setState("appSettings", "colabCloud", {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          userId: data.user.id,
          email: data.user.email,
          name: data.user.name,
          emailVerified: data.user.email_verified === 1,
          connectedAt: Date.now(),
        });
        setConnectionStatus("Connected successfully!");
        setEmail("");
        setPassword("");
        updateSyncedAppSettings();
        fetchSyncStatus();
      } else {
        setLoginError(data.error || "Login failed");
      }
    } catch (error) {
      console.error("Login error:", error);
      setLoginError("Network error. Please check your connection.");
    } finally {
      setIsLoggingIn(false);
    }
  };

  const disconnect = async () => {
    // Try to logout on server
    try {
      const refreshTokenValue = state.appSettings.colabCloud?.refreshToken;
      if (refreshTokenValue) {
        await fetch(`${getApiBaseUrl()}/api/auth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refreshToken: refreshTokenValue }),
        });
      }
    } catch (error) {
      // Ignore errors, we're logging out anyway
    }

    setState("appSettings", "colabCloud", {
      accessToken: "",
      refreshToken: "",
      userId: "",
      email: "",
      name: "",
      emailVerified: false,
      connectedAt: undefined,
    });
    setConnectionStatus("Disconnected");
    setSyncStatus(null);
    updateSyncedAppSettings();
  };

  const handleSavePassphrase = () => {
    if (!newPassphrase()) {
      setSyncMessage({ type: 'error', text: 'Please enter a passphrase' });
      return;
    }

    if (newPassphrase().length < 8) {
      setSyncMessage({ type: 'error', text: 'Passphrase must be at least 8 characters' });
      return;
    }

    if (newPassphrase() !== confirmPassphrase()) {
      setSyncMessage({ type: 'error', text: 'Passphrases do not match' });
      return;
    }

    setState("appSettings", "colabCloud", {
      ...state.appSettings.colabCloud,
      syncPassphrase: newPassphrase(),
    });
    updateSyncedAppSettings();
    setNewPassphrase("");
    setConfirmPassphrase("");
    setIsSettingPassphrase(false);
    setSyncMessage({ type: 'success', text: 'Passphrase saved!' });
  };

  // Show message with minimum display time
  const showSyncMessage = (message: { type: 'success' | 'error'; text: string }, minDuration = 2000) => {
    setSyncMessage(message);
    setTimeout(() => {
      setSyncMessage(null);
    }, minDuration);
  };

  const handleBackup = async () => {
    const passphrase = state.appSettings.colabCloud?.syncPassphrase;
    if (!passphrase) {
      showSyncMessage({ type: 'error', text: 'Please set a passphrase first' });
      return;
    }

    setIsSyncing(true);
    setSyncMessage(null);

    const result = await uploadSettings(passphrase);

    setIsSyncing(false);

    if (result.success) {
      showSyncMessage({ type: 'success', text: 'Settings backed up successfully!' });
      fetchSyncStatus();
    } else {
      showSyncMessage({ type: 'error', text: result.error || 'Backup failed' });
    }
  };

  const handleRestore = async () => {
    const passphrase = state.appSettings.colabCloud?.syncPassphrase;
    if (!passphrase) {
      showSyncMessage({ type: 'error', text: 'Please set a passphrase first' });
      return;
    }

    setIsSyncing(true);
    setSyncMessage(null);

    const result = await downloadSettings(passphrase);

    setIsSyncing(false);

    if (result.success) {
      showSyncMessage({ type: 'success', text: 'Settings restored successfully!' });
      fetchSyncStatus();
    } else {
      showSyncMessage({ type: 'error', text: result.error || 'Restore failed. Wrong passphrase?' });
    }
  };

  const onSubmit = (e: SubmitEvent) => {
    e.preventDefault();
    setState("settingsPane", { type: "", data: {} });
  };

  return (
    <div
      style="background: #404040; color: #d9d9d9; height: 100vh; overflow: hidden; display: flex; flex-direction: column;"
    >
      <form onSubmit={onSubmit} style="height: 100%; display: flex; flex-direction: column;">
        <SettingsPaneSaveClose label="Colab Cloud" />

        <div style="flex: 1; overflow-y: auto; padding: 0; margin-bottom: 60px;">
          <SettingsPaneFormSection label="Connection Status">
            <SettingsPaneField label="Status">
              <div style="background: #202020; padding: 12px; color: #d9d9d9; font-size: 12px; border-radius: 4px; margin-bottom: 8px;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                  <div style={{
                    width: "8px",
                    height: "8px",
                    "border-radius": "50%",
                    background: isConnected() ? "#51cf66" : "#666",
                  }}></div>
                  <span style="font-weight: 500;">
                    {isConnected() ? "Connected" : "Not Connected"}
                  </span>
                </div>
                <Show when={connectionStatus()}>
                  <div style="font-size: 11px; color: #999; margin-top: 4px;">
                    {connectionStatus()}
                  </div>
                </Show>
              </div>
            </SettingsPaneField>

            <Show when={isConnected()}>
              <SettingsPaneField label="Account">
                <div style="background: #2b2b2b; padding: 12px; border-radius: 4px;">
                  <div style="display: flex; flex-direction: column; gap: 4px;">
                    <span style="font-size: 12px; font-weight: 500; color: #d9d9d9;">
                      {state.appSettings.colabCloud?.name || state.appSettings.colabCloud?.email}
                    </span>
                    <span style="font-size: 10px; color: #999;">
                      {state.appSettings.colabCloud?.email}
                    </span>
                    <Show when={!state.appSettings.colabCloud?.emailVerified}>
                      <span style="font-size: 10px; color: #ffa500; margin-top: 4px;">
                        Email not verified
                      </span>
                    </Show>
                  </div>
                </div>
              </SettingsPaneField>

              <SettingsPaneField label="Connected">
                <div style="font-size: 11px; color: #999;">
                  Connected on {formatDateShort(state.appSettings.colabCloud?.connectedAt)}
                </div>
              </SettingsPaneField>
            </Show>
          </SettingsPaneFormSection>

          <SettingsPaneFormSection label="Authentication">
            <Show
              when={!isConnected()}
              fallback={
                <SettingsPaneField label="">
                  <button
                    type="button"
                    onClick={disconnect}
                    style="background: #ff6b6b; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; width: 100%;"
                  >
                    Logout
                  </button>
                  <div style="font-size: 11px; color: #999; margin-top: 8px; text-align: center;">
                    You will need to login again to sync settings.
                  </div>
                </SettingsPaneField>
              }
            >
              <SettingsPaneField label="">
                <Show when={loginError()}>
                  <div style="background: rgba(255, 107, 107, 0.1); border: 1px solid rgba(255, 107, 107, 0.3); color: #ff6b6b; padding: 8px 12px; border-radius: 4px; font-size: 11px; margin-bottom: 12px;">
                    {loginError()}
                  </div>
                </Show>

                <div style="margin-bottom: 12px;">
                  <label style="display: block; font-size: 11px; color: #999; margin-bottom: 4px;">
                    Email
                  </label>
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={email()}
                    onInput={(e) => setEmail(e.currentTarget.value)}
                    style="background: #2b2b2b; border: 1px solid #555; color: #d9d9d9; padding: 8px 12px; border-radius: 4px; font-size: 12px; width: 100%; box-sizing: border-box;"
                  />
                </div>

                <div style="margin-bottom: 12px;">
                  <label style="display: block; font-size: 11px; color: #999; margin-bottom: 4px;">
                    Password
                  </label>
                  <input
                    type="password"
                    placeholder="Enter your password"
                    value={password()}
                    onInput={(e) => setPassword(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        login();
                      }
                    }}
                    style="background: #2b2b2b; border: 1px solid #555; color: #d9d9d9; padding: 8px 12px; border-radius: 4px; font-size: 12px; width: 100%; box-sizing: border-box;"
                  />
                </div>

                <button
                  type="button"
                  onClick={login}
                  disabled={isLoggingIn()}
                  style={`background: #4ade80; color: #1a1a1a; border: none; padding: 10px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; width: 100%; font-weight: 500; opacity: ${isLoggingIn() ? 0.7 : 1};`}
                >
                  {isLoggingIn() ? "Logging in..." : "Login"}
                </button>

                <div style="font-size: 11px; color: #999; margin-top: 12px; text-align: center;">
                  Don't have an account?{" "}
                  <a
                    href="#"
                    style="color: #4ade80; text-decoration: none;"
                    onClick={(e) => {
                      e.preventDefault();
                      // Open registration page in a web tab
                      const registerUrl = `${getApiBaseUrl()}/register`;
                      import("../store").then(({ openNewTabForNode }) => {
                        openNewTabForNode("__COLAB_INTERNAL__/web", false, { url: registerUrl });
                      });
                    }}
                  >
                    Sign up
                  </a>
                </div>
              </SettingsPaneField>
            </Show>
          </SettingsPaneFormSection>

          {/* Settings Sync Section - Only show when connected */}
          <Show when={isConnected()}>
            <SettingsPaneFormSection label="Settings Backup">
              {/* Passphrase not set - show setup prompt */}
              <Show when={!hasPassphrase() && !isSettingPassphrase()}>
                <SettingsPaneField label="">
                  <div style="background: rgba(255, 193, 7, 0.1); border: 1px solid rgba(255, 193, 7, 0.3); padding: 16px; border-radius: 4px; text-align: center;">
                    <div style="font-size: 13px; color: #ffc107; font-weight: 500; margin-bottom: 8px;">
                      Set up encryption to enable sync
                    </div>
                    <div style="font-size: 11px; color: #999; margin-bottom: 12px;">
                      Your settings are encrypted locally before upload. We never see your data.
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsSettingPassphrase(true)}
                      style="background: #4ade80; color: #1a1a1a; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500;"
                    >
                      Set Encryption Passphrase
                    </button>
                  </div>
                </SettingsPaneField>
              </Show>

              {/* Setting passphrase form */}
              <Show when={isSettingPassphrase()}>
                <SettingsPaneField label="Create Encryption Passphrase">
                  <div style="font-size: 11px; color: #999; margin-bottom: 12px;">
                    This passphrase encrypts your settings. You'll need it to restore on other devices.
                  </div>
                  <input
                    type="password"
                    placeholder="Enter passphrase (min 8 characters)"
                    value={newPassphrase()}
                    onInput={(e) => setNewPassphrase(e.currentTarget.value)}
                    style="background: #2b2b2b; border: 1px solid #555; color: #d9d9d9; padding: 8px 12px; border-radius: 4px; font-size: 12px; width: 100%; box-sizing: border-box; margin-bottom: 8px;"
                  />
                  <input
                    type="password"
                    placeholder="Confirm passphrase"
                    value={confirmPassphrase()}
                    onInput={(e) => setConfirmPassphrase(e.currentTarget.value)}
                    style="background: #2b2b2b; border: 1px solid #555; color: #d9d9d9; padding: 8px 12px; border-radius: 4px; font-size: 12px; width: 100%; box-sizing: border-box; margin-bottom: 12px;"
                  />
                  <div style="display: flex; gap: 8px;">
                    <button
                      type="button"
                      onClick={handleSavePassphrase}
                      style="flex: 1; background: #4ade80; color: #1a1a1a; border: none; padding: 10px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500;"
                    >
                      Save Passphrase
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsSettingPassphrase(false);
                        setNewPassphrase("");
                        setConfirmPassphrase("");
                        setSyncMessage(null);
                      }}
                      style="background: #333; color: #d9d9d9; border: 1px solid #555; padding: 10px 16px; border-radius: 4px; cursor: pointer; font-size: 12px;"
                    >
                      Cancel
                    </button>
                  </div>
                </SettingsPaneField>
              </Show>

              {/* Passphrase is set - show backup/restore UI */}
              <Show when={hasPassphrase() && !isSettingPassphrase()}>
                {/* What gets synced */}
                <SettingsPaneField label="What gets backed up">
                  <div style="background: #2b2b2b; padding: 12px; border-radius: 4px; font-size: 11px;">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; color: #999;">
                      <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="color: #4ade80;">✓</span> AI / Llama settings
                      </div>
                      <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="color: #4ade80;">✓</span> GitHub connection
                      </div>
                      <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="color: #4ade80;">✓</span> API tokens
                      </div>
                      <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="color: #4ade80;">✓</span> Installed plugins
                      </div>
                    </div>
                  </div>
                </SettingsPaneField>

                {/* Sync status */}
                <Show when={syncStatus()}>
                  <SettingsPaneField label="Backup Status">
                    <div style="background: #2b2b2b; padding: 12px; border-radius: 4px;">
                      <div style="font-size: 11px; color: #999;">
                        <Show when={syncStatus()?.hasSyncedSettings} fallback={
                          <span>No backup yet</span>
                        }>
                          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                            <span>Last backup:</span>
                            <span style="color: #d9d9d9;">{formatDate(syncStatus()?.lastSync?.at)}</span>
                          </div>
                          <div style="display: flex; justify-content: space-between;">
                            <span>Size:</span>
                            <span style="color: #d9d9d9;">
                              {syncStatus()?.storage?.usedFormatted} / {syncStatus()?.storage?.limitFormatted}
                            </span>
                          </div>
                        </Show>
                      </div>
                    </div>
                  </SettingsPaneField>
                </Show>

                {/* Backup/Restore buttons */}
                <SettingsPaneField label="">
                  {/* Message area - fixed height to prevent layout shift */}
                  <div style={{
                    height: syncMessage() ? "auto" : "0",
                    "min-height": syncMessage() ? "36px" : "0",
                    "margin-bottom": syncMessage() ? "12px" : "0",
                    overflow: "hidden",
                    transition: "all 0.15s ease",
                  }}>
                    <Show when={syncMessage()}>
                      <div style={{
                        background: syncMessage()?.type === 'success'
                          ? "rgba(74, 222, 128, 0.1)"
                          : "rgba(255, 107, 107, 0.1)",
                        border: syncMessage()?.type === 'success'
                          ? "1px solid rgba(74, 222, 128, 0.3)"
                          : "1px solid rgba(255, 107, 107, 0.3)",
                        color: syncMessage()?.type === 'success' ? "#4ade80" : "#ff6b6b",
                        padding: "8px 12px",
                        "border-radius": "4px",
                        "font-size": "11px",
                        "text-align": "center",
                      }}>
                        {syncMessage()?.text}
                      </div>
                    </Show>
                  </div>
                  <div style="display: flex; gap: 8px;">
                    <button
                      type="button"
                      onClick={handleBackup}
                      disabled={isSyncing()}
                      style={`flex: 1; background: #4ade80; color: #1a1a1a; border: none; padding: 10px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500; opacity: ${isSyncing() ? 0.7 : 1};`}
                    >
                      {isSyncing() ? "Working..." : "Backup"}
                    </button>
                    <button
                      type="button"
                      onClick={handleRestore}
                      disabled={isSyncing() || !syncStatus()?.hasSyncedSettings}
                      style={`flex: 1; background: #333; color: #d9d9d9; border: 1px solid #555; padding: 10px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; opacity: ${(isSyncing() || !syncStatus()?.hasSyncedSettings) ? 0.5 : 1};`}
                    >
                      Restore
                    </button>
                  </div>
                </SettingsPaneField>

                {/* Change passphrase option */}
                <SettingsPaneField label="">
                  <button
                    type="button"
                    onClick={() => setIsSettingPassphrase(true)}
                    style="background: transparent; color: #999; border: none; padding: 4px 0; cursor: pointer; font-size: 11px; text-decoration: underline;"
                  >
                    Change passphrase
                  </button>
                </SettingsPaneField>
              </Show>
            </SettingsPaneFormSection>
          </Show>

          <SettingsPaneFormSection label="Manage Account">
            <SettingsPaneField label="">
              <button
                type="button"
                onClick={() => {
                  import("../store").then(({ openNewTabForNode }) => {
                    openNewTabForNode("__COLAB_INTERNAL__/web", false, { url: getDashboardUrl() });
                  });
                }}
                style="background: #333; color: #d9d9d9; border: 1px solid #555; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; width: 100%;"
              >
                Open Colab Cloud Dashboard
              </button>
              <div style="font-size: 11px; color: #999; margin-top: 8px; text-align: center;">
                Manage your account, devices, and subscription.
              </div>
            </SettingsPaneField>
          </SettingsPaneFormSection>
        </div>
      </form>
    </div>
  );
};
