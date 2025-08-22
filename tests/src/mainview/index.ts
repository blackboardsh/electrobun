import { Electroview } from "electrobun/view";
import type { TestRPCSchema } from "../bun/index";

interface TestData {
  id: string;
  name: string;
  category: string;
  type: 'auto' | 'manual' | 'hybrid';
  status: 'pending' | 'running' | 'passed' | 'failed';
  description?: string;
  instructions?: string[];
  lastResult?: { success: boolean; message?: string; timestamp: number };
}

class TestHarnessUI {
  private electroview: Electroview<TestRPCSchema>;
  private tests = new Map<string, TestData>();
  private logContainer: HTMLElement;
  
  constructor() {
    this.electroview = new Electroview({
      rpc: Electroview.defineRPC<TestRPCSchema>({
        handlers: {
          requests: {
            markTestResult: async ({ testId, passed, notes }) => {
              this.handleManualTestResult(testId, passed, notes);
              return { acknowledged: true };
            }
          },
          messages: {
            showInstructions: ({ testId, instructions }) => {
              this.showInstructions(testId, instructions);
            },
            updateStatus: ({ testId, status, details }) => {
              this.updateTestStatus(testId, status, details);
            }
          }
        }
      })
    });
    
    this.logContainer = document.getElementById('event-log-content')!;
    this.initialize();
  }
  
  private async initialize() {
    this.log('Initializing test harness UI...');
    
    // Set platform info
    this.updatePlatformInfo();
    
    // Set up event listeners
    this.setupEventListeners();
    
    // Load tests from backend
    await this.loadTests();
    
    this.log('Test harness UI ready', 'info');
  }
  
  private updatePlatformInfo() {
    const platformEl = document.getElementById('platform-name');
    const userAgent = navigator.userAgent;
    let platform = 'Unknown';
    
    if (userAgent.includes('Mac')) {
      platform = 'macOS';
    } else if (userAgent.includes('Win')) {
      platform = 'Windows';
    } else if (userAgent.includes('Linux')) {
      platform = 'Linux';
    }
    
    if (platformEl) {
      platformEl.textContent = `Platform: ${platform}`;
    }
  }
  
