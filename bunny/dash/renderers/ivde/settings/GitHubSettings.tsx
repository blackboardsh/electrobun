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
import { electrobun } from "../init";

export const GitHubSettings = (): JSXElement => {
  const [statusMessage, setStatusMessage] = createSignal<string>("");
  const [userInfo, setUserInfo] = createSignal<{
    login: string;
    name: string;
    avatar_url: string;
    public_repos: number;
    private_repos: number;
  } | null>(null);

  // Git identity state
  const [gitName, setGitName] = createSignal("");
  const [gitEmail, setGitEmail] = createSignal("");
  const [hasKeychainHelper, setHasKeychainHelper] = createSignal(false);
  const [keychainCredentials, setKeychainCredentials] = createSignal<{ hasCredentials: boolean; username?: string }>({ hasCredentials: false });

  // GitHub credentials input state
  const [usernameInput, setUsernameInput] = createSignal("");
  const [patInput, setPatInput] = createSignal("");
  const [isVerifyingPat, setIsVerifyingPat] = createSignal(false);

  // Save button states
  const [identitySaved, setIdentitySaved] = createSignal(false);

  const isConnected = () => {
    return keychainCredentials().hasCredentials && userInfo();
  };

  onMount(async () => {
    // Fetch git config and credential status
    try {
      const config = await electrobun.rpc?.request.getGitConfig();
      if (config) {
        setGitName(config.name);
        setGitEmail(config.email);
        setHasKeychainHelper(config.hasKeychainHelper);
      }

      const credentials = await electrobun.rpc?.request.checkGitHubCredentials();
      if (credentials) {
        setKeychainCredentials(credentials);
        if (credentials.username) {
          setUsernameInput(credentials.username);
        }
      }
    } catch (error) {
      console.error("Error fetching git config:", error);
    }

    // If we have a stored token, verify it and get user info
    if (state.appSettings.github.accessToken) {
      verifyToken(state.appSettings.github.accessToken);
    }
  });

  const verifyToken = async (token: string) => {
    if (!token) return false;

    setIsVerifyingPat(true);
    setStatusMessage("Verifying token...");

    try {
      const response = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Colab-IDE/1.0.0',
        },
      });

      if (response.ok) {
        const userData = await response.json();
        const scopes = response.headers.get('X-OAuth-Scopes')?.split(', ') || [];

        setUserInfo(userData);
        setUsernameInput(userData.login);
        setStatusMessage("");

        // Save to app settings
        setState("appSettings", "github", {
          accessToken: token,
          username: userData.login,
          connectedAt: Date.now(),
          scopes: scopes,
        });
        updateSyncedAppSettings();

        setIsVerifyingPat(false);
        return true;
      } else {
        setStatusMessage("Invalid token");
        setIsVerifyingPat(false);
        return false;
      }
    } catch (error) {
      console.error("Error verifying token:", error);
      setStatusMessage("Failed to verify token");
      setIsVerifyingPat(false);
      return false;
    }
  };

  const saveIdentity = async () => {
    try {
      await electrobun.rpc?.request.setGitConfig({
        name: gitName(),
        email: gitEmail(),
      });

      setIdentitySaved(true);
      setTimeout(() => setIdentitySaved(false), 2000);
    } catch (error) {
      console.error("Error saving git config:", error);
      setStatusMessage("Failed to save git identity");
    }
  };

  const connectGitHub = async () => {
    const username = usernameInput();
    const token = patInput();

    if (!username || !token) {
      setStatusMessage("Please enter both username and token");
      return;
    }

    // Verify the token first
    const isValid = await verifyToken(token);
    if (!isValid) return;

    // Store in keychain for push/pull
    if (hasKeychainHelper()) {
      try {
        await electrobun.rpc?.request.storeGitHubCredentials({
          username: username,
          token: token,
        });
        setKeychainCredentials({ hasCredentials: true, username: username });
        setPatInput("");
        setStatusMessage("Connected successfully!");
        setTimeout(() => setStatusMessage(""), 2000);
      } catch (error) {
        console.error("Error storing credentials:", error);
        setStatusMessage("Failed to store credentials");
      }
    }
  };

  const disconnect = async () => {
    try {
      // Remove from keychain
      if (hasKeychainHelper()) {
        await electrobun.rpc?.request.removeGitHubCredentials();
        setKeychainCredentials({ hasCredentials: false });
      }

      // Clear app settings
      setState("appSettings", "github", {
        accessToken: "",
        username: "",
        connectedAt: undefined,
        scopes: [],
      });
      updateSyncedAppSettings();

      setUserInfo(null);
      setUsernameInput("");
      setPatInput("");
      setStatusMessage("Disconnected");
      setTimeout(() => setStatusMessage(""), 2000);
    } catch (error) {
      console.error("Error disconnecting:", error);
      setStatusMessage("Failed to disconnect");
    }
  };

  const onSubmit = (e: SubmitEvent) => {
    e.preventDefault();
    setState("settingsPane", { type: "", data: {} });
  };

  const openTokenPage = (e: Event) => {
    e.preventDefault();
    setState("githubAuth", {
      authUrl: "https://github.com/settings/tokens/new?scopes=repo,read:user,read:org&description=Colab%20IDE",
      resolver: () => setState("githubAuth", { authUrl: null, resolver: null }),
    });
  };

  return (
    <div
      style="background: #404040; color: #d9d9d9; height: 100vh; overflow: hidden; display: flex; flex-direction: column;"
    >
      <form onSubmit={onSubmit} style="height: 100%; display: flex; flex-direction: column;">
        <SettingsPaneSaveClose label="Git & GitHub" />

        <div style="flex: 1; overflow-y: auto; padding: 0; margin-bottom: 60px;">
          {/* Status Banner */}
          <Show when={statusMessage()}>
            <div style="background: #2b2b2b; padding: 8px 16px; font-size: 12px; color: #51cf66; border-bottom: 1px solid #333;">
              {statusMessage()}
            </div>
          </Show>

          {/* Git Identity Section */}
          <SettingsPaneFormSection label="Git">
            <SettingsPaneField label="Author Name">
              <input
                type="text"
                value={gitName()}
                onInput={(e) => setGitName(e.currentTarget.value)}
                placeholder="Your Name"
                style="background: #2b2b2b; border: 1px solid #555; color: #d9d9d9; padding: 8px 12px; border-radius: 4px; font-size: 12px; width: 100%; box-sizing: border-box;"
              />
              <div style="font-size: 10px; color: #777; margin-top: 4px;">
                Used for commit author attribution
              </div>
            </SettingsPaneField>

            <SettingsPaneField label="Author Email">
              <input
                type="email"
                value={gitEmail()}
                onInput={(e) => setGitEmail(e.currentTarget.value)}
                placeholder="your@email.com"
                style="background: #2b2b2b; border: 1px solid #555; color: #d9d9d9; padding: 8px 12px; border-radius: 4px; font-size: 12px; width: 100%; box-sizing: border-box;"
              />
              <div style="font-size: 10px; color: #777; margin-top: 4px;">
                Used for commit author attribution
              </div>
            </SettingsPaneField>

            <SettingsPaneField label="">
              <button
                type="button"
                onClick={saveIdentity}
                style={{
                  background: identitySaved() ? "#51cf66" : "#0969da",
                  color: "white",
                  border: "none",
                  padding: "8px 16px",
                  "border-radius": "4px",
                  cursor: "pointer",
                  "font-size": "12px",
                  width: "100%",
                }}
              >
                {identitySaved() ? "Saved" : "Save Identity"}
              </button>
            </SettingsPaneField>
          </SettingsPaneFormSection>

          {/* GitHub Section */}
          <SettingsPaneFormSection label="GitHub">
            <Show
              when={isConnected()}
              fallback={
                <>
                  {/* Not connected - show input fields */}
                  <SettingsPaneField label="">
                    <div style="background: #1a1a1a; border: 1px solid #333; padding: 12px; border-radius: 4px; margin-bottom: 8px;">
                      <div style="font-size: 11px; color: #ffa500; font-weight: 500; margin-bottom: 6px;">
                        Use a Classic PAT
                      </div>
                      <div style="font-size: 11px; color: #999; line-height: 1.4;">
                        Fine-grained PATs may not work for push/pull. Create a <strong>Classic</strong> token with <code>repo</code> scope.
                      </div>
                      <a
                        href="#"
                        onClick={openTokenPage}
                        style="display: inline-block; margin-top: 8px; font-size: 11px; color: #0969da; text-decoration: none;"
                      >
                        Create Classic Token on GitHub
                      </a>
                    </div>
                  </SettingsPaneField>

                  <SettingsPaneField label="Username">
                    <input
                      type="text"
                      value={usernameInput()}
                      onInput={(e) => setUsernameInput(e.currentTarget.value)}
                      placeholder="your-github-username"
                      style="background: #2b2b2b; border: 1px solid #555; color: #d9d9d9; padding: 8px 12px; border-radius: 4px; font-size: 12px; width: 100%; box-sizing: border-box;"
                    />
                  </SettingsPaneField>

                  <SettingsPaneField label="Personal Access Token">
                    <input
                      type="password"
                      value={patInput()}
                      onInput={(e) => setPatInput(e.currentTarget.value)}
                      placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                      style="background: #2b2b2b; border: 1px solid #555; color: #d9d9d9; padding: 8px 12px; border-radius: 4px; font-size: 12px; width: 100%; box-sizing: border-box; font-family: 'Fira Code', monospace;"
                    />
                    <div style="font-size: 10px; color: #777; margin-top: 4px;">
                      Classic tokens start with <code>ghp_</code>
                    </div>
                  </SettingsPaneField>

                  <SettingsPaneField label="">
                    <button
                      type="button"
                      onClick={connectGitHub}
                      disabled={isVerifyingPat()}
                      style={{
                        background: isVerifyingPat() ? "#555" : "#51cf66",
                        color: "white",
                        border: "none",
                        padding: "8px 16px",
                        "border-radius": "4px",
                        cursor: isVerifyingPat() ? "wait" : "pointer",
                        "font-size": "12px",
                        width: "100%",
                      }}
                    >
                      {isVerifyingPat() ? "Connecting..." : "Connect GitHub"}
                    </button>
                  </SettingsPaneField>

                  <Show when={!hasKeychainHelper()}>
                    <SettingsPaneField label="">
                      <div style="background: #3d2020; border: 1px solid #5a3030; padding: 12px; border-radius: 4px; font-size: 11px; color: #ff9999;">
                        macOS Keychain helper not available. Install Xcode Command Line Tools to enable secure credential storage.
                      </div>
                    </SettingsPaneField>
                  </Show>
                </>
              }
            >
              {/* Connected - show status */}
              <SettingsPaneField label="">
                <div style="background: #2b2b2b; padding: 16px; border-radius: 4px;">
                  <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                    <img
                      src={userInfo()?.avatar_url}
                      style="width: 48px; height: 48px; border-radius: 50%;"
                      alt="GitHub Avatar"
                    />
                    <div style="display: flex; flex-direction: column; flex: 1;">
                      <span style="font-size: 14px; font-weight: 500; color: #d9d9d9;">
                        {userInfo()?.name || userInfo()?.login}
                      </span>
                      <span style="font-size: 12px; color: #999;">
                        @{userInfo()?.login}
                      </span>
                    </div>
                  </div>

                  <div style="display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid #444;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                      <div style={{
                        width: "8px",
                        height: "8px",
                        "border-radius": "50%",
                        background: "#51cf66",
                      }}></div>
                      <span style="font-size: 11px; color: #999;">
                        {userInfo()?.public_repos || 0} public repos, {userInfo()?.private_repos || 0} private repos
                      </span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                      <div style={{
                        width: "8px",
                        height: "8px",
                        "border-radius": "50%",
                        background: keychainCredentials().hasCredentials ? "#51cf66" : "#ffa500",
                      }}></div>
                      <span style="font-size: 11px; color: #999;">
                        {keychainCredentials().hasCredentials
                          ? "Push/pull credentials stored in Keychain"
                          : "Push/pull credentials not stored"}
                      </span>
                    </div>
                  </div>
                </div>
              </SettingsPaneField>

              <SettingsPaneField label="">
                <button
                  type="button"
                  onClick={disconnect}
                  style="background: #ff6b6b; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; width: 100%;"
                >
                  Disconnect GitHub
                </button>
              </SettingsPaneField>
            </Show>
          </SettingsPaneFormSection>
        </div>
      </form>
    </div>
  );
};
