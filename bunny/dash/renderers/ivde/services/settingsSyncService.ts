/**
 * Settings Sync Service
 * Handles gathering, uploading, and downloading syncable settings
 */

import { state, setState, updateSyncedAppSettings } from '../store';
import { encryptSettings, decryptSettings, type EncryptedPayload } from './settingsSyncEncryption';
import { electrobun } from '../init';

/**
 * Schema for synced settings
 */
export interface SyncedSettings {
  // Schema version for migrations
  schemaVersion: number;
  // When this sync was created
  exportedAt: number;

  // Llama/AI settings
  llama: {
    enabled?: boolean;
    baseUrl?: string;
    model?: string;
    temperature?: number;
    inlineEnabled?: boolean;
  };

  // GitHub auth
  github?: {
    accessToken: string;
    username: string;
    connectedAt: number;
    scopes: string[];
  };

  // Third-party API tokens
  tokens: Array<{
    name: string;
    url?: string;
    endpoint: string;
    token: string;
  }>;

  // Installed plugins
  plugins: Array<{
    name: string;
    version: string;
    enabled: boolean;
    settings?: Record<string, unknown>;
  }>;

  // UI preferences (future)
  ui?: {
    defaultSidebarWidth?: number;
    defaultShowSidebar?: boolean;
  };
}

const SCHEMA_VERSION = 1;

/**
 * Get the API base URL based on build channel
 */
function getApiBaseUrl(): string {
  const channel = state.buildVars.channel;
  if (channel === 'dev') return 'http://127.0.0.1:8788';
  if (channel === 'canary') return 'https://canary-cloud.blackboard.sh';
  return 'https://cloud.blackboard.sh';
}

/**
 * Gather all syncable settings from the app
 */
export async function gatherSyncableSettings(): Promise<SyncedSettings> {
  // Get llama settings
  const llama = {
    enabled: state.appSettings.llama?.enabled,
    baseUrl: state.appSettings.llama?.baseUrl,
    model: state.appSettings.llama?.model,
    temperature: state.appSettings.llama?.temperature,
    inlineEnabled: state.appSettings.llama?.inlineEnabled,
  };

  // Get GitHub settings (if connected)
  const github = state.appSettings.github?.accessToken
    ? {
        accessToken: state.appSettings.github.accessToken,
        username: state.appSettings.github.username || '',
        connectedAt: state.appSettings.github.connectedAt || 0,
        scopes: state.appSettings.github.scopes || [],
      }
    : undefined;

  // Get API tokens from goldfishdb via RPC
  let tokens: SyncedSettings['tokens'] = [];
  try {
    const tokensResult = await (electrobun.rpc as any)?.request.getTokens?.();
    if (tokensResult?.ok && Array.isArray(tokensResult.tokens)) {
      tokens = tokensResult.tokens.map((t: any) => ({
        name: t.name,
        url: t.url,
        endpoint: t.endpoint,
        token: t.token,
      }));
    }
  } catch (error) {
    console.warn('Failed to get tokens for sync:', error);
  }

  // Get installed plugins via RPC
  let plugins: SyncedSettings['plugins'] = [];
  try {
    const pluginsResult = await (electrobun.rpc as any)?.request.pluginGetInstalled?.();
    if (Array.isArray(pluginsResult)) {
      for (const plugin of pluginsResult) {
        // Get plugin settings if any
        let settings: Record<string, unknown> | undefined;
        try {
          const settingsResult = await (electrobun.rpc as any)?.request.pluginGetSettingsValues?.({ pluginName: plugin.name });
          if (settingsResult && Object.keys(settingsResult).length > 0) {
            settings = settingsResult;
          }
        } catch {
          // Ignore settings fetch errors
        }

        plugins.push({
          name: plugin.name,
          version: plugin.version,
          enabled: plugin.enabled,
          settings,
        });
      }
    }
  } catch (error) {
    console.warn('Failed to get plugins for sync:', error);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    llama,
    github,
    tokens,
    plugins,
  };
}

/**
 * Apply synced settings to the app
 */