  private setupEventListeners() {
    // Run all tests button
    document.getElementById('run-all-btn')?.addEventListener('click', () => {
      this.runAllTests();
    });
    
    // Cleanup button
    document.getElementById('cleanup-btn')?.addEventListener('click', () => {
      this.cleanup();
    });
    
    // Category filters
    const filters = document.querySelectorAll('#category-filters input[type="checkbox"]');
    filters.forEach(filter => {
      filter.addEventListener('change', () => {
        this.filterTests();
      });
    });
    
    // Modal close
    document.querySelector('.modal-close')?.addEventListener('click', () => {
      this.closeModal();
    });
    
    document.getElementById('test-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        this.closeModal();
      }
    });
  }
  
  private async loadTests() {
    try {
      const response = await this.electroview.rpc.request.getTestStatus({});
      
      for (const testData of response.tests) {
        this.tests.set(testData.id, testData);
      }
      
      this.renderTests();
      this.updateStatusCounts();
      this.log(`Loaded ${response.tests.length} tests`);
    } catch (error) {
      this.log(`Failed to load tests: ${error.message}`, 'error');
    }
  }
  
  private renderTests() {
    const autoContainer = document.getElementById('auto-tests-container')!;
    const manualContainer = document.getElementById('manual-tests-container')!;
    const hybridContainer = document.getElementById('hybrid-tests-container')!;
    
    // Clear containers
    autoContainer.innerHTML = '';
    manualContainer.innerHTML = '';
    hybridContainer.innerHTML = '';
    
    for (const test of this.tests.values()) {
      const testElement = this.createTestElement(test);
      
      switch (test.type) {
        case 'auto':
          autoContainer.appendChild(testElement);
          break;
        case 'manual':
          manualContainer.appendChild(testElement);
          break;
        case 'hybrid':
          hybridContainer.appendChild(testElement);
          break;
      }
    }
  }
  
  private createTestElement(test: TestData): HTMLElement {
    const card = document.createElement('div');
    card.className = `test-card ${test.type} ${test.status}`;
    card.id = `test-${test.id}`;
    
    const statusIcon = this.getStatusIcon(test.status, test.type);
    const typeIcon = this.getTypeIcon(test.type);
    
    card.innerHTML = `
      <div class="test-header">
        <div>
          <div class="test-title">${typeIcon} ${test.name}</div>
          <div class="test-meta">
            <span class="test-badge">${test.category}</span>
            <span class="test-badge">${test.type}</span>
          </div>
        </div>
        <div class="test-actions">
          ${test.status === 'pending' || test.status === 'failed' ? 
            `<button class="btn btn-run" onclick="testUI.runTest('${test.id}')">Run Test</button>` : 
            ''}
        </div>
      </div>
      
      ${test.description ? `<div class="test-description">${test.description}</div>` : ''}
      
      <div class="test-status">
        <span class="status-indicator">${statusIcon}</span>
        <span class="status-text">${this.getStatusText(test.status)}</span>
        ${test.lastResult?.message ? 
          `<span class="status-details">- ${test.lastResult.message}</span>` : 
          ''}
      </div>
      
      ${test.type === 'manual' || test.type === 'hybrid' ? this.createInstructionsHTML(test) : ''}
      
      ${test.type === 'manual' ? this.createManualVerifyHTML(test) : ''}
    `;
    
    return card;
  }
  
  private createInstructionsHTML(test: TestData): string {
    if (!test.instructions || test.instructions.length === 0) {
      return '';
    }
    
    return `
      <div class="test-instructions">
        <h4>Instructions:</h4>
        <ol>
          ${test.instructions.map(instruction => `<li>${instruction}</li>`).join('')}
        </ol>
      </div>
    `;
  }
  
  private createManualVerifyHTML(test: TestData): string {
    if (test.status === 'passed' || test.status === 'failed') {
      return '';
    }
    
    return `
      <div class="manual-verify">
        <span class="manual-verify-text">Did this test work correctly?</span>
        <button class="btn btn-success" onclick="testUI.markTestPassed('${test.id}')">✅ Pass</button>
        <button class="btn btn-danger" onclick="testUI.markTestFailed('${test.id}')">❌ Fail</button>
      </div>
    `;
  }
  
  private getStatusIcon(status: string, type: string): string {
    switch (status) {
      case 'passed': return '✅';
      case 'failed': return '❌';
      case 'running': return '⏳';
      default: return '⚪';
    }
  }
  
  private getTypeIcon(type: string): string {
    switch (type) {
      case 'auto': return '🤖';
      case 'manual': return '👁️';
      case 'hybrid': return '🔄';
      default: return '🔍';
    }
  }
  
  private getStatusText(status: string): string {
    switch (status) {
      case 'passed': return 'PASSED';
      case 'failed': return 'FAILED';
      case 'running': return 'RUNNING';
      case 'pending': return 'PENDING';
      default: return 'UNKNOWN';
    }
  }
  
  private async runTest(testId: string) {
    const test = this.tests.get(testId);
    if (!test) return;
    
    this.log(`Starting test: ${test.name}`);
    test.status = 'running';
    this.updateTestDisplay(test);
    
    try {
      const result = await this.electroview.rpc.request.runTest({ testId });
      
      if (result.success) {
        this.log(`Test setup completed: ${test.name}`, 'info');
      } else {
        this.log(`Test setup failed: ${test.name} - ${result.message}`, 'error');
      }
    } catch (error) {
      this.log(`Test error: ${test.name} - ${error.message}`, 'error');
      test.status = 'failed';
      this.updateTestDisplay(test);
    }
  }
  
  private async runAllTests() {
    this.log('Running all tests...', 'info');
    
    const pendingTests = Array.from(this.tests.values()).filter(t => t.status === 'pending');
    
    for (const test of pendingTests) {
      await this.runTest(test.id);
      // Add small delay between tests
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    this.log(`Completed running ${pendingTests.length} tests`, 'info');
  }
  
  markTestPassed(testId: string) {
    this.electroview.rpc.send.markTestResult({
      testId,
      passed: true,
      notes: 'Manual verification: User confirmed test passed'
    });
  }
  
  markTestFailed(testId: string) {
    const notes = prompt('Optional: Describe what went wrong:');
    this.electroview.rpc.send.markTestResult({
      testId,
      passed: false,
      notes: notes || 'Manual verification: User reported test failed'
    });
  }
  
  private handleManualTestResult(testId: string, passed: boolean, notes?: string) {
    const test = this.tests.get(testId);
    if (!test) return;
    
    test.status = passed ? 'passed' : 'failed';
    test.lastResult = {
      success: passed,
      message: notes,
      timestamp: Date.now()
    };
    
    this.updateTestDisplay(test);
    this.updateStatusCounts();
    
    const status = passed ? 'PASSED' : 'FAILED';
    this.log(`Manual test ${status}: ${test.name}${notes ? ` - ${notes}` : ''}`, passed ? 'success' : 'error');
  }
  
  private updateTestStatus(testId: string, status: string, details?: string) {
    const test = this.tests.get(testId);
    if (!test) return;
    
    test.status = status as any;
    if (details) {
      test.lastResult = {
        success: status === 'passed',
        message: details,
        timestamp: Date.now()
      };
    }
    
    this.updateTestDisplay(test);
    this.updateStatusCounts();
  }
  
  private updateTestDisplay(test: TestData) {
    const element = document.getElementById(`test-${test.id}`);
    if (!element) return;
    
    // Update classes
    element.className = `test-card ${test.type} ${test.status}`;
    
    // Flash animation for status changes
    if (test.status === 'passed') {
      element.classList.add('flash-success');
      setTimeout(() => element.classList.remove('flash-success'), 600);
    } else if (test.status === 'failed') {
      element.classList.add('flash-error');  
      setTimeout(() => element.classList.remove('flash-error'), 600);
    }
    
    // Re-render the element
    const newElement = this.createTestElement(test);
    element.innerHTML = newElement.innerHTML;
  }
  
  private updateStatusCounts() {
    const counts = { passed: 0, failed: 0, pending: 0, running: 0 };
    
    for (const test of this.tests.values()) {
      counts[test.status]++;
    }
    
    document.getElementById('passed-count')!.textContent = counts.passed.toString();
    document.getElementById('failed-count')!.textContent = counts.failed.toString();
    document.getElementById('pending-count')!.textContent = (counts.pending + counts.running).toString();
  }
  
  private filterTests() {
    const checkboxes = document.querySelectorAll('#category-filters input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    const activeCategories = Array.from(checkboxes)
      .filter(cb => cb.checked)
      .map(cb => cb.value);
    
    for (const test of this.tests.values()) {
      const element = document.getElementById(`test-${test.id}`);
      if (element) {
        element.style.display = activeCategories.includes(test.category) ? 'block' : 'none';
      }
    }
  }
  
  private showInstructions(testId: string, instructions: string[]) {
    // Instructions are already shown in the test cards
    this.log(`Instructions shown for test: ${testId}`, 'info');
  }
  
  private async cleanup() {
    this.log('Cleaning up all tests...', 'info');
    
    try {
      const result = await this.electroview.rpc.request.cleanup({});
      
      if (result.success) {
        this.log(result.message, 'success');
        
        setTimeout(() => {
        // Reset all test statuses to pending
        this.tests.forEach(test => {
          test.status = 'pending';
          test.lastResult = undefined;
        });
        // Refresh the UI
        this.renderTests();
        this.updateStatusCounts();
        }, 100)
        
        this.log('All tests reset to pending state', 'info');
      } else {
        this.log(result.message, 'error');
      }
    } catch (error) {
      this.log(`Cleanup failed: ${error}`, 'error');
    }
  }
  
  private closeModal() {
    const modal = document.getElementById('test-modal');
    if (modal) {
      modal.style.display = 'none';
    }
  }
  
  private log(message: string, type: 'info' | 'success' | 'error' = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    
    const typeClass = type === 'success' ? 'log-success' : 
                     type === 'error' ? 'log-error' : 'log-info';
    
    entry.innerHTML = `
      <span class="timestamp">[${timestamp}]</span>
      <span class="${typeClass}">${message}</span>
    `;
    
    this.logContainer.appendChild(entry);
    this.logContainer.scrollTop = this.logContainer.scrollHeight;
    
    console.log(`[TestHarness] ${message}`);
  }
}

// Make testUI available globally for button onclick handlers
declare global {
  interface Window {
    testUI: TestHarnessUI;
  }
}

// Initialize the test harness UI
const testUI = new TestHarnessUI();
window.testUI = testUI;