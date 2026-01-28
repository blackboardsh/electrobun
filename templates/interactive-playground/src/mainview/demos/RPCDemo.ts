export class RPCDemo {
  private testResults: Array<{ operation: string; result: any; duration: number }> = [];

  render() {
    return `
      <div class="demo-section">
        <div class="demo-header">
          <span class="demo-icon">📡</span>
          <div>
            <h2 class="demo-title">RPC Communication</h2>
            <p class="demo-description">Test bidirectional communication between the webview and bun process</p>
          </div>
        </div>

        <div class="demo-controls">
          <h3>Math Operations</h3>
          <div class="control-group">
            <label class="control-label">A:</label>
            <input type="number" id="math-a" class="control-input" value="10">
            
            <label class="control-label">B:</label>
            <input type="number" id="math-b" class="control-input" value="5">
            
            <label class="control-label">Operation:</label>
            <select id="math-operation" class="control-input" style="width: 120px;">
              <option value="add">Add (+)</option>
              <option value="subtract">Subtract (-)</option>
              <option value="multiply">Multiply (×)</option>
              <option value="divide">Divide (÷)</option>
              <option value="power">Power (^)</option>
            </select>
            
            <button class="btn btn-primary" id="do-math">Calculate</button>
          </div>

          <h3>Data Transfer Test</h3>
          <div class="control-group">
            <label class="control-label">Data Size:</label>
            <select id="data-size" class="control-input" style="width: 150px;">
              <option value="1024">1 KB</option>
              <option value="10240">10 KB</option>
              <option value="102400">100 KB</option>
              <option value="1048576">1 MB</option>
              <option value="2097152">2 MB</option>
            </select>
            
            <button class="btn btn-primary" id="test-big-data">Test Echo</button>
          </div>

          <h3>Performance Test</h3>
          <div class="control-group">
            <label class="control-label">Message Size:</label>
            <select id="perf-size" class="control-input" style="width: 120px;">
              <option value="100">100 B</option>
              <option value="1024">1 KB</option>
              <option value="10240">10 KB</option>
            </select>
            
            <label class="control-label">Count:</label>
            <input type="number" id="perf-count" class="control-input" value="10" min="1" max="100">
            
            <button class="btn btn-primary" id="run-performance-test">Run Test</button>
          </div>
        </div>

        <div class="demo-results">
          <div class="results-header">Test Results:</div>
          <div id="rpc-results" class="rpc-results">
            <div class="no-results" style="text-align: center; color: #718096; padding: 2rem;">
              No tests run yet. Use the controls above to start testing RPC communication.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  initialize(rpc: any) {
    const mathBtn = document.getElementById('do-math');
    const bigDataBtn = document.getElementById('test-big-data');
    const perfTestBtn = document.getElementById('run-performance-test');

    mathBtn?.addEventListener('click', async () => {
      const a = parseFloat((document.getElementById('math-a') as HTMLInputElement).value);
      const b = parseFloat((document.getElementById('math-b') as HTMLInputElement).value);
      const operation = (document.getElementById('math-operation') as HTMLSelectElement).value;

      try {
        const startTime = Date.now();
        const result = await rpc.request.doMath({ a, b, operation });
        const duration = Date.now() - startTime;
        
        this.addTestResult({
          operation: `${a} ${operation} ${b}`,
          result,
          duration
        });
      } catch (error) {
        this.addTestResult({
          operation: `${a} ${operation} ${b}`,
          result: `Error: ${(error as Error).message}`,
          duration: 0
        });
      }
    });

    bigDataBtn?.addEventListener('click', async () => {
      const size = parseInt((document.getElementById('data-size') as HTMLSelectElement).value);
      const testData = 'x'.repeat(size);

      try {
        const startTime = Date.now();
        const result = await rpc.request.echoBigData(testData);
        const duration = Date.now() - startTime;
        
        this.addTestResult({
          operation: `Echo ${this.formatBytes(size)}`,
          result: `Received ${this.formatBytes(result.length)}`,
          duration
        });
      } catch (error) {
        this.addTestResult({
          operation: `Echo ${this.formatBytes(size)}`,
          result: `Error: ${(error as Error).message}`,
          duration: 0
        });
      }
    });

    perfTestBtn?.addEventListener('click', async () => {
      const size = parseInt((document.getElementById('perf-size') as HTMLSelectElement).value);
      const count = parseInt((document.getElementById('perf-count') as HTMLInputElement).value);
      
      perfTestBtn.textContent = 'Running...';
      perfTestBtn.setAttribute('disabled', 'true');

      try {
        const results = await this.runPerformanceTest(rpc, size, count);
        this.addTestResult({
          operation: `Performance: ${count} × ${this.formatBytes(size)}`,
          result: `${results.messagesPerSecond.toFixed(1)} msg/sec, avg: ${results.averageTime.toFixed(1)}ms`,
          duration: results.totalTime
        });
      } catch (error) {
        this.addTestResult({
          operation: `Performance: ${count} × ${this.formatBytes(size)}`,
          result: `Error: ${(error as Error).message}`,
          duration: 0
        });
      } finally {
        perfTestBtn.textContent = 'Run Test';
        perfTestBtn.removeAttribute('disabled');
      }
    });
  }

  private async runPerformanceTest(rpc: any, messageSize: number, messageCount: number) {
    const testData = 'x'.repeat(messageSize);
    const results: number[] = [];
    const startTime = Date.now();

    for (let i = 0; i < messageCount; i++) {
      const messageStart = Date.now();
      await rpc.request.echoBigData(testData);
      results.push(Date.now() - messageStart);
      
      // Update progress
      const progress = ((i + 1) / messageCount) * 100;
      const perfTestBtn = document.getElementById('run-performance-test');
      if (perfTestBtn) {
        perfTestBtn.textContent = `Running... ${progress.toFixed(0)}%`;
      }
    }

    const totalTime = Date.now() - startTime;
    const averageTime = results.reduce((a, b) => a + b, 0) / results.length;
    const messagesPerSecond = (messageCount / totalTime) * 1000;

    return { totalTime, averageTime, messagesPerSecond };
  }

  private addTestResult(result: { operation: string; result: any; duration: number }) {
    this.testResults.unshift(result);
    
    // Keep only last 20 results
    if (this.testResults.length > 20) {
      this.testResults = this.testResults.slice(0, 20);
    }

    this.renderResults();
  }

  private renderResults() {
    const container = document.getElementById('rpc-results');
    if (!container) return;

    if (this.testResults.length === 0) {
      container.innerHTML = `
        <div class="no-results" style="text-align: center; color: #718096; padding: 2rem;">
          No tests run yet. Use the controls above to start testing RPC communication.
        </div>
      `;
      return;
    }

    container.innerHTML = this.testResults.map(result => `
      <div class="result-entry" style="background: #f8fafc; border-left: 3px solid #4299e1; padding: 1rem; margin-bottom: 0.5rem; border-radius: 0 0.25rem 0.25rem 0;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
          <strong>${result.operation}</strong>
          <span style="color: #718096; font-size: 0.875rem;">${result.duration}ms</span>
        </div>
        <div style="color: #2d3748;">${result.result}</div>
      </div>
    `).join('');
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // Handle events from the backend
  onRpcTestResult(data: { operation: string; result: any; duration: number }) {
    this.addTestResult(data);
  }
}