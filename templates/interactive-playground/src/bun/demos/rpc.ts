class RPCTester {
  async doMath(data: { a: number; b: number; operation: string }): Promise<number> {
    let result: number;

    switch (data.operation) {
      case 'add':
        result = data.a + data.b;
        break;
      case 'subtract':
        result = data.a - data.b;
        break;
      case 'multiply':
        result = data.a * data.b;
        break;
      case 'divide':
        if (data.b === 0) throw new Error("Division by zero");
        result = data.a / data.b;
        break;
      case 'power':
        result = Math.pow(data.a, data.b);
        break;
      default:
        throw new Error(`Unknown operation: ${data.operation}`);
    }

    // Duration: Date.now() - startTime
    // Don't send notification here - let the frontend handle timing and display
    // to avoid duplicate entries

    return result;
  }

  async echoBigData(data: string): Promise<string> {
    // Simulate some processing time
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const response = `Echo: ${data.slice(0, 100)}... (${data.length} chars)`;
    // Duration: Date.now() - startTime
    // Don't send notification here - let the frontend handle timing and display
    // to avoid duplicate entries

    return response;
  }

  async performanceTest(messageSize: number, messageCount: number): Promise<{
    totalTime: number;
    averageTime: number;
    messagesPerSecond: number;
  }> {
    const testData = "x".repeat(messageSize);
    const results: number[] = [];

    const startTime = Date.now();

    for (let i = 0; i < messageCount; i++) {
      const messageStart = Date.now();
      await this.echoBigData(testData);
      results.push(Date.now() - messageStart);
    }

    const totalTime = Date.now() - startTime;
    const averageTime = results.reduce((a, b) => a + b, 0) / results.length;
    const messagesPerSecond = (messageCount / totalTime) * 1000;

    // Don't send notification here - let the frontend handle timing and display

    return {
      totalTime,
      averageTime,
      messagesPerSecond
    };
  }

  // Event callbacks
  onRpcTestResult?: (data: { operation: string; result: any; duration: number }) => void;
}

export const rpcTester = new RPCTester();