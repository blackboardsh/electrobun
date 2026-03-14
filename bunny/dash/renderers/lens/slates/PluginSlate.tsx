import { createSignal, onMount, onCleanup, Show, type Component } from "solid-js";
import { render } from "solid-js/web";
import { electrobun } from "../init";
import { state } from "../store";
import type { CachedFileType, FolderNodeType } from "../../../shared/types/types";
import { waitForPluginRenderers } from "./pluginSlateRegistry";

export interface PluginSlateInfo {
  id: string;
  pluginName: string;
  name: string;
  description?: string;
  icon?: string;
  patterns: string[];
  folderHandler?: boolean;
}

interface PluginSlateProps {
  node?: CachedFileType | FolderNodeType;
  slateInfo: PluginSlateInfo;
}

/**
 * Registry of slate components that can be rendered by plugins.
 * Plugins register their slate patterns in the main process, but the actual
 * SolidJS components live here in the renderer and are looked up by slate ID.
 *
 * Format: "pluginName.slateId" -> Component
 */
type SlateComponentProps = {
  node?: CachedFileType | FolderNodeType;
  slateInfo: PluginSlateInfo;
  instanceId: string;
};

type SlateComponent = Component<SlateComponentProps>;

const slateComponentRegistry: Map<string, SlateComponent> = new Map();

/**
 * Register a SolidJS component for a plugin slate.
 * Call this from the renderer to associate a component with a slate ID.
 *
 * @param slateId - Full slate ID (e.g., "webflow-plugin.devlink")
 * @param component - SolidJS component to render
 */
export function registerSlateComponent(slateId: string, component: SlateComponent): void {
  slateComponentRegistry.set(slateId, component);
  console.log(`[PluginSlate] Registered component for slate: ${slateId}`);
}

/**
 * Unregister a slate component
 */
export function unregisterSlateComponent(slateId: string): void {
  slateComponentRegistry.delete(slateId);
}

/**
 * Get a registered slate component
 */
export function getSlateComponent(slateId: string): SlateComponent | undefined {
  return slateComponentRegistry.get(slateId);
}

/**
 * PluginSlate - A generic container for plugin-provided slates
 *
 * This component:
 * 1. Looks up a registered SolidJS component for the slate ID
 * 2. Provides a mount point for the component
 * 3. Notifies the plugin when the slate mounts/unmounts
 * 4. Renders the component into the mount point
 */
