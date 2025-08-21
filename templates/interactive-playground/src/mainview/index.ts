import Electrobun, { Electroview } from "electrobun/view";
import { type PlaygroundRPC } from "../bun/types/rpc";

// Import components
import { Sidebar } from "./components/Sidebar";
import { EventLog } from "./components/EventLog";
import { Toast } from "./components/Toast";

// Import demos
import { WindowDemo } from "./demos/WindowDemo";
import { RPCDemo } from "./demos/RPCDemo";
import { MenuDemo } from "./demos/MenuDemo";
import { TrayDemo } from "./demos/TrayDemo";
import { FileDemo } from "./demos/FileDemo";
import { WebViewDemo } from "./demos/WebViewDemo";

class InteractivePlayground {
  private electrobun: any;
  private sidebar: Sidebar;
  private eventLog: EventLog;
  private demos: Map<string, any> = new Map();

  constructor() {
    console.log("🎮 Initializing Interactive Playground...");

    // Set up RPC
    const rpc = Electroview.defineRPC<PlaygroundRPC>({
      maxRequestTime: 10000,
      handlers: {
        requests: {},
        messages: {
          // Window events
          windowCreated: (data) => {
            this.eventLog.addEntry('info', `Window created: ${data.title}`, data);
            this.demos.get('windows')?.onWindowCreated(data);
            Toast.success(`Window created: ${data.title}`);
          },
          
          windowClosed: (data) => {
            this.eventLog.addEntry('info', `Window closed: ${data.id}`, data);
            this.demos.get('windows')?.onWindowClosed(data);
            Toast.info(`Window ${data.id} closed`);
          },
          
          windowFocused: (data) => {
            this.eventLog.addEntry('info', `Window focused: ${data.id}`, data);
            this.demos.get('windows')?.onWindowFocused(data);
          },

          // Tray events
          trayClicked: (data) => {
            this.eventLog.addEntry('info', `Tray clicked: ${data.action}`, data);
            this.demos.get('tray')?.onTrayClicked?.(data);
            Toast.info(`Tray action: ${data.action}`);
          },

          // Menu events
          menuClicked: (data) => {
            this.eventLog.addEntry('info', `Menu clicked: ${data.action}`, data);
            this.demos.get('menus')?.onMenuClicked?.(data);
            Toast.info(`Menu action: ${data.action}`);
          },

          // File events
          fileSelected: (data) => {
            this.eventLog.addEntry('info', `Files selected: ${data.paths.length} files`, data);
            this.demos.get('files')?.onFileSelected(data);
            Toast.success(`Selected ${data.paths.length} file(s)`);
          },

          // RPC test results
          rpcTestResult: (data) => {
            this.eventLog.addEntry('info', `RPC test completed: ${data.operation}`, data);
            this.demos.get('rpc')?.onRpcTestResult(data);
          },

          // System events
          systemEvent: (data) => {
            this.eventLog.addEntry('info', `System event: ${data.type}`, data);
            Toast.info(`System: ${data.type}`);
          },


          // Log messages
          logMessage: (data) => {
            this.eventLog.addEntry(data.level, data.message);
            if (data.level === 'error') {
              Toast.error(data.message);
            } else if (data.level === 'warn') {
              Toast.warning(data.message);
            } else {
              Toast.info(data.message);
            }
          },
        },
      },
    });

    // Create Electroview instance
    this.electrobun = new Electrobun.Electroview({ rpc });

    // Initialize components
    this.sidebar = new Sidebar();
    this.eventLog = new EventLog();

    // Initialize demos
    this.initializeDemos();

    // Set up event listeners
    this.setupEventListeners();

    // Load initial demo
    this.loadDemo('windows');

    console.log("✅ Interactive Playground initialized");
  }

  private initializeDemos() {
    this.demos.set('windows', new WindowDemo());
    this.demos.set('rpc', new RPCDemo());
    this.demos.set('menus', new MenuDemo());
    this.demos.set('tray', new TrayDemo());
    this.demos.set('files', new FileDemo());
    this.demos.set('webviews', new WebViewDemo());
    // Add more demos as they're implemented
  }

  private setupEventListeners() {
    this.sidebar.onDemoChangeCallback((demo) => {
      this.loadDemo(demo);
    });

    // Global error handling
    window.addEventListener('error', (event) => {
      this.eventLog.addEntry('error', event.message, {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      });
      Toast.error(`JavaScript Error: ${event.message}`);
    });

    // Unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      this.eventLog.addEntry('error', `Unhandled Promise Rejection: ${event.reason}`, event.reason);
      Toast.error('Unhandled Promise Rejection');
    });
  }

  private loadDemo(demoName: string) {
    const content = document.getElementById('demo-content');
    if (!content) return;

    // CRITICAL: Cleanup any existing webviews before switching demos
    // This prevents crashes when CEF tries to clean up stale webview references
    this.cleanupWebviews();

    const demo = this.demos.get(demoName);
    if (!demo) {
      content.innerHTML = this.renderPlaceholderDemo(demoName);
      return;
    }

    // Render demo content
    content.innerHTML = demo.render();

    // Initialize demo with RPC
    if (demo.initialize) {
      demo.initialize(this.electrobun.rpc);
    }

    this.eventLog.addEntry('info', `Loaded demo: ${demoName}`);
  }

  private cleanupWebviews() {
    // Find all webview elements and properly remove them
    const webviews = document.querySelectorAll('electrobun-webview');
    
    webviews.forEach((webview: any) => {
      try {
        // Call the native remove method if it exists
        if (typeof webview.remove === 'function') {
          webview.remove();
        }
      } catch (error) {
        console.warn('Error during webview cleanup:', error);
      }
    });

    // Additional safety: clear any webview-related event listeners
    // This helps prevent memory leaks and stale references
    webviews.forEach((webview: any) => {
      try {
        if (typeof webview.removeAllEventListeners === 'function') {
          webview.removeAllEventListeners();
        }
      } catch (error) {
        // Silently ignore if method doesn't exist
      }
    });
  }

  private renderPlaceholderDemo(demoName: string): string {
    const demoInfo: Record<string, { icon: string; title: string; description: string }> = {
      menus: { icon: '🎛️', title: 'Menu Systems', description: 'Application and context menus' },
      tray: { icon: '🔔', title: 'System Tray', description: 'Tray icon management' },
      files: { icon: '🗂️', title: 'File Operations', description: 'File dialogs and system integration' },
      webviews: { icon: '🌐', title: 'WebView Features', description: 'Advanced webview capabilities' }
    };

    const info = demoInfo[demoName] || { icon: '🔧', title: 'Coming Soon', description: 'This demo is under development' };

    return `
      <div class="demo-section">
        <div class="demo-header">
          <span class="demo-icon">${info.icon}</span>
          <div>
            <h2 class="demo-title">${info.title}</h2>
            <p class="demo-description">${info.description}</p>
          </div>
        </div>
        
        <div class="demo-controls">
          <div style="text-align: center; padding: 3rem; color: #718096;">
            <h3>Coming Soon!</h3>
            <p>This demo is currently under development.</p>
            <p>Check back soon for interactive examples of ${info.title.toLowerCase()}.</p>
          </div>
        </div>
      </div>
    `;
  }
}

// Initialize the playground when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new InteractivePlayground();
});