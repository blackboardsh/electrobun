import { BrowserWindow, Tray } from "electrobun/bun";
import type { TestRPCSchema } from "./index";

export interface TestCase {
  id: string;
  name: string;
  category: string;
  type: 'auto' | 'manual' | 'hybrid';
  description?: string;
  setup: () => Promise<void> | void;
  cleanup?: () => Promise<void> | void;
  verify?: () => boolean; // Only for 'auto' tests
  instructions?: string[]; // For 'manual' tests
  status: 'pending' | 'running' | 'passed' | 'failed';
  lastResult?: { success: boolean; message?: string; timestamp: number };
}

export class TestRunner {
  private tests = new Map<string, TestCase>();
  private mainWindow: BrowserWindow | null = null;
  private testWindows: BrowserWindow[] = [];
  private trayInstance: Tray | null = null;
  private trayWindow: BrowserWindow | null = null;
  
  constructor() {
    this.registerAllTests();
  }
  
  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }
  
  initialize() {
    console.log(`Registered ${this.tests.size} tests`);
    
    // Send initial test list to UI
    if (this.mainWindow) {
      setTimeout(() => {
        this.mainWindow!.webview.rpc?.send.updateStatus({
          testId: 'init',
          status: 'ready',
          details: `${this.tests.size} tests loaded`
        });
      }, 1000);
    }
  }
  
  private registerAllTests() {
    // Window Management Tests
    this.registerTest({
      id: 'window-creation',
      name: 'Window Creation',
      category: 'Windows',
      type: 'auto',
      description: 'Test creating and destroying windows',
      setup: async () => {
        const testWindow = new BrowserWindow({
          title: 'Test Window',
          frame: { width: 400, height: 300, x: 200, y: 200 },
          url: 'views://testviews/window-create.html'
        });
        
        this.testWindows.push(testWindow);
        
        // Auto-pass after window creation
        setTimeout(() => {
          this.markTestPassed('window-creation', 'Window created successfully');
          testWindow.close();
        }, 2000);
      }
    });
    
    this.registerTest({
      id: 'window-events',
      name: 'Window Move & Resize Events',
      category: 'Windows',
      type: 'auto',
      description: 'Test window event detection',
      setup: async () => {
        const testWindow = new BrowserWindow({
          title: 'Move and Resize Me!',
          frame: { width: 500, height: 400, x: 300, y: 200 },
          url: 'views://testviews/window-events.html'
        });
        
        this.testWindows.push(testWindow);
        
        let moveDetected = false;
        let resizeDetected = false;
        
        testWindow.on('move', ({data}) => {          
          // if (!moveDetected) {
            moveDetected = true;
            const x = data?.x || 'unknown';
            const y = data?.y || 'unknown';
            testWindow.webview.executeJavascript(`
              document.getElementById('events').innerHTML = '<div>✅ Move detected: (${x}, ${y})</div>';
            `);
            this.updateTestStatus('window-events', moveDetected && resizeDetected);
          // }
        });
        
        testWindow.on('resize', ({data}) => {
          // if (!resizeDetected) {
            resizeDetected = true;
            const width = data?.width || 'unknown';
            const height = data?.height || 'unknown';
            testWindow.webview.executeJavascript(`
              document.getElementById('events').innerHTML = '<div>✅ Resize detected: ${width}x${height}</div>';
            `);
            this.updateTestStatus('window-events', moveDetected && resizeDetected);
          // }
        });
        
        testWindow.on('close', () => {
          if (moveDetected && resizeDetected) {
            this.markTestPassed('window-events', 'Both move and resize events detected');
          } else {
            this.markTestFailed('window-events', `Missing events - Move: ${moveDetected}, Resize: ${resizeDetected}`);
          }
        });
      }
    });
    
    // WebView Tests
    this.registerTest({
      id: 'webview-mask-layer',
      name: 'WebView Mask Layer',
      category: 'WebViews',
      type: 'manual',
      instructions: [
        'A window will open with a WebView and a RED overlay button',
        'Scroll the window up and down',
        'Verify the RED button ALWAYS stays on top of the WebView',
        'The button should NEVER disappear behind the WebView content',
        'Click PASS if the button stays on top, FAIL if it goes behind'
      ],
      setup: async () => {
        const maskTestWindow = new BrowserWindow({
          title: 'Mask Test - SCROLL TO TEST',
          frame: { width: 700, height: 500, x: 400, y: 100 },
          url: 'views://testviews/webview-mask.html'
        });
        
        this.testWindows.push(maskTestWindow);
      }
    });
    
    this.registerTest({
      id: 'webview-navigation',
      name: 'WebView Navigation',
      category: 'WebViews',
      type: 'hybrid',
      instructions: [
        'A WebView will load example.com',
        'Verify the page content loads correctly',
        'Try navigating to different URLs if possible',
        'Check that navigation events are detected (shown below)'
      ],
      setup: async () => {
        const navTestWindow = new BrowserWindow({
          title: 'WebView Navigation Test',
          frame: { width: 800, height: 600, x: 200, y: 150 },
          url: 'views://testviews/webview-navigation.html'
        });
        
        this.testWindows.push(navTestWindow);
        
        // Auto-detect navigation events
        navTestWindow.webview.on('did-navigate', ({data: {detail: url}}) => {          
          navTestWindow.webview.executeJavascript(`
            document.getElementById('nav-events').innerHTML += 
              '<div>✅ Navigation: ${url} at ' + new Date().toLocaleTimeString() + '</div>';
          `);
          this.markTestPassed('webview-navigation', `Navigation detected to: ${url}`);
        });
      }
    });
    
    // System Integration Tests
    this.registerTest({
      id: 'system-tray',
      name: 'System Tray',
      category: 'System',
      type: 'manual',
      instructions: [
        'Look for a test tray icon in your system tray/menu bar',
        'Click the tray icon to open the menu',
        'Try clicking "Test Item 1" and "Test Item 2"',
        'Try the submenu items',
        'Verify menu items work and events are logged below'
      ],
      setup: async () => {
        this.trayInstance = new Tray({
          title: "Test",
          image: ""
        });
        
        // Set up tray event listener
        this.trayInstance.on('tray-clicked', (eventData) => {
          console.log('Tray clicked:', eventData);
          // TODO: Note: trim() is currently necessary even though nothing is being trimmed.
          // Could be an issue with this version of bun or something else.
          const action = eventData?.data?.action?.trim();
          
          switch (action) {
            case 'test-item-1':
              this.logTrayEvent("Test Item 1 clicked");
              break;
            case 'test-item-2':
              this.logTrayEvent("Test Item 2 clicked");
              break;
            case 'submenu-item-a':
              this.logTrayEvent("Submenu Item A clicked");
              break;
            case 'submenu-item-b':
              this.logTrayEvent("Submenu Item B clicked");
              break;
            case 'mark-passed':
              this.markTestPassed('system-tray', 'User confirmed tray functionality works');
              break;
            default:
              console.log(`Unknown tray action: "${action}"`);
          }
        });
        
        // Set the menu separately
        this.trayInstance.setMenu([
          {
            type: "normal",
            label: "Test Item 1",
            action: "test-item-1"
          },
          {
            type: "normal",
            label: "Test Item 2", 
            action: "test-item-2"
          },
          { type: "separator" },
          {
            type: "normal",
            label: "Submenu Test",
            submenu: [
              {
                type: "normal",
                label: "Submenu Item A",
                action: "submenu-item-a"
              },
              {
                type: "normal",
                label: "Submenu Item B",
                action: "submenu-item-b"
              }
            ]
          },
          { type: "separator" },
          {
            type: "normal",
            label: "Mark Tray Test as Passed",
            action: "mark-passed"
          }
        ]);
        
        // Show tray test window with instructions
        this.trayWindow = new BrowserWindow({
          title: 'Tray Test Instructions',
          frame: { width: 500, height: 400, x: 100, y: 300 },
          url: 'views://testviews/tray-test.html'
        });
        
        this.testWindows.push(this.trayWindow);
      },
      cleanup: async () => {
        if (this.trayInstance) {
          this.trayInstance.remove();
          this.trayInstance = null;
        }
        this.trayWindow = null;
      }
    });
    
    // Multi-window test
    this.registerTest({
      id: 'multi-window',
      name: 'Multi-Window Management',
      category: 'Windows',
      type: 'manual',
      instructions: [
        'Multiple windows will be created',
        'Try focusing different windows by clicking on them',
        'Verify window focus changes are detected',
        'Try overlapping and arranging windows',
        'Check that each window behaves independently'
      ],
      setup: async () => {
        // Create multiple test windows
        for (let i = 1; i <= 3; i++) {
          const testWindow = new BrowserWindow({
            title: `Test Window ${i}`,
            frame: { 
              width: 300, 
              height: 250, 
              x: 200 + (i * 50), 
              y: 200 + (i * 50) 
            },
            url: `views://testviews/window-focus.html?num=${i}`
          });
          
          this.testWindows.push(testWindow);
          
          let focusCount = 0;
          testWindow.on('focus', () => {
            focusCount++;
            testWindow.webview.executeJavascript(`
              document.getElementById('focus-status').textContent = 'Focused';
              document.getElementById('focus-count').textContent = 'Focus events: ${focusCount}';
              document.body.style.borderLeft = '5px solid green';
            `);
          });
          
          testWindow.on('blur', () => {
            testWindow.webview.executeJavascript(`
              document.getElementById('focus-status').textContent = 'Not Focused';
              document.body.style.borderLeft = '5px solid gray';
            `);
          });
        }
        
        // Auto-pass after windows are created
        setTimeout(() => {
          this.markTestPassed('multi-window', 'Multiple windows created successfully');
        }, 1000);
      }
    });
  }
  
  private registerTest(test: Omit<TestCase, 'status' | 'lastResult'>) {
    this.tests.set(test.id, {
      ...test,
      status: 'pending'
    });
  }
  
  async runTest(testId: string): Promise<{ success: boolean; message: string }> {
    const test = this.tests.get(testId);
    if (!test) {
      return { success: false, message: `Test ${testId} not found` };
    }
    
    test.status = 'running';
    this.notifyStatusChange(testId);
    
    try {
      await test.setup();
      
      if (test.type === 'auto' && test.verify) {
        const result = test.verify();
        if (result) {
          this.markTestPassed(testId, 'Auto-verification passed');
        } else {
          this.markTestFailed(testId, 'Auto-verification failed');
        }
      }
      
      return { success: true, message: `Test ${testId} setup completed` };
    } catch (error) {
      console.error(`Test ${testId} failed:`, error);
      this.markTestFailed(testId, `Setup failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }
  
  markManualTestResult(testId: string, passed: boolean, notes?: string) {
    if (passed) {
      this.markTestPassed(testId, notes || 'Manual verification passed');
    } else {
      this.markTestFailed(testId, notes || 'Manual verification failed');
    }
  }
  
  private markTestPassed(testId: string, message: string) {
    const test = this.tests.get(testId);
    if (test) {
      test.status = 'passed';
      test.lastResult = { success: true, message, timestamp: Date.now() };
      this.notifyStatusChange(testId);
      console.log(`✅ Test PASSED: ${test.name} - ${message}`);
    }
  }
  
  private markTestFailed(testId: string, message: string) {
    const test = this.tests.get(testId);
    if (test) {
      test.status = 'failed';
      test.lastResult = { success: false, message, timestamp: Date.now() };
      this.notifyStatusChange(testId);
      console.log(`❌ Test FAILED: ${test.name} - ${message}`);
    }
  }
  
  private updateTestStatus(testId: string, success: boolean) {
    if (success) {
      this.markTestPassed(testId, 'All conditions met');
    }
  }
  
  private notifyStatusChange(testId: string) {
    if (this.mainWindow) {
      const test = this.tests.get(testId);
      this.mainWindow.webview.rpc?.send.updateStatus({
        testId,
        status: test?.status || 'unknown',
        details: test?.lastResult?.message
      });
    }
  }
  
  private logTrayEvent(message: string) {
    console.log(`Tray event: ${message}`);
    // Use the stored tray window reference
    if (this.trayWindow) {
      try {
        // Add a small delay to ensure the DOM is ready and use a more robust approach
        setTimeout(() => {
          this.trayWindow?.webview.executeJavascript(`
            console.log('Trying to update tray events with: ${message}');
            
            // Wait for DOM to be ready
            function updateTrayEvents() {
              const eventsDiv = document.getElementById('tray-events');
              console.log('Found tray-events div:', eventsDiv);
              
              if (eventsDiv) {
                const eventHtml = '<div class="event-item">✅ ${message} at ' + new Date().toLocaleTimeString() + '</div>';
                console.log('Adding event HTML:', eventHtml);
                eventsDiv.innerHTML += eventHtml;
                console.log('Updated tray events successfully');
              } else {
                console.error('tray-events element not found in tray window');
                // Try to find any element with id containing 'tray'
                const allElements = document.querySelectorAll('[id*="tray"]');
                console.log('Elements with tray in id:', allElements);
              }
            }
            
            if (document.readyState === 'loading') {
              document.addEventListener('DOMContentLoaded', updateTrayEvents);
            } else {
              updateTrayEvents();
            }
          `);
        }, 100);
      } catch (error) {
        console.error('Failed to update tray window:', error);
      }
    } else {
      console.error('Tray window not available');
    }
  }
  
  getAllTestStatus() {
    return Array.from(this.tests.values()).map(test => ({
      id: test.id,
      name: test.name,
      category: test.category,
      type: test.type,
      status: test.status,
      description: test.description,
      instructions: test.instructions,
      lastResult: test.lastResult
    }));
  }
  
  async cleanup() {
    console.log('Cleaning up test runner...');
    
    // Close all test windows
    for (const window of this.testWindows) {
      try {
        window.close();
      } catch (e) {
        // Window might already be closed
      }
    }
    this.testWindows = [];
    
    // Remove tray
    if (this.trayInstance) {
      this.trayInstance.remove();
      this.trayInstance = null;
    }
    
    // Run individual test cleanup
    for (const test of this.tests.values()) {
      if (test.cleanup) {
        try {
          await test.cleanup();
        } catch (e) {
          console.warn(`Cleanup failed for test ${test.id}:`, e);
        }
      }
      
      // Reset test status to pending
      test.status = 'pending';
      delete test.lastResult;
    }
  }
}