export async function applySyncedSettings(settings: SyncedSettings): Promise<void> {
  // Apply llama settings
  if (settings.llama) {
    setState('appSettings', 'llama', {
      ...state.appSettings.llama,
      ...settings.llama,
    });
  }

  // Apply GitHub settings
  if (settings.github) {
    setState('appSettings', 'github', {
      accessToken: settings.github.accessToken,
      username: settings.github.username,
      connectedAt: settings.github.connectedAt,
      scopes: settings.github.scopes,
    });
  }

  // Apply tokens via RPC
  if (settings.tokens && settings.tokens.length > 0) {
    try {
      for (const token of settings.tokens) {
        await (electrobun.rpc as any)?.request.setToken?.(token);
      }
    } catch (error) {
      console.warn('Failed to apply tokens:', error);
    }
  }

  // Install/update plugins
  if (settings.plugins && settings.plugins.length > 0) {
    for (const plugin of settings.plugins) {
      try {
        // Check if plugin is already installed
        const installedPlugins = await (electrobun.rpc as any)?.request.pluginGetInstalled?.();
        const isInstalled = installedPlugins?.some((p: any) => p.name === plugin.name);

        if (!isInstalled) {
          // Install the plugin
          await (electrobun.rpc as any)?.request.pluginInstall?.({ packageName: plugin.name, version: plugin.version });
        }

        // Apply plugin settings if any
        if (plugin.settings) {
          for (const [key, value] of Object.entries(plugin.settings)) {
            await (electrobun.rpc as any)?.request.pluginSetSettingValue?.({ pluginName: plugin.name, key, value });
          }
        }

        // Set enabled state
        await (electrobun.rpc as any)?.request.pluginSetEnabled?.({ packageName: plugin.name, enabled: plugin.enabled });
      } catch (error) {
        console.warn(`Failed to sync plugin ${plugin.name}:`, error);
      }
    }
  }

  // Persist changes
  updateSyncedAppSettings();
}

/**
 * Upload settings to Colab Cloud
 */
export async function uploadSettings(passphrase: string): Promise<{ success: boolean; error?: string }> {
  const accessToken = state.appSettings.colabCloud?.accessToken;
  if (!accessToken) {
    return { success: false, error: 'Not logged in to Colab Cloud' };
  }

  try {
    // Gather settings
    const settings = await gatherSyncableSettings();

    // Encrypt with passphrase
    const encryptedPayload = await encryptSettings(settings, passphrase);

    // Upload to server
    const response = await fetch(`${getApiBaseUrl()}/api/sync/settings`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ encryptedPayload }),
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'Upload failed' };
    }

    return { success: true };
  } catch (error) {
    console.error('Settings upload error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Upload failed' };
  }
}

/**
 * Download and apply settings from Colab Cloud
 */
export async function downloadSettings(passphrase: string): Promise<{ success: boolean; error?: string }> {
  const accessToken = state.appSettings.colabCloud?.accessToken;
  if (!accessToken) {
    return { success: false, error: 'Not logged in to Colab Cloud' };
  }

  try {
    // Download from server
    const response = await fetch(`${getApiBaseUrl()}/api/sync/settings`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    const result = await response.json();

    if (!response.ok) {
      return { success: false, error: result.error || 'Download failed' };
    }

    if (!result.exists) {
      return { success: false, error: 'No settings found in cloud' };
    }

    // Decrypt with passphrase
    const encryptedPayload = result.data as EncryptedPayload;
    let settings: SyncedSettings;
    try {
      settings = await decryptSettings<SyncedSettings>(encryptedPayload, passphrase);
    } catch (decryptError) {
      return { success: false, error: 'Wrong passphrase' };
    }

    // Apply settings
    await applySyncedSettings(settings);

    return { success: true };
  } catch (error) {
    console.error('Settings download error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Download failed' };
  }
}

/**
 * Get sync status from server
 */
export async function getSyncStatus(): Promise<{
  hasSyncedSettings: boolean;
  storage?: {
    used: number;
    limit: number;
    usedFormatted: string;
    limitFormatted: string;
    percentUsed: number;
  };
  lastSync?: {
    at: number | null;
  };
  error?: string;
}> {
  const accessToken = state.appSettings.colabCloud?.accessToken;
  if (!accessToken) {
    return { hasSyncedSettings: false, error: 'Not logged in' };
  }

  try {
    const response = await fetch(`${getApiBaseUrl()}/api/sync/status`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return { hasSyncedSettings: false, error: data.error };
    }

    return data;
  } catch (error) {
    return { hasSyncedSettings: false, error: 'Failed to fetch status' };
  }
}
