/**
 * Colab Terminal Web Component
 *
 * A web component that provides a full PTY terminal experience.
 * Can be used by plugins in their slates via <colab-terminal>.
 *
 * Usage:
 *   <colab-terminal cwd="/path/to/dir"></colab-terminal>
 *
 *   // Get reference and run commands
 *   const terminal = document.querySelector('colab-terminal');
 *   terminal.run('npm install');
 *   terminal.run('npm run dev');
 *
 * Attributes:
 *   - cwd: Working directory for the terminal (required)
 *   - shell: Optional shell to use (defaults to system shell)
 *
 * Methods:
 *   - run(command: string): Queue and run a command (adds newline automatically)
 *   - write(data: string): Write raw data to stdin (no newline added)
 *   - clear(): Clear the terminal screen
 *   - kill(): Kill the terminal process
 *   - focus(): Focus the terminal
 *   - isReady(): Check if terminal is initialized
 *
 * Events:
 *   - terminal-ready: Fired when terminal is initialized with { terminalId }
 *   - terminal-exit: Fired when process exits with { exitCode }
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

// We need to access electrobun RPC - it's set on window by the init script
declare global {
  interface Window {
    electrobun?: {
      rpc?: {
        request: {
          createTerminal: (params: { cwd: string; shell?: string }) => Promise<string>;
          writeToTerminal: (params: { terminalId: string; data: string }) => Promise<boolean>;
          resizeTerminal: (params: { terminalId: string; cols: number; rows: number }) => Promise<boolean>;
          killTerminal: (params: { terminalId: string }) => Promise<boolean>;
        };
      };
    };
  }
}

export class ColabTerminal extends HTMLElement {
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private terminalId: string | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private container: HTMLDivElement | null = null;
  private isInitialized = false;

  // Command queue - commands are queued until terminal is ready
  private commandQueue: string[] = [];
  private isProcessingQueue = false;

  // Bound event handlers for cleanup
  private boundHandleOutput: ((event: Event) => void) | null = null;
  private boundHandleExit: ((event: Event) => void) | null = null;

  // Properties that can be set directly (for frameworks like SolidJS/React)
  private _cwd: string = '/';
  private _shell: string | undefined = undefined;

  static get observedAttributes() {
    return ['cwd', 'shell'];
  }

  // Property getters/setters for cwd
  get cwd(): string {
    return this._cwd;
  }
  set cwd(value: string) {
    this._cwd = value || '/';
  }

  // Property getters/setters for shell
  get shell(): string | undefined {
    return this._shell;
  }
  set shell(value: string | undefined) {
    this._shell = value;
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
    this.initTerminal();
  }

  disconnectedCallback() {
    this.cleanup();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue === newValue) return;

    // Sync attributes to properties
    if (name === 'cwd') {
      this._cwd = newValue || '/';
    } else if (name === 'shell') {
      this._shell = newValue || undefined;
    }
  }

  private render() {
    if (!this.shadowRoot) return;

    // Add xterm.js CSS
    const style = document.createElement('style');
    style.textContent = `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        min-height: 200px;
      }
      .terminal-container {
        width: 100%;
        height: 100%;
        background-color: #0a0a0a;
        border-radius: 4px;
        overflow: hidden;
      }
      .terminal-container .xterm {
        padding: 8px;
        height: 100%;
      }
      .terminal-container .xterm-viewport {
        overflow-y: auto !important;
      }
      /* Import xterm base styles */
      .xterm {
        cursor: text;
        position: relative;
        user-select: none;
        -ms-user-select: none;
        -webkit-user-select: none;
      }
      .xterm.focus,
      .xterm:focus {
        outline: none;
      }
      .xterm .xterm-helpers {
        position: absolute;
        top: 0;
        z-index: 5;
      }
      .xterm .xterm-helper-textarea {
        padding: 0;
        border: 0;
        margin: 0;
        position: absolute;
        opacity: 0;
        left: -9999em;
        top: 0;
        width: 0;
        height: 0;
        z-index: -5;
        white-space: nowrap;
        overflow: hidden;
        resize: none;
      }
      .xterm .composition-view {
        background: #000;
        color: #FFF;
        display: none;
        position: absolute;
        white-space: nowrap;
        z-index: 1;
      }
      .xterm .composition-view.active {
        display: block;
      }
      .xterm .xterm-viewport {
        background-color: #000;
        overflow-y: scroll;
        cursor: default;
        position: absolute;
        right: 0;
        left: 0;
        top: 0;
        bottom: 0;
      }
      .xterm .xterm-screen {
        position: relative;
      }
      .xterm .xterm-screen canvas {
        position: absolute;
        left: 0;
        top: 0;
      }
      .xterm .xterm-scroll-area {
        visibility: hidden;
      }
      .xterm-char-measure-element {
        display: inline-block;
        visibility: hidden;
        position: absolute;
        top: 0;
        left: -9999em;
        line-height: normal;
      }
      .xterm.enable-mouse-events {
        cursor: default;
      }
      .xterm.xterm-cursor-pointer,
      .xterm .xterm-cursor-pointer {
        cursor: pointer;
      }
      .xterm.column-select.focus {
        cursor: crosshair;
      }
      .xterm .xterm-accessibility,
      .xterm .xterm-message {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        right: 0;
        z-index: 10;
        color: transparent;
      }
      .xterm .live-region {
        position: absolute;
        left: -9999px;
        width: 1px;
        height: 1px;
        overflow: hidden;
      }
      .xterm-dim {
        opacity: 0.5;
      }
      .xterm-underline-1 { text-decoration: underline; }
      .xterm-underline-2 { text-decoration: double underline; }
      .xterm-underline-3 { text-decoration: wavy underline; }
      .xterm-underline-4 { text-decoration: dotted underline; }
      .xterm-underline-5 { text-decoration: dashed underline; }
      .xterm-strikethrough {
        text-decoration: line-through;
      }
      .xterm-screen .xterm-decoration-container .xterm-decoration {
        z-index: 6;
        position: absolute;
      }
      .xterm-decoration-overview-ruler {
        z-index: 7;
        position: absolute;
        top: 0;
        right: 0;
        pointer-events: none;
      }
      .xterm-decoration-top {
        z-index: 2;
        position: relative;
      }
    `;
    this.shadowRoot.appendChild(style);

    // Create container
    this.container = document.createElement('div');
    this.container.className = 'terminal-container';
    this.shadowRoot.appendChild(this.container);
  }

  private async initTerminal() {
    if (this.isInitialized || !this.container) return;
    this.isInitialized = true;

    // Use properties (set via property or attribute)
    // Also check getAttribute as fallback for when attributes are set directly in HTML
    const cwd = this._cwd || this.getAttribute('cwd') || '/';
    const shell = this._shell || this.getAttribute('shell') || undefined;

    console.log('[ColabTerminal] initTerminal with cwd:', cwd);

    try {
      // Create terminal in main process via RPC
      const electrobun = window.electrobun;
      if (!electrobun?.rpc) {
        console.error('[ColabTerminal] electrobun RPC not available');
        return;
      }

      const terminalId = await electrobun.rpc.request.createTerminal({
        cwd,
        shell,
      });

      if (!terminalId) {
        console.error('[ColabTerminal] Failed to create terminal');
        return;
      }

      this.terminalId = terminalId;

      // Create xterm instance
      this.terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Monaco, "Courier New", monospace',
        theme: {
          background: "#0a0a0a",
          foreground: "#d9d9d9",
          cursor: "#d9d9d9",
          cursorAccent: "#0a0a0a",
          selectionBackground: "#4353ff55",
        },
        scrollback: 5000,
        convertEol: true,
      });

      // Add fit addon
      this.fitAddon = new FitAddon();
      this.terminal.loadAddon(this.fitAddon);

      // Add web links addon - require Alt+click or Cmd+click to open URLs
      const webLinksAddon = new WebLinksAddon(
        (event: MouseEvent, uri: string) => {
          // Only open if Alt or Cmd/Meta is held
          if (event.altKey || event.metaKey) {
            event.preventDefault();
            window.open(uri, '_blank');
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
      this.terminal.loadAddon(webLinksAddon);

      // Open terminal in container
      this.terminal.open(this.container);

      // Fit after a short delay to ensure container has dimensions
      requestAnimationFrame(() => {
        this.fitAddon?.fit();
      });

      // Handle user input
      this.terminal.onData((data) => {
        if (this.terminalId) {
          electrobun.rpc?.request.writeToTerminal({
            terminalId: this.terminalId,
            data,
          });
        }
      });

      // Handle resize
      this.terminal.onResize(({ cols, rows }) => {
        if (this.terminalId) {
          electrobun.rpc?.request.resizeTerminal({
            terminalId: this.terminalId,
            cols,
            rows,
          });
        }
      });

      // Observe container resize
      this.resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry && entry.contentRect.width > 50 && entry.contentRect.height > 50) {
          this.fitAddon?.fit();
        }
      });
      this.resizeObserver.observe(this.container);

      // Listen for terminal output
      this.boundHandleOutput = (event: Event) => {
        const customEvent = event as CustomEvent<{ terminalId: string; data: string }>;
        if (customEvent.detail.terminalId === this.terminalId && this.terminal) {
          this.terminal.write(customEvent.detail.data);
        }
      };
      window.addEventListener('terminalOutput', this.boundHandleOutput);

      // Listen for terminal exit
      this.boundHandleExit = (event: Event) => {
        const customEvent = event as CustomEvent<{ terminalId: string; exitCode: number }>;
        if (customEvent.detail.terminalId === this.terminalId) {
          this.terminal?.write(`\r\n\x1b[90mProcess exited with code ${customEvent.detail.exitCode}\x1b[0m\r\n`);
          this.dispatchEvent(new CustomEvent('terminal-exit', {
            detail: { exitCode: customEvent.detail.exitCode },
            bubbles: true,
          }));
        }
      };
      window.addEventListener('terminalExit', this.boundHandleExit);

      // Dispatch ready event
      this.dispatchEvent(new CustomEvent('terminal-ready', {
        detail: { terminalId },
        bubbles: true,
      }));

      // Process any queued commands after shell is ready
      setTimeout(() => {
        this.processQueue();
      }, 100);

    } catch (error) {
      console.error('[ColabTerminal] Failed to initialize:', error);
    }
  }

  /** Process queued commands */
  private async processQueue() {
    if (this.isProcessingQueue || !this.terminalId) return;
    this.isProcessingQueue = true;

    while (this.commandQueue.length > 0) {
      const command = this.commandQueue.shift();
      if (command && window.electrobun?.rpc) {
        await window.electrobun.rpc.request.writeToTerminal({
          terminalId: this.terminalId,
          data: command,
        });
      }
    }

    this.isProcessingQueue = false;
  }

  private cleanup() {
    // Remove event listeners
    if (this.boundHandleOutput) {
      window.removeEventListener('terminalOutput', this.boundHandleOutput);
    }
    if (this.boundHandleExit) {
      window.removeEventListener('terminalExit', this.boundHandleExit);
    }

    // Kill terminal process
    if (this.terminalId && window.electrobun?.rpc) {
      window.electrobun.rpc.request.killTerminal({ terminalId: this.terminalId });
    }

    // Cleanup observers
    this.resizeObserver?.disconnect();

    // Dispose xterm
    this.fitAddon?.dispose();
    this.terminal?.dispose();

    this.terminal = null;
    this.fitAddon = null;
    this.terminalId = null;
    this.isInitialized = false;
  }

  // Public API

  /**
   * Run a command in the terminal.
   * Adds a newline automatically. Commands are queued if terminal isn't ready yet.
   */
  run(command: string) {
    this.commandQueue.push(command + '\n');
    this.processQueue();
  }

  /**
   * Write raw data to the terminal stdin.
   * No newline is added. Data is queued if terminal isn't ready yet.
   */
  write(data: string) {
    this.commandQueue.push(data);
    this.processQueue();
  }

  /** Clear the terminal screen */
  clear() {
    this.terminal?.clear();
  }

  /** Kill the terminal process */
  kill() {
    if (this.terminalId && window.electrobun?.rpc) {
      window.electrobun.rpc.request.killTerminal({ terminalId: this.terminalId });
    }
  }

  /** Focus the terminal */
  focus() {
    this.terminal?.focus();
  }

  /** Get the terminal ID */
  getTerminalId(): string | null {
    return this.terminalId;
  }

  /** Check if terminal is ready */
  isReady(): boolean {
    return this.terminalId !== null;
  }
}

// Register the web component
export function registerColabTerminal() {
  if (!customElements.get('colab-terminal')) {
    customElements.define('colab-terminal', ColabTerminal);
  }
}
