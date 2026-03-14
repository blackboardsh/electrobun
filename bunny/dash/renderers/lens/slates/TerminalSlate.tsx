import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { produce } from "solid-js/store";
import { type TerminalTabType, getWindow, setState, openNewTabForNode } from "../store";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { electrobun } from "../init";

export const TerminalSlate = ({ tabId }: { tabId: string }) => {
  const tab = () => getWindow()?.tabs[tabId] as TerminalTabType | undefined;
  const [terminalId, setTerminalId] = createSignal<string | null>(null);
  const [currentDir, setCurrentDir] = createSignal<string | null>(null);
  
  let terminalElement: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let webglAddon: WebglAddon | null = null;
  let searchAddon: SearchAddon | null = null;
  let cwdUpdateTimeout: ReturnType<typeof setTimeout> | null = null;
  const [showSearch, setShowSearch] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");

  // Function to update current directory from the terminal process (debounced)
  const updateCurrentDir = async () => {
    const id = terminalId();
    if (!id) {
      return;
    }

    try {
      const cwd = await electrobun.rpc?.request.getTerminalCwd({ terminalId: id });

      if (cwd && cwd !== currentDir()) {
        setCurrentDir(cwd);

        // Update the tab title with the new directory
        setState(
          produce((_state) => {
            const win = getWindow(_state);
            if (win && win.tabs[tabId]) {
              // Store the current directory in the tab for the title
              (win.tabs[tabId] as any).currentDir = cwd;
            }
          })
        );
      }
    } catch (error) {
      console.error('Failed to get terminal cwd:', error);
    }
  };

  const initializeTerminal = async () => {
    if (!terminalElement) return;

    const _tab = tab();
    if (!_tab) return;

    try {
      // Create terminal in bun process
      const id = await electrobun.rpc?.request.createTerminal({
        cwd: _tab.cwd || "/",
        shell: _tab.cmd,
      });

      if (!id) {
        console.error("Failed to create terminal");
        return;
      }

      setTerminalId(id);

      // Store the terminal ID in the tab for cleanup
      setState(
        produce((_state) => {
          const win = getWindow(_state);
          if (win && win.tabs[tabId]) {
            win.tabs[tabId].terminalId = id;
          }
        })
      );
      
      // Initial update of current directory
      setTimeout(updateCurrentDir, 1000);

      // Create xterm terminal
      terminal = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Monaco, "Courier New", monospace',
        theme: {
          background: "#000005",
          foreground: "#888888",
        },
        scrollback: 10000,
        convertEol: true,
      });

      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      
      // Add web links addon - require Alt+click or Cmd+click to open URLs
      const webLinksAddon = new WebLinksAddon(
        (event: MouseEvent, uri: string) => {
          // Only open if Alt or Cmd/Meta is held
          if (event.altKey || event.metaKey) {
            event.preventDefault();
            openNewTabForNode('__COLAB_INTERNAL__/web', false, { focusNewTab: true, url: uri });
          }
        },
        {
          hover: (event: MouseEvent, uri: string, range) => {
            // Remove any existing tooltip first
            document.querySelector('.colab-link-tooltip')?.remove();

            // Show tooltip explaining how to open the link
            const tooltip = document.createElement('div');
            tooltip.className = 'colab-link-tooltip';
            tooltip.textContent = `⌘+click or ⌥+click to open: ${uri.length > 50 ? uri.slice(0, 50) + '...' : uri}`;
            tooltip.style.cssText = `
              position: fixed;
              left: ${event.clientX + 10}px;
              top: ${event.clientY + 10}px;
              background: #1e1e1e;
              color: #ccc;
              padding: 4px 8px;
              border-radius: 4px;
              font-size: 12px;
              z-index: 10000;
              pointer-events: none;
              border: 1px solid #444;
              max-width: 400px;
              word-break: break-all;
            `;
            document.body.appendChild(tooltip);
          },
          leave: () => {
            // Remove tooltip when mouse leaves the link
            document.querySelector('.colab-link-tooltip')?.remove();
          },
        }
      );
      terminal.loadAddon(webLinksAddon);

      // Add search addon
      searchAddon = new SearchAddon();
      terminal.loadAddon(searchAddon);

      terminal.open(terminalElement);
      fitAddon.fit();

      // Load WebGL addon for better performance
      try {
        webglAddon = new WebglAddon();
        terminal.loadAddon(webglAddon);
      } catch (error) {
        console.warn("WebGL addon failed to load:", error);
      }

      // Handle custom keyboard shortcuts
      terminal.attachCustomKeyEventHandler((event) => {
        // Cmd+Enter or Shift+Enter: Multi-line command continuation with backslash
        if (event.key === 'Enter' && (event.metaKey || event.shiftKey) && !event.ctrlKey) {
          event.preventDefault();
          if (terminalId()) {
            electrobun.rpc?.request.writeToTerminal({
              terminalId: terminalId()!,
              data: ' \\\n', // Backslash for line continuation, then newline
            });
          }
          return false;
        }

        // Cmd+K: Clear terminal
        if (event.key === 'k' && event.metaKey && !event.shiftKey && !event.ctrlKey) {
          event.preventDefault();
          terminal?.clear();
          // Also send clear command to the shell
          if (terminalId()) {
            electrobun.rpc?.request.writeToTerminal({
              terminalId: terminalId()!,
              data: '\x0c', // Form feed character (clear screen)
            });
          }
          return false;
        }

        // Cmd+F: Open search
        if (event.key === 'f' && event.metaKey && !event.shiftKey && !event.ctrlKey) {
          event.preventDefault();
          setShowSearch(true);
          setTimeout(() => searchInputRef?.focus(), 0);
          return false;
        }

        // Escape: Close search
        if (event.key === 'Escape' && showSearch()) {
          event.preventDefault();
          setShowSearch(false);
          setSearchQuery("");
          searchAddon?.clearDecorations();
          terminal?.focus();
          return false;
        }

        // Cmd+G: Find next, Cmd+Shift+G: Find previous
        if (event.key === 'g' && event.metaKey && showSearch() && searchQuery()) {
          event.preventDefault();
          if (event.shiftKey) {
            searchAddon?.findPrevious(searchQuery(), { caseSensitive: false, regex: false });
          } else {
            searchAddon?.findNext(searchQuery(), { caseSensitive: false, regex: false });
          }
          return false;
        }

        // Return true to allow xterm to handle other keys normally
        return true;
      });

      // Handle user input
      terminal.onData((data) => {
        if (terminalId()) {
          electrobun.rpc?.request.writeToTerminal({
            terminalId: terminalId()!,
            data,
          });

          // Check for cwd change after user presses Enter (debounced)
          if (data === '\r' || data === '\n') {
            if (cwdUpdateTimeout) {
              clearTimeout(cwdUpdateTimeout);
            }
            cwdUpdateTimeout = setTimeout(updateCurrentDir, 500);
          }
        }
      });

      // Handle resize
      terminal.onResize(({ cols, rows }) => {
        if (terminalId()) {
          electrobun.rpc?.request.resizeTerminal({
            terminalId: terminalId()!,
            cols,
            rows,
          });
        }
      });

      // Handle container resize
      const resizeObserver = new ResizeObserver((entries) => {
        // Only call fit() if the element has valid dimensions
        // This prevents resizing to tiny dimensions when the tab is hidden
        const entry = entries[0];
        if (entry && entry.contentRect.width > 50 && entry.contentRect.height > 50) {
          fitAddon?.fit();
        }
      });
      resizeObserver.observe(terminalElement);

      onCleanup(() => {
        resizeObserver.disconnect();
      });

    } catch (error) {
      console.error("Failed to initialize terminal:", error);
    }
  };

  onMount(() => {
    // Initialize the terminal
    initializeTerminal();

    // Set up CustomEvent listeners for terminal messages
    const handleTerminalOutput = (event: CustomEvent<{ terminalId: string; data: string }>) => {
      const data = event.detail;
      if (data.terminalId === terminalId() && terminal) {
        terminal.write(data.data);
      }
    };

    const handleTerminalExit = (event: CustomEvent<{ terminalId: string; exitCode: number }>) => {
      const data = event.detail;
      if (data.terminalId === terminalId() && terminal) {
        terminal.write(`\r\n\x1b[31mProcess exited with code ${data.exitCode}\x1b[0m\r\n`);
      }
    };

    // Listen for terminal messages via CustomEvents
    window.addEventListener('terminalOutput', handleTerminalOutput as EventListener);
    window.addEventListener('terminalExit', handleTerminalExit as EventListener);

    onCleanup(() => {
      // Remove event listeners
      window.removeEventListener('terminalOutput', handleTerminalOutput as EventListener);
      window.removeEventListener('terminalExit', handleTerminalExit as EventListener);

      // Clear pending cwd update
      if (cwdUpdateTimeout) {
        clearTimeout(cwdUpdateTimeout);
      }

      // Clean up terminal resources
      if (terminalId()) {
        electrobun.rpc?.request.killTerminal({
          terminalId: terminalId()!,
        });
      }
      terminal?.dispose();
      fitAddon?.dispose();
      webglAddon?.dispose();
    });
  });

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (query && searchAddon) {
      searchAddon.findNext(query, { caseSensitive: false, regex: false });
    } else {
      searchAddon?.clearDecorations();
    }
  };

  const handleSearchKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || (e.key === 'g' && e.metaKey)) {
      e.preventDefault();
      if (e.shiftKey) {
        searchAddon?.findPrevious(searchQuery(), { caseSensitive: false, regex: false });
      } else {
        searchAddon?.findNext(searchQuery(), { caseSensitive: false, regex: false });
      }
    } else if (e.key === 'Escape') {
      setShowSearch(false);
      setSearchQuery("");
      searchAddon?.clearDecorations();
      terminal?.focus();
    }
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        padding: "8px",
        "background-color": "#000005",
        position: "relative",
      }}
    >
      <Show when={showSearch()}>
        <div
          style={{
            position: "absolute",
            top: "8px",
            right: "16px",
            "z-index": "100",
            display: "flex",
            gap: "4px",
            "align-items": "center",
          }}
        >
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search..."
            value={searchQuery()}
            onInput={(e) => handleSearch(e.currentTarget.value)}
            onKeyDown={handleSearchKeyDown}
            style={{
              padding: "4px 8px",
              "border-radius": "4px",
              border: "1px solid #444",
              "background-color": "#1e1e1e",
              color: "#fff",
              "font-size": "13px",
              width: "200px",
              outline: "none",
            }}
          />
          <button
            onClick={() => searchAddon?.findPrevious(searchQuery(), { caseSensitive: false, regex: false })}
            style={{
              padding: "4px 8px",
              "border-radius": "4px",
              border: "1px solid #444",
              "background-color": "#2d2d2d",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            ↑
          </button>
          <button
            onClick={() => searchAddon?.findNext(searchQuery(), { caseSensitive: false, regex: false })}
            style={{
              padding: "4px 8px",
              "border-radius": "4px",
              border: "1px solid #444",
              "background-color": "#2d2d2d",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            ↓
          </button>
          <button
            onClick={() => {
              setShowSearch(false);
              setSearchQuery("");
              searchAddon?.clearDecorations();
              terminal?.focus();
            }}
            style={{
              padding: "4px 8px",
              "border-radius": "4px",
              border: "1px solid #444",
              "background-color": "#2d2d2d",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
      </Show>
      <div
        ref={terminalElement}
        style={{
          width: "100%",
          height: "100%",
        }}
      />
    </div>
  );
};