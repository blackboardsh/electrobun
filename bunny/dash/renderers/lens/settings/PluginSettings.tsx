import {
  type JSXElement,
  type Component,
  createSignal,
  onMount,
  onCleanup,
  For,
  Show,
  Switch,
  Match,
  lazy,
  Suspense,
} from "solid-js";
import { state, setState } from "../store";
import {
  SettingsPaneSaveClose,
  SettingsPaneFormSection,
  SettingsPaneField,
} from "./forms";
import { electrobun } from "../init";

// Props for custom settings components
export interface CustomSettingsComponentProps {
  pluginName: string;
  sendMessage: (message: unknown) => Promise<void>;
  onMessage: (callback: (message: unknown) => void) => void;
  getState: <T = unknown>(key: string) => Promise<T | undefined>;
  setState: <T = unknown>(key: string, value: T) => Promise<void>;
}

import { getSettingsComponent } from "../slates/pluginSlateRegistry";

// Load a custom settings component from the plugin registry
async function loadCustomComponent(name: string): Promise<Component<CustomSettingsComponentProps> | null> {
  const component = getSettingsComponent(name);
  if (!component) {
    console.warn(`Unknown custom settings component: ${name}`);
    return null;
  }
  return component as Component<CustomSettingsComponentProps>;
}

// Wrapper component that handles lazy loading of custom settings components
const CustomSettingsLoader = (props: { componentName: string; pluginName: string }): JSXElement => {
  const [CustomComponent, setCustomComponent] = createSignal<Component<CustomSettingsComponentProps> | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [loadingComponent, setLoadingComponent] = createSignal(true);

  onMount(async () => {
    try {
      const component = await loadCustomComponent(props.componentName);
      if (component) {
        setCustomComponent(() => component);
      } else {
        setLoadError(`Component "${props.componentName}" not found`);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load component');
    } finally {
      setLoadingComponent(false);
    }
  });

  // Create messaging helpers for the custom component
  const sendMessage = async (message: unknown) => {
    console.log('[PluginSettings] sendMessage called:', props.pluginName, message);
    try {
      await electrobun.rpc?.request.pluginSendSettingsMessage({ pluginName: props.pluginName, message });
      console.log('[PluginSettings] sendMessage completed');
    } catch (e) {
      console.error('[PluginSettings] sendMessage error:', e);
    }
  };

  // Message listeners - polling for now
  const messageListeners: ((message: unknown) => void)[] = [];
  const onMessage = (callback: (message: unknown) => void) => {
    messageListeners.push(callback);
  };

  // Poll for messages
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    const pollMessages = async () => {
      try {
        const messages = await electrobun.rpc?.request.pluginGetPendingSettingsMessages({ pluginName: props.pluginName });
        if (messages && messages.length > 0) {
          for (const msg of messages) {
            for (const listener of messageListeners) {
              try {
                listener(msg);
              } catch (e) {
                console.error('Error in message listener:', e);
              }
            }
          }
        }
      } catch (e) {
        console.error('Failed to poll messages:', e);
      }
    };

    pollInterval = setInterval(pollMessages, 200);
  });

  onCleanup(() => {
    if (pollInterval) {
      clearInterval(pollInterval);
    }
  });

  // State helpers
  const getStateValue = async <T = unknown,>(key: string): Promise<T | undefined> => {
    return await electrobun.rpc?.request.pluginGetStateValue({ pluginName: props.pluginName, key }) as T | undefined;
  };

  const setStateValue = async <T = unknown,>(key: string, value: T): Promise<void> => {
    await electrobun.rpc?.request.pluginSetStateValue({ pluginName: props.pluginName, key, value });
  };

  return (
    <div style="margin-top: 16px; border-top: 1px solid #333; padding-top: 16px;">
      <Show when={loadingComponent()}>
        <div style="padding: 16px; text-align: center; color: #888; font-size: 12px;">
          Loading...
        </div>
      </Show>
      <Show when={loadError()}>
        <div style="padding: 16px; color: #ff6b6b; font-size: 12px;">
          Failed to load settings component: {loadError()}
        </div>
      </Show>
      <Show when={!loadingComponent() && !loadError() && CustomComponent()}>
        {(() => {
          const Comp = CustomComponent()!;
          return (
            <Comp
              pluginName={props.pluginName}
              sendMessage={sendMessage}
              onMessage={onMessage}
              getState={getStateValue}
              setState={setStateValue}
            />
          );
        })()}
      </Show>
    </div>
  );
};