export const PluginSlate = (props: PluginSlateProps) => {
  const [instanceId, setInstanceId] = createSignal<string | null>(null);
  const [isLoading, setIsLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [useHtmlRendering, setUseHtmlRendering] = createSignal(false);
  const [pendingRenders, setPendingRenders] = createSignal<Array<{ html?: string; script?: string }>>([]);

  let mountRef: HTMLDivElement | undefined;
  let htmlMountRef: HTMLDivElement | undefined;
  let disposeComponent: (() => void) | null = null;

  // Apply pending renders to the HTML mount point
  const applyPendingRenders = () => {
    const renders = pendingRenders();
    const currentInstanceId = instanceId();
    console.log(`[PluginSlate] applyPendingRenders called:`, {
      hasHtmlMountRef: !!htmlMountRef,
      rendersLength: renders.length,
      currentInstanceId,
    });
    if (!htmlMountRef || renders.length === 0 || !currentInstanceId) return;

    for (const renderData of renders) {
      console.log(`[PluginSlate] Applying render:`, { html: renderData.html?.substring(0, 100), hasScript: !!renderData.script });
      if (renderData.html !== undefined) {
        htmlMountRef.innerHTML = renderData.html;

        // Set up colabSlate API for the script to use
        // Provide both sendEvent and a scoped getElementById that searches within the slate
        const slateRoot = htmlMountRef;
        (window as any).colabSlate = {
          sendEvent: (eventType: string, payload: unknown) => {
            electrobun.rpc?.request.pluginSlateEvent({
              instanceId: currentInstanceId,
              eventType,
              payload,
            });
          },
          getElementById: (id: string) => slateRoot?.querySelector(`#${id}`),
          querySelector: (selector: string) => slateRoot?.querySelector(selector),
          querySelectorAll: (selector: string) => slateRoot?.querySelectorAll(selector),
          root: slateRoot,
        };

        // Execute the script if provided
        if (renderData.script) {
          try {
            // Wrap script to provide scoped document functions
            const wrappedScript = `
              const getElementById = window.colabSlate.getElementById;
              const querySelector = window.colabSlate.querySelector;
              const querySelectorAll = window.colabSlate.querySelectorAll;
              ${renderData.script}
            `;
            const scriptFn = new Function(wrappedScript);
            scriptFn();
          } catch (e) {
            console.error("[PluginSlate] Error executing slate script:", e);
          }
        }
      }
    }
    setPendingRenders([]);
  };

  // Handler for HTML-based slate rendering from plugins
  const handleSlateRender = (event: CustomEvent<{ instanceId: string; html?: string; script?: string }>) => {
    const { instanceId: eventInstanceId, html, script } = event.detail;
    const currentInstanceId = instanceId();

    if (eventInstanceId !== currentInstanceId || !htmlMountRef) {
      return;
    }

    // Render the HTML content
    if (html !== undefined) {
      htmlMountRef.innerHTML = html;

      // Set up colabSlate API for the script to use
      (window as any).colabSlate = {
        sendEvent: (eventType: string, payload: unknown) => {
          electrobun.rpc?.request.pluginSlateEvent({
            instanceId: currentInstanceId,
            eventType,
            payload,
          });
        },
      };

      // Execute the script if provided
      if (script) {
        try {
          const scriptFn = new Function(script);
          scriptFn();
        } catch (e) {
          console.error("[PluginSlate] Error executing slate script:", e);
        }
      }
    }
  };

  onMount(async () => {
    if (!props.node?.path) {
      setError("No node path provided");
      setIsLoading(false);
      return;
    }

    // Wait for plugin renderers to be loaded before checking registry
    await waitForPluginRenderers();

    // Look up the component for this slate
    const SlateComponent = slateComponentRegistry.get(props.slateInfo.id);

    // If no SolidJS component registered, use HTML-based rendering
    const htmlMode = !SlateComponent;
    setUseHtmlRendering(htmlMode);

    if (htmlMode) {
      console.log(`[PluginSlate] Using HTML-based rendering for slate: ${props.slateInfo.id}`);
      // Listen for slateRender events
      window.addEventListener('slateRender', handleSlateRender as EventListener);
    }

    try {
      // Notify the plugin that a slate is mounting
      const result = await electrobun.rpc?.request.pluginMountSlate({
        slateId: props.slateInfo.id,
        filePath: props.node.path,
        windowId: state.windowId,
      });

      const newInstanceId = result?.instanceId || `local-${Date.now()}`;
      setInstanceId(newInstanceId);

      console.log(`[PluginSlate] Mount result:`, {
        instanceId: newInstanceId,
        initialRenders: result?.initialRenders,
        initialRendersLength: result?.initialRenders?.length,
        htmlMode,
      });

      // For HTML mode, store initial renders BEFORE setting isLoading to false
      // This ensures pendingRenders is set when the ref callback fires
      if (htmlMode && result?.initialRenders && result.initialRenders.length > 0) {
        setPendingRenders(result.initialRenders);
      }

      // Now set loading to false, which triggers the re-render and mounts the HTML element
      setIsLoading(false);

      // For SolidJS component mode, render the component into the mount point
      if (!htmlMode && mountRef && SlateComponent) {
        disposeComponent = render(
          () => (
            <SlateComponent
              node={props.node}
              slateInfo={props.slateInfo}
              instanceId={newInstanceId}
            />
          ),
          mountRef
        );
      }
    } catch (e) {
      console.error("[PluginSlate] Error mounting slate:", e);
      setError(`Failed to mount slate: ${e}`);
      setIsLoading(false);
    }
  });

  onCleanup(async () => {
    // Remove event listener for HTML mode
    if (useHtmlRendering()) {
      window.removeEventListener('slateRender', handleSlateRender as EventListener);
    }

    // Dispose the rendered component
    if (disposeComponent) {
      disposeComponent();
      disposeComponent = null;
    }

    // Notify the plugin that the slate is unmounting
    const currentInstanceId = instanceId();
    if (currentInstanceId && !currentInstanceId.startsWith('local-')) {
      try {
        await electrobun.rpc?.request.pluginUnmountSlate({
          instanceId: currentInstanceId,
        });
      } catch (e) {
        console.error("[PluginSlate] Error unmounting slate:", e);
      }
    }
  });

  return (
    <div class="plugin-slate" style={{ height: "100%", overflow: "auto" }}>
      <Show when={isLoading()}>
        <div style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          height: "100%",
          color: "var(--text-secondary)",
        }}>
          Loading {props.slateInfo.name}...
        </div>
      </Show>

      <Show when={error()}>
        <div style={{
          display: "flex",
          "flex-direction": "column",
          "align-items": "center",
          "justify-content": "center",
          height: "100%",
          color: "var(--error)",
          padding: "20px",
        }}>
          <div style={{ "font-weight": "bold", "margin-bottom": "10px" }}>
            Error loading {props.slateInfo.name}
          </div>
          <div style={{ color: "var(--text-secondary)", "font-size": "12px" }}>
            {error()}
          </div>
        </div>
      </Show>

      <Show when={!isLoading() && !error()}>
        {/* SolidJS component mount point */}
        <Show when={!useHtmlRendering()}>
          <div
            ref={mountRef}
            class="plugin-slate-mount"
            style={{ height: "100%" }}
          />
        </Show>
        {/* HTML-based rendering mount point */}
        <Show when={useHtmlRendering()}>
          <div
            ref={(el) => {
              htmlMountRef = el;
              // Apply any pending renders now that the element is ready
              if (pendingRenders().length > 0) {
                applyPendingRenders();
              }
            }}
            class="plugin-slate-html-mount"
            style={{ height: "100%" }}
          />
        </Show>
      </Show>
    </div>
  );
};

export default PluginSlate;
