import {
  type JSXElement,
  createSignal,
  createEffect,
  onMount,
  batch,
  For,
  Show,
} from "solid-js";
import { state, setState, updateSyncedAppSettings } from "../store";
import {
  SettingsPaneSaveClose,
  SettingsPaneFormSection,
  SettingsPaneField,
  SettingsInputField,
  SettingsReadonlyField,
} from "./forms";
import { aiCompletionService } from "../services/aiCompletionService";
import { electrobun } from "../init";

export const LlamaSettings = (): JSXElement => {
  const [availableModels, setAvailableModels] = createSignal<Array<{
    name: string;
    path: string;
    size: number;
    modified: string;
    source: 'llama' | 'legacy';
  }>>([]);
  const [statusMessage, setStatusMessage] = createSignal<string>("Loading models...");
  const [installingModel, setInstallingModel] = createSignal<string | null>(null);
  const [installProgress, setInstallProgress] = createSignal<string>("");
  const [downloadId, setDownloadId] = createSignal<string | null>(null);
  const [uninstallingModel, setUninstallingModel] = createSignal<string | null>(null);
  const [currentTemperature, setCurrentTemperature] = createSignal(state.appSettings.llama?.temperature || 0.1);
  
  // Popular coding models available for installation
  // Using verified working HF repositories
  const popularModels = [
    {
      name: "Qwen2.5-Coder-7B",
      ref: "hf://Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/qwen2.5-coder-7b-instruct-q4_k_m.gguf",
      size: "4.68GB"
    },
    {
      name: "DeepSeek-Coder-6.7B", 
      ref: "hf://bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf",
      size: "10.4GB"
    },
    {
      name: "CodeLlama-7B",
      ref: "hf://QuantFactory/CodeLlama-7b-Instruct-hf-GGUF/CodeLlama-7b-Instruct-hf.Q4_K_M.gguf", 
      size: "4.1GB"
    },
    {
      name: "StarCoder2-7B",
      ref: "hf://bartowski/starcoder2-7b-GGUF/starcoder2-7b-Q4_K_M.gguf", 
      size: "4.0GB"
    },
    {
      name: "CodeGemma-7B",
      ref: "hf://bartowski/codegemma-7b-it-GGUF/codegemma-7b-it-Q4_K_M.gguf",
      size: "4.1GB"
    },
    {
      name: "Qwen2.5-Coder-14B",
      ref: "hf://Qwen/Qwen2.5-Coder-14B-Instruct-GGUF/qwen2.5-coder-14b-instruct-q4_k_m.gguf", 
      size: "8.5GB"
    },
    {
      name: "Granite-Code-8B",
      ref: "hf://ibm-granite/granite-3.0-8b-instruct-GGUF/granite-3.0-8b-instruct-Q4_K_M.gguf",
      size: "4.7GB"
    },
  ];
  
  let enabledRef: HTMLInputElement | undefined;
  let modelRef: HTMLSelectElement | undefined;
  let temperatureRef: HTMLInputElement | undefined;
  let inlineEnabledRef: HTMLInputElement | undefined;

  const loadAvailableModels = async () => {
    console.log("🔍 Loading available models...");
    setStatusMessage("Loading models...");
    
    try {
      const result = await electrobun.rpc?.request.llamaListModels();
      
      if (result?.ok) {
        batch(() => {
          setAvailableModels(result.models);
          setStatusMessage(`${result.models.length} models available`);
        });
        console.log("📦 Found models:", result.models);
      } else {
        setStatusMessage("Failed to load models");
        console.log("❌ Failed to load models:", result?.error);
      }
    } catch (error) {
      console.log("❌ Error loading models:", error);
      setStatusMessage("Error loading models");
    }
  };

  // Helper function to format file size
  const formatFileSize = (bytes: number): string => {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  // Map actual filenames to friendly display names
  const getModelDisplayName = (filename: string): string => {
    // Create a map from actual filenames to friendly names
    const filenameToFriendlyName: Record<string, string> = {};
    popularModels.forEach(model => {
      const actualFilename = model.ref.split('/').pop() || '';
      filenameToFriendlyName[actualFilename] = model.name;
    });
    
    // If we have a friendly name for this filename, use it
    if (filenameToFriendlyName[filename]) {
      return filenameToFriendlyName[filename];
    }
    
    // Otherwise, return the filename without extension for cleaner display
    return filename.replace('.gguf', '');
  };

  onMount(() => {
    loadAvailableModels();
  });

  const onSubmit = (e: SubmitEvent) => {
    e.preventDefault();
    
    setState("appSettings", "llama", {
      enabled: enabledRef?.checked || false,
      baseUrl: "llama.cpp",
      model: modelRef?.value || "qwen2.5-coder-7b-instruct-q4_k_m",
      temperature: currentTemperature(),
      inlineEnabled: inlineEnabledRef?.checked || false,
    });

    // Persist changes to database
    updateSyncedAppSettings();

    setState("settingsPane", { type: "", data: {} });
  };

  const pollDownloadStatus = async (downloadId: string) => {
    const poll = async () => {
      try {
        const result = await electrobun.rpc?.request.llamaDownloadStatus({ downloadId });
        
        if (result?.ok && result.status) {
          const { status, progress, fileName, error, downloadedBytes, totalBytes } = result.status;
          
          if (status === 'downloading') {
            let progressText = `Downloading ${fileName}... ${progress}%`;
            if (downloadedBytes && totalBytes) {
              const downloadedMB = (downloadedBytes / (1024 * 1024)).toFixed(1);
              const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
              progressText = `Downloading ${fileName}... ${progress}% (${downloadedMB} MB / ${totalMB} MB)`;
            }
            setInstallProgress(progressText);
            // Continue polling
            setTimeout(poll, 1000);
          } else if (status === 'completed') {
            setInstallProgress("Download completed successfully!");
            setTimeout(() => {
              setInstallingModel(null);
              setInstallProgress("");
              setDownloadId(null);
              loadAvailableModels(); // Refresh available models
            }, 1000);
          } else if (status === 'failed') {
            setInstallProgress(`Download failed: ${error || 'Unknown error'}`);
            setTimeout(() => {
              setInstallingModel(null);
              setInstallProgress("");
              setDownloadId(null);
            }, 3000);
          }
        } else {
          // Download status not found, stop polling
          setInstallProgress("Download status unknown");
          setTimeout(() => {
            setInstallingModel(null);
            setInstallProgress("");
            setDownloadId(null);
          }, 2000);
        }
      } catch (error) {
        console.error("Failed to check download status:", error);
        setInstallProgress("Failed to check download status");
        setTimeout(() => {
          setInstallingModel(null);
          setInstallProgress("");
          setDownloadId(null);
        }, 3000);
      }
    };
    
    // Start polling
    setTimeout(poll, 1000);
  };

  const installModel = async (modelName: string, modelRef: string) => {
    setInstallingModel(modelName);
    setInstallProgress("Starting download...");
    
    try {
      const result = await electrobun.rpc?.request.llamaInstallModel({
        modelRef: modelRef
      });

      if (result?.ok) {
        if (result.downloading && result.downloadId) {
          // Start polling for download status
          setDownloadId(result.downloadId);
          setInstallProgress("Download started...");
          pollDownloadStatus(result.downloadId);
        } else if (result.message) {
          // Model already exists
          setInstallProgress(result.message);
          setTimeout(() => {
            setInstallingModel(null);
            setInstallProgress("");
            loadAvailableModels(); // Refresh available models
          }, 1500);
        }
      } else {
        setInstallProgress(`Installation failed: ${result?.error || 'Unknown error'}`);
        setTimeout(() => {
          setInstallingModel(null);
          setInstallProgress("");
        }, 3000);
      }
    } catch (error) {
      console.error("Failed to start installation:", error);
      setInstallProgress("Failed to start installation");
      setTimeout(() => {
        setInstallingModel(null);
        setInstallProgress("");
      }, 3000);
    }
  };

  const uninstallModel = async (modelPath: string, modelName: string) => {
    setUninstallingModel(modelName);
    
    try {
      const result = await electrobun.rpc?.request.llamaRemoveModel({
        modelPath: modelPath
      });

      if (result?.ok) {
        setTimeout(() => {
          setUninstallingModel(null);
          loadAvailableModels(); // Refresh available models
        }, 1000);
      } else {
        setTimeout(() => {
          setUninstallingModel(null);
        }, 2000);
      }
    } catch (error) {
      console.error("Failed to uninstall model:", error);
      setTimeout(() => {
        setUninstallingModel(null);
      }, 2000);
    }
  };

  return (
    <div
      style="background: #404040; color: #d9d9d9; height: 100vh; overflow: hidden; display: flex; flex-direction: column;"
    >
      <form onSubmit={onSubmit} style="height: 100%; display: flex; flex-direction: column;">
        <SettingsPaneSaveClose label="AI Model Settings" />
        
        <div style="flex: 1; overflow-y: auto; padding: 0; margin-bottom: 60px;">
          <SettingsPaneFormSection label="Status">
            <SettingsPaneField label="Models">
              <div style="background: #202020; padding: 8px; color: #d9d9d9; font-size: 12px; border-radius: 4px;">
                Status: <span style="background: #2b2b2b; padding: 4px 8px; margin-left: 8px; border-radius: 2px;">{statusMessage()}</span>
              </div>
              <div style="margin-top: 8px; font-size: 11px; color: #999;">
                Models are managed locally using llama.cpp. No external service required.
              </div>
            </SettingsPaneField>
          </SettingsPaneFormSection>

          <SettingsPaneFormSection label="Model Configuration">
            <SettingsPaneField label="Model">
              <select
                ref={modelRef}
                name="model"
                value={state.appSettings.llama.model}
                style="background: #2b2b2b; border-radius: 4px; border: 1px solid #212121; color: #d9d9d9; outline: none; cursor: pointer; display: block; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif; font-size: 12px; padding: 8px 9px; line-height: 14px; width: 100%;"
              >
                {availableModels().length > 0 ? (
                  availableModels().map(model => (
                    <option value={model.name} selected={model.name === state.appSettings.llama.model}>
                      {model.name} ({model.source === 'llama' ? 'llama.cpp' : 'legacy'}, {formatFileSize(model.size)})
                    </option>
                  ))
                ) : (
                  <option value={state.appSettings.llama.model}>
                    {state.appSettings.llama.model} (not available)
                  </option>
                )}
              </select>
              <div style="font-size: 11px; color: #999; margin-top: 4px;">
                The model to use for code completion. {availableModels().length === 0 ? "No models detected - install models below." : `${availableModels().length} model${availableModels().length === 1 ? '' : 's'} available.`}
              </div>
            </SettingsPaneField>
            
            <SettingsPaneField label="Temperature">
              <div style="display: flex; flex-direction: column; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 12px;">
                  <input
                    ref={temperatureRef}
                    type="range"
                    name="temperature"
                    min="0"
                    max="2"
                    step="0.1"
                    value={currentTemperature().toString()}
                    onInput={(e) => setCurrentTemperature(parseFloat(e.currentTarget.value))}
                    style="flex: 1; accent-color: #0073e6;"
                  />
                  <span style="font-size: 12px; color: #d9d9d9; min-width: 32px; text-align: right;">
                    {currentTemperature().toFixed(1)}
                  </span>
                </div>
                <div style="font-size: 11px; color: #999; margin-top: 4px;">
                  0.0-0.3: Focused (good for code) • 0.4-0.7: Balanced • 0.8-1.0: Creative • 1.0+: Very random
                </div>
              </div>
            </SettingsPaneField>
          </SettingsPaneFormSection>

          <SettingsPaneFormSection label="AI Assistance Features">
            <SettingsPaneField label="Enable AI">
              <div style="display: flex; align-items: flex-start; gap: 8px;">
                <input
                  ref={enabledRef}
                  type="checkbox"
                  name="enabled"
                  checked={state.appSettings.llama.enabled}
                  style="margin-top: 2px; flex-shrink: 0;"
                />
                <span style="font-size: 12px; line-height: 1.4;">Enable AI assistance</span>
              </div>
            </SettingsPaneField>
            
            <SettingsPaneField label="Inline Suggestions">
              <div style="display: flex; align-items: flex-start; gap: 8px;">
                <input
                  ref={inlineEnabledRef}
                  type="checkbox"
                  name="inlineEnabled"
                  checked={state.appSettings.llama.inlineEnabled}
                  style="margin-top: 2px; flex-shrink: 0;"
                />
                <span style="font-size: 12px; line-height: 1.4;">Show inline AI suggestions while typing</span>
              </div>
            </SettingsPaneField>
            
          </SettingsPaneFormSection>

          <SettingsPaneFormSection label="Installed Models">
            <Show 
              when={availableModels().length > 0}
              fallback={
                <SettingsPaneField label="">
                  <div style="padding: 12px; background: #2b2b2b; border-radius: 4px; text-align: center;">
                    <span style="font-size: 12px; color: #999;">
                      No models installed. Install models below to get started.
                    </span>
                  </div>
                </SettingsPaneField>
              }
            >
              <SettingsPaneField label="">
                <div style="display: flex; flex-direction: column; gap: 6px;">
                  <For each={availableModels()}>
                    {(model) => {
                      const isUninstalling = uninstallingModel() === model.name;
                      
                      return (
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: #2b2b2b; border-radius: 4px;">
                          <div style="display: flex; flex-direction: column;">
                            <span style="font-size: 12px; color: #d9d9d9; font-weight: 500;">
                              {getModelDisplayName(model.name)}
                            </span>
                            <span style="font-size: 10px; color: #999; margin-top: 2px;">
                              {formatFileSize(model.size)} • Source: {model.source}
                            </span>
                          </div>
                          <div>
                            {isUninstalling ? (
                              <div style="display: flex; align-items: center; gap: 4px;">
                                <div style="width: 12px; height: 12px; border: 1px solid #666; border-top: 1px solid #fff; border-radius: 50%; animation: spin 1s linear infinite;"></div>
                                <span style="font-size: 10px; color: #ff6b6b;">Removing...</span>
                              </div>
                            ) : model.source === 'llama' ? (
                              <button
                                type="button"
                                onClick={() => uninstallModel(model.path, model.name)}
                                style="background: #ff6b6b; color: white; border: none; padding: 4px 12px; border-radius: 3px; cursor: pointer; font-size: 11px;"
                                disabled={uninstallingModel() !== null}
                              >
                                Remove
                              </button>
                            ) : (
                              <span style="font-size: 10px; color: #666; padding: 4px 8px; background: #1a1a1a; border-radius: 3px;">
                                Legacy managed
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </SettingsPaneField>
            </Show>
          </SettingsPaneFormSection>

          <SettingsPaneFormSection label="Available Models">
            <Show when={installingModel()}>
              <SettingsPaneField label="">
                <div style="padding: 12px; background: #1a1a1a; border: 1px solid #333; border-radius: 4px; margin-bottom: 8px;">
                  <div style="font-size: 12px; color: #ffa500; display: flex; align-items: center; gap: 8px;">
                    <div style="width: 16px; height: 16px; border: 2px solid #333; border-top: 2px solid #ffa500; border-radius: 50%; animation: spin 1s linear infinite;"></div>
                    <span>{installProgress() || `Installing ${installingModel()}...`}</span>
                  </div>
                </div>
              </SettingsPaneField>
            </Show>
            <SettingsPaneField label="">
              <div style="display: flex; flex-direction: column; gap: 6px;">
                <For each={popularModels}>
                  {(model) => {
                    // Extract actual filename from the ref URL and remove .gguf extension
                    const expectedFileName = model.ref.split('/').pop() || '';
                    const expectedModelName = expectedFileName.replace('.gguf', '');
                    const isInstalled = () => availableModels().some(m => 
                      m.source === 'llama' && m.name === expectedModelName
                    );
                    const isInstalling = () => installingModel() === model.name;
                    
                    return (
                      <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: #2b2b2b; border-radius: 4px;">
                        <div style="display: flex; flex-direction: column;">
                          <span style="font-size: 12px; color: #d9d9d9; font-weight: 500;">
                            {model.name}
                          </span>
                          <span style="font-size: 10px; color: #999; margin-top: 2px;">
                            {model.size} • Hugging Face model
                          </span>
                        </div>
                        <div>
                          {isInstalling() ? (
                            <div style="display: flex; align-items: center; gap: 6px;">
                              <div style="width: 12px; height: 12px; border: 1px solid #666; border-top: 1px solid #fff; border-radius: 50%; animation: spin 1s linear infinite;"></div>
                              <span style="font-size: 10px; color: #ffa500;">Installing...</span>
                            </div>
                          ) : isInstalled() ? (
                            <span style="font-size: 10px; color: #51cf66; padding: 4px 12px; background: #1a4a1a; border-radius: 3px;">
                              ✓ Installed
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => installModel(model.name, model.ref)}
                              style="background: #0073e6; color: white; border: none; padding: 4px 12px; border-radius: 3px; cursor: pointer; font-size: 11px;"
                              disabled={installingModel() !== null}
                            >
                              Install
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </SettingsPaneField>
          </SettingsPaneFormSection>
        </div>
      </form>
    </div>
  );
};