interface SettingField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'color' | 'secret';
  default?: string | number | boolean;
  description?: string;
  options?: Array<{ label: string; value: string | number }>;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

interface SettingsSchema {
  title?: string;
  description?: string;
  fields: SettingField[];
  customSettingsComponent?: string;
}

interface EntitlementSummary {
  category: string;
  level: 'low' | 'medium' | 'high';
  icon: string;
  label: string;
  description: string;
}

interface ValidationStatus {
  state: 'idle' | 'validating' | 'valid' | 'invalid';
  message?: string;
}

export const PluginSettings = (): JSXElement => {
  const [schema, setSchema] = createSignal<SettingsSchema | null>(null);
  const [values, setValues] = createSignal<Record<string, string | number | boolean>>({});
  const [entitlements, setEntitlements] = createSignal<EntitlementSummary[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [pluginDisplayName, setPluginDisplayName] = createSignal<string>("");
  const [validationStatuses, setValidationStatuses] = createSignal<Record<string, ValidationStatus>>({});

  // Get the plugin name from settingsPane data
  const getPluginName = () => {
    const data = state.settingsPane.data as { pluginName?: string };
    return data?.pluginName || "";
  };

  const loadSettings = async () => {
    const pluginName = getPluginName();
    if (!pluginName) {
      setLoading(false);
      return;
    }

    try {
      const [schemaResult, valuesResult, entitlementsResult, validationResult] = await Promise.all([
        electrobun.rpc?.request.pluginGetSettingsSchema({ pluginName }),
        electrobun.rpc?.request.pluginGetSettingsValues({ pluginName }),
        electrobun.rpc?.request.pluginGetEntitlements({ pluginName }),
        electrobun.rpc?.request.pluginGetSettingValidationStatuses({ pluginName }),
      ]);

      if (schemaResult) {
        setSchema(schemaResult);
        setPluginDisplayName(schemaResult.title || pluginName);
      }
      if (valuesResult) {
        setValues(valuesResult);
      }
      if (entitlementsResult) {
        setEntitlements(entitlementsResult);
      }
      if (validationResult) {
        setValidationStatuses(validationResult);
      }
    } catch (error) {
      console.error("Failed to load plugin settings:", error);
    } finally {
      setLoading(false);
    }
  };

  // Poll for validation status updates after changing a secret field
  const pollValidationStatus = async (key: string) => {
    const pluginName = getPluginName();
    if (!pluginName) return;

    // Poll every 200ms for up to 10 seconds
    const maxAttempts = 50;
    let attempts = 0;

    const poll = async () => {
      if (attempts >= maxAttempts) return;
      attempts++;

      try {
        const statuses = await electrobun.rpc?.request.pluginGetSettingValidationStatuses({ pluginName });
        if (statuses && statuses[key]) {
          setValidationStatuses(prev => ({ ...prev, [key]: statuses[key] }));

          // Stop polling if we have a final state
          if (statuses[key].state === 'valid' || statuses[key].state === 'invalid') {
            return;
          }
        }
        // Continue polling
        setTimeout(poll, 200);
      } catch (error) {
        console.error("Failed to poll validation status:", error);
      }
    };

    // Start polling after a short delay to let the plugin process
    setTimeout(poll, 100);
  };

  onMount(() => {
    loadSettings();
  });

  const handleValueChange = async (key: string, value: string | number | boolean, isSecret = false) => {
    const pluginName = getPluginName();
    if (!pluginName) return;

    // Update local state immediately
    setValues(prev => ({ ...prev, [key]: value }));

    // For secret fields, show validating state immediately
    if (isSecret && typeof value === 'string' && value.trim()) {
      setValidationStatuses(prev => ({
        ...prev,
        [key]: { state: 'validating', message: 'Validating...' }
      }));
    } else if (isSecret && typeof value === 'string' && !value.trim()) {
      // Clear validation status if value is empty
      setValidationStatuses(prev => ({
        ...prev,
        [key]: { state: 'idle' }
      }));
    }

    // Persist to backend
    try {
      await electrobun.rpc?.request.pluginSetSettingValue({ pluginName, key, value });

      // For secret fields, start polling for validation status
      if (isSecret && typeof value === 'string' && value.trim()) {
        pollValidationStatus(key);
      }
    } catch (error) {
      console.error("Failed to save setting:", error);
      if (isSecret) {
        setValidationStatuses(prev => ({
          ...prev,
          [key]: { state: 'invalid', message: 'Failed to save' }
        }));
      }
    }
  };

  const getValue = (field: SettingField): string | number | boolean => {
    const v = values();
    if (field.key in v) {
      return v[field.key];
    }
    return field.default ?? (field.type === 'boolean' ? false : field.type === 'number' ? 0 : '');
  };

  const onClose = () => {
    setState("settingsPane", { type: "", data: {} });
  };

  return (
    <div
      style="background: #404040; color: #d9d9d9; height: 100vh; overflow: hidden; display: flex; flex-direction: column;"
    >
      <div style="height: 100%; display: flex; flex-direction: column;">
        <div
          class="settings-header"
          style="display: flex; flex-direction: row; height: 45px; font-size: 20px; line-height: 45px; padding: 0 10px; align-items: center;"
        >
          <h1 style="font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-weight: 400;margin: 0 0px 0 0;overflow-x: hidden;text-overflow: ellipsis;white-space: nowrap;padding: 3px 11px;font-size: 20px;line-height: 1.34;">
            {pluginDisplayName() || "Plugin Settings"}
          </h1>
          <div style="flex-grow: 1;"></div>
          <button
            type="button"
            onClick={onClose}
            style="border-color: rgb(54, 54, 54);outline: 0px;cursor: default;-webkit-user-select: none;padding: 0px 12px;font-family: inherit;font-size: 12px;position: relative;display: flex;align-items: center;justify-content: center;height: 32px;border-radius: 2px;color: rgb(235, 235, 235);background: rgb(94, 94, 94);border-width: 1px;border-style: solid;box-sizing: border-box;align-self: center;"
          >
            Close
          </button>
        </div>

        <div style="flex: 1; overflow-y: auto; padding: 0; padding-bottom: 40px;">
          <Show when={loading()}>
            <div style="padding: 20px; text-align: center; color: #999;">
              Loading settings...
            </div>
          </Show>

          <Show when={!loading() && !schema()}>
            <div style="padding: 20px; text-align: center; color: #999;">
              This plugin has no configurable settings.
            </div>
          </Show>

          <Show when={!loading() && schema()}>
            <Show when={schema()?.description}>
              <div style="padding: 16px; color: #999; font-size: 12px; border-bottom: 1px solid #333;">
                {schema()?.description}
              </div>
            </Show>

            <SettingsPaneFormSection label="Settings">
              <For each={schema()?.fields || []}>
                {(field) => (
                  <SettingsPaneField label={field.label}>
                    <Switch>
                      <Match when={field.type === 'boolean'}>
                        <div style="display: flex; align-items: flex-start; gap: 8px;">
                          <input
                            type="checkbox"
                            checked={getValue(field) as boolean}
                            onChange={(e) => handleValueChange(field.key, e.currentTarget.checked)}
                            style="margin-top: 2px; flex-shrink: 0;"
                          />
                          <Show when={field.description}>
                            <span style="font-size: 11px; color: #999; line-height: 1.4;">
                              {field.description}
                            </span>
                          </Show>
                        </div>
                      </Match>

                      <Match when={field.type === 'string'}>
                        <input
                          type="text"
                          value={getValue(field) as string}
                          onInput={(e) => handleValueChange(field.key, e.currentTarget.value)}
                          style="background: #2b2b2b;border-radius: 4px;border: 1px solid #212121;color: #d9d9d9;outline: none;cursor: text;display: block;font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;padding-top: 8px;padding-right: 9px;padding-bottom: 8px;padding-left: 9px;line-height: 14px;width: 100%;box-sizing: border-box;"
                        />
                        <Show when={field.description}>
                          <div style="font-size: 11px; color: #999; margin-top: 4px;">
                            {field.description}
                          </div>
                        </Show>
                      </Match>

                      <Match when={field.type === 'secret'}>
                        <div style="position: relative;">
                          <input
                            type="password"
                            value={getValue(field) as string}
                            placeholder={field.placeholder || '••••••••••••••••'}
                            onInput={(e) => handleValueChange(field.key, e.currentTarget.value, true)}
                            style={{
                              background: '#2b2b2b',
                              'border-radius': '4px',
                              border: validationStatuses()[field.key]?.state === 'valid' ? '1px solid #51cf66' :
                                      validationStatuses()[field.key]?.state === 'invalid' ? '1px solid #ff6b6b' :
                                      validationStatuses()[field.key]?.state === 'validating' ? '1px solid #ff9800' : '1px solid #212121',
                              color: '#d9d9d9',
                              outline: 'none',
                              cursor: 'text',
                              display: 'block',
                              'font-family': "'Fira Code', 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace",
                              'font-size': '12px',
                              'padding-top': '8px',
                              'padding-right': '36px',
                              'padding-bottom': '8px',
                              'padding-left': '9px',
                              'line-height': '14px',
                              width: '100%',
                              'box-sizing': 'border-box',
                            }}
                          />
                          {/* Validation status indicator */}
                          <Show when={validationStatuses()[field.key]?.state && validationStatuses()[field.key]?.state !== 'idle'}>
                            <div style={{
                              position: 'absolute',
                              right: '10px',
                              top: '50%',
                              transform: 'translateY(-50%)',
                              display: 'flex',
                              'align-items': 'center',
                              gap: '4px',
                            }}>
                              <Show when={validationStatuses()[field.key]?.state === 'validating'}>
                                <span style="color: #ff9800; font-size: 14px;">⏳</span>
                              </Show>
                              <Show when={validationStatuses()[field.key]?.state === 'valid'}>
                                <span style="color: #51cf66; font-size: 14px;">✓</span>
                              </Show>
                              <Show when={validationStatuses()[field.key]?.state === 'invalid'}>
                                <span style="color: #ff6b6b; font-size: 14px;">✗</span>
                              </Show>
                            </div>
                          </Show>
                        </div>
                        {/* Validation message */}
                        <Show when={validationStatuses()[field.key]?.message}>
                          <div style={{
                            'font-size': '11px',
                            'margin-top': '4px',
                            color: validationStatuses()[field.key]?.state === 'valid' ? '#51cf66' :
                                   validationStatuses()[field.key]?.state === 'invalid' ? '#ff6b6b' :
                                   validationStatuses()[field.key]?.state === 'validating' ? '#ff9800' : '#999',
                          }}>
                            {validationStatuses()[field.key]?.message}
                          </div>
                        </Show>
                        <Show when={field.description && !validationStatuses()[field.key]?.message}>
                          <div style="font-size: 11px; color: #999; margin-top: 4px;">
                            {field.description}
                          </div>
                        </Show>
                      </Match>

                      <Match when={field.type === 'number'}>
                        <div style="display: flex; flex-direction: column; gap: 8px;">
                          <div style="display: flex; align-items: center; gap: 12px;">
                            <input
                              type="range"
                              min={field.min ?? 0}
                              max={field.max ?? 100}
                              step={field.step ?? 1}
                              value={(getValue(field) as number).toString()}
                              onInput={(e) => handleValueChange(field.key, parseFloat(e.currentTarget.value))}
                              style="flex: 1; accent-color: #0073e6;"
                            />
                            <span style="font-size: 12px; color: #d9d9d9; min-width: 40px; text-align: right;">
                              {getValue(field)}
                            </span>
                          </div>
                          <Show when={field.description}>
                            <div style="font-size: 11px; color: #999;">
                              {field.description}
                            </div>
                          </Show>
                        </div>
                      </Match>

                      <Match when={field.type === 'select'}>
                        <select
                          value={getValue(field) as string | number}
                          onChange={(e) => {
                            const val = e.currentTarget.value;
                            // Try to parse as number if it looks like one
                            const numVal = parseFloat(val);
                            handleValueChange(field.key, isNaN(numVal) ? val : numVal);
                          }}
                          style="background: #2b2b2b; border-radius: 4px; border: 1px solid #212121; color: #d9d9d9; outline: none; cursor: pointer; display: block; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif; font-size: 12px; padding: 8px 9px; line-height: 14px; width: 100%;"
                        >
                          <For each={field.options || []}>
                            {(option) => (
                              <option value={option.value} selected={option.value === getValue(field)}>
                                {option.label}
                              </option>
                            )}
                          </For>
                        </select>
                        <Show when={field.description}>
                          <div style="font-size: 11px; color: #999; margin-top: 4px;">
                            {field.description}
                          </div>
                        </Show>
                      </Match>

                      <Match when={field.type === 'color'}>
                        <div style="display: flex; align-items: center; gap: 8px;">
                          <input
                            type="color"
                            value={getValue(field) as string}
                            onInput={(e) => handleValueChange(field.key, e.currentTarget.value)}
                            style="width: 40px; height: 32px; border: 1px solid #212121; border-radius: 4px; cursor: pointer;"
                          />
                          <input
                            type="text"
                            value={getValue(field) as string}
                            onInput={(e) => handleValueChange(field.key, e.currentTarget.value)}
                            style="background: #2b2b2b;border-radius: 4px;border: 1px solid #212121;color: #d9d9d9;outline: none;font-size: 12px;padding: 8px 9px;flex: 1;"
                          />
                        </div>
                        <Show when={field.description}>
                          <div style="font-size: 11px; color: #999; margin-top: 4px;">
                            {field.description}
                          </div>
                        </Show>
                      </Match>
                    </Switch>
                  </SettingsPaneField>
                )}
              </For>
            </SettingsPaneFormSection>
          </Show>

          {/* Custom Settings Component (lazy loaded) */}
          <Show when={!loading() && schema()?.customSettingsComponent}>
            <CustomSettingsLoader
              componentName={schema()!.customSettingsComponent!}
              pluginName={getPluginName()}
            />
          </Show>

          {/* Entitlements Section */}
          <Show when={!loading() && entitlements().length > 0}>
            <div style="margin-top: 16px; border-top: 1px solid #333; padding-top: 16px;">
              <SettingsPaneFormSection label="Declared Capabilities">
                <div style="padding: 12px 16px;">
                  <div style="background: #2a2a2a; border: 1px solid #444; border-radius: 6px; padding: 12px; margin-bottom: 12px;">
                    <div style="display: flex; align-items: flex-start; gap: 8px; color: #f0ad4e; font-size: 11px;">
                      <span style="font-size: 14px;">⚠️</span>
                      <div>
                        <strong>Trust Notice:</strong> These are capabilities the plugin author declares it needs.
                        They are <em>not enforced</em> by Colab. Only install plugins from sources you trust.
                      </div>
                    </div>
                  </div>

                  <For each={entitlements()}>
                    {(entitlement) => (
                      <div
                        style={{
                          display: "flex",
                          "align-items": "flex-start",
                          gap: "10px",
                          padding: "8px 0",
                          "border-bottom": "1px solid #333",
                        }}
                      >
                        <span style="font-size: 18px; line-height: 1;">{entitlement.icon}</span>
                        <div style="flex: 1;">
                          <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="font-size: 12px; color: #d9d9d9; font-weight: 500;">
                              {entitlement.label}
                            </span>
                            <span
                              style={{
                                "font-size": "10px",
                                padding: "2px 6px",
                                "border-radius": "3px",
                                background: entitlement.level === 'high' ? '#5c2626' :
                                           entitlement.level === 'medium' ? '#4a4026' : '#2a3a2a',
                                color: entitlement.level === 'high' ? '#f87171' :
                                       entitlement.level === 'medium' ? '#fbbf24' : '#86efac',
                              }}
                            >
                              {entitlement.level}
                            </span>
                          </div>
                          <div style="font-size: 11px; color: #888; margin-top: 2px;">
                            {entitlement.description}
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </SettingsPaneFormSection>
            </div>
          </Show>

          {/* No entitlements message */}
          <Show when={!loading() && entitlements().length === 0 && schema()}>
            <div style="margin-top: 16px; border-top: 1px solid #333; padding-top: 16px;">
              <SettingsPaneFormSection label="Declared Capabilities">
                <div style="padding: 12px 16px; color: #888; font-size: 12px;">
                  This plugin has not declared any special capabilities.
                </div>
              </SettingsPaneFormSection>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
};
