// Test Harness - A bundled view that tests can use for RPC testing
import Electrobun, { Electroview } from "electrobun/view";
import type { RPCSchema } from "electrobun";

export type StressMessageStats = {
  count: number;
  expectedCount: number;
  missing: number[];
  duplicates: number[];
};

export type StressRequestSummary = {
  total: number;
  received: number;
  errorCount: number;
  mismatchCount: number;
  errors: Array<{ id: number; error: string }>;
  mismatches: Array<{ id: number; value: unknown }>;
};

export type HostSocketStressState = {
  hasSocket: boolean;
  hostSocketPort: number | null;
  socketUrl: string | null;
  readyState: number | null;
  bufferedAmount: number | null;
  canSend: boolean;
  hasEncrypt: boolean;
  hasHostBridge: boolean;
  sendQueueLength: number | null;
  pendingQueueLength: number | null;
  flushingSendQueue: boolean;
  flushingPendingQueue: boolean;
};

export type SocketSendSummary = {
  socketSendCalls: number;
  encryptCalls: number;
  encryptResolvedCalls: number;
  lastEncryptStarted: string | null;
  lastEncryptResolved: string | null;
  wrapErrors: string[];
  state: HostSocketStressState;
};

const webviewStressMessageIds = new Set<number>();
const webviewDuplicateStressMessageIds = new Set<number>();
const transportProbe = {
  socketSendCalls: 0,
  encryptCalls: 0,
  encryptResolvedCalls: 0,
  lastEncryptStarted: null as string | null,
  lastEncryptResolved: null as string | null,
  wrapErrors: [] as string[],
  wrappedSocket: false,
  wrappedEncrypt: false,
};

function startStressFromHostControl({
  messageCount,
  requestCount,
}: {
  messageCount: number;
  requestCount: number;
}) {
  resetWebviewStressMessageCollector();
  runRpcStress({
    messageCount: getStressInteger(messageCount, 0),
    requestCount: getStressInteger(requestCount, 0),
  });
}

function startTransportTransitionStressFromHostControl({
  messageCount,
  requestCount,
  enableSocketAt,
}: {
  messageCount: number;
  requestCount: number;
  enableSocketAt: number;
}) {
  resetWebviewStressMessageCollector();
  electrobun.hostSocketCanSend = false;
  runRpcStress({
    messageCount: getStressInteger(messageCount, 0),
    requestCount: getStressInteger(requestCount, 0),
    enableSocketAt: getStressInteger(enableSocketAt, 0),
  });
}

function startTimedSocketStressFromHostControl({
  messageCount,
  intervalMs,
}: {
  messageCount: number;
  intervalMs: number;
}) {
  resetWebviewStressMessageCollector();
  resetTransportProbe();
  installTransportProbe();
  runRpcStress({
    messageCount: getStressInteger(messageCount, 0),
    requestCount: 0,
    enableSocketAt: 0,
    intervalMs: getStressInteger(intervalMs, 0),
    sendSocketSummary: true,
  });
}

function recordWebviewStressMessage(id: number) {
  if (webviewStressMessageIds.has(id)) {
    webviewDuplicateStressMessageIds.add(id);
  }
  webviewStressMessageIds.add(id);
}

function getWebviewStressMessageStats(expectedCount: number): StressMessageStats {
  const missing: number[] = [];
  for (let id = 0; id < expectedCount; id++) {
    if (!webviewStressMessageIds.has(id)) {
      missing.push(id);
    }
  }

  return {
    count: webviewStressMessageIds.size,
    expectedCount,
    missing,
    duplicates: Array.from(webviewDuplicateStressMessageIds).sort((a, b) => a - b),
  };
}

function resetWebviewStressMessageCollector() {
  webviewStressMessageIds.clear();
  webviewDuplicateStressMessageIds.clear();
}

let electrobun: any;

// Generic test harness RPC schema
export type TestHarnessRPC = {
  bun: RPCSchema<{
    requests: {
      // Echo back whatever is sent
      echo: {
        params: { value: any };
        response: any;
      };
      // Simple math
      add: {
        params: { a: number; b: number };
        response: number;
      };
      // Simulate error
      throwError: {
        params: { message?: string };
        response: void;
      };
      // Delayed response
      delayed: {
        params: { ms: number; value: any };
        response: any;
      };
    };
    messages: {
      ping: { timestamp: number };
      stressMessageToBun: { id: number; payload?: string };
      stressWebviewMessageSummary: StressMessageStats;
      stressWebviewRequestSummary: StressRequestSummary;
      stressSocketSendSummary: SocketSendSummary;
    };
  }>;
  webview: RPCSchema<{
    requests: {
      // Get document info
      getDocumentTitle: {
        params: {};
        response: string;
      };
      // Math from webview
      multiply: {
        params: { a: number; b: number };
        response: number;
      };
      // Get a DOM element's text
      getElementText: {
        params: { selector: string };
        response: string | null;
      };
      // Set body content
      setBodyContent: {
        params: { html: string };
        response: void;
      };
      resetStressMessageCollector: {
        params: {};
        response: void;
      };
      getStressMessageStats: {
        params: { expectedCount: number };
        response: StressMessageStats;
      };
      getHostSocketStressState: {
        params: {};
        response: HostSocketStressState;
      };
      enableHostSocketForStress: {
        params: {};
        response: HostSocketStressState;
      };
    };
    messages: {
      pong: { timestamp: number };
      stressMessageToWebview: { id: number; payload?: string };
      finishStressMessageToWebview: { expectedCount: number };
      startStressFromBun: { messageCount: number; requestCount: number };
      startTransportTransitionStressFromBun: {
        messageCount: number;
        requestCount: number;
        enableSocketAt: number;
      };
      startTimedSocketStressFromBun: {
        messageCount: number;
        intervalMs: number;
      };
    };
  }>;
};

// RPC setup with handlers for webview-side operations
const rpc = Electroview.defineRPC<TestHarnessRPC>({
  maxRequestTime: 30000,
  handlers: {
    requests: {
      getDocumentTitle: () => document.title,
      multiply: ({ a, b }) => a * b,
      getElementText: ({ selector }) => {
        const el = document.querySelector(selector);
        return el?.textContent || null;
      },
      setBodyContent: ({ html }) => {
        document.body.innerHTML = html;
      },
      resetStressMessageCollector: () => {
        resetWebviewStressMessageCollector();
      },
      getStressMessageStats: ({ expectedCount }) => {
        return getWebviewStressMessageStats(expectedCount);
      },
      getHostSocketStressState: () => {
        return getHostSocketStressState();
      },
      enableHostSocketForStress: () => {
        electrobun.hostSocketCanSend = true;
        return getHostSocketStressState();
      },
    },
    messages: {
      pong: ({ timestamp }) => {
        console.log(`Received pong at ${timestamp}`);
      },
      stressMessageToWebview: ({ id }) => {
        recordWebviewStressMessage(id);
      },
      finishStressMessageToWebview: ({ expectedCount }) => {
        electrobun.rpc.send.stressWebviewMessageSummary(
          getWebviewStressMessageStats(expectedCount),
        );
      },
      startStressFromBun: ({ messageCount, requestCount }) => {
        startStressFromHostControl({ messageCount, requestCount });
      },
      startTransportTransitionStressFromBun: ({
        messageCount,
        requestCount,
        enableSocketAt,
      }) => {
        startTransportTransitionStressFromHostControl({
          messageCount,
          requestCount,
          enableSocketAt,
        });
      },
      startTimedSocketStressFromBun: ({ messageCount, intervalMs }) => {
        startTimedSocketStressFromHostControl({ messageCount, intervalMs });
      },
    },
  },
});

electrobun = new Electrobun.Electroview({ rpc });

function getStressInteger(value: unknown, fallback: number) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : fallback;
}

function getHostSocketStressState(): HostSocketStressState {
  return {
    hasSocket: Boolean(electrobun.hostSocket),
    hostSocketPort:
      typeof window.__electrobunHostSocketPort === "number"
        ? window.__electrobunHostSocketPort
        : typeof window.__electrobunRpcSocketPort === "number"
          ? window.__electrobunRpcSocketPort
          : null,
    socketUrl:
      typeof electrobun.hostSocket?.url === "string"
        ? electrobun.hostSocket.url
        : null,
    readyState:
      typeof electrobun.hostSocket?.readyState === "number"
        ? electrobun.hostSocket.readyState
        : null,
    bufferedAmount:
      typeof electrobun.hostSocket?.bufferedAmount === "number"
        ? electrobun.hostSocket.bufferedAmount
        : null,
    canSend: Boolean(electrobun.hostSocketCanSend),
    hasEncrypt: typeof window.__electrobun_encrypt === "function",
    hasHostBridge: Boolean(window.__electrobunHostBridge),
    sendQueueLength: Array.isArray(electrobun.hostSocketSendQueue)
      ? electrobun.hostSocketSendQueue.length
      : null,
    pendingQueueLength: Array.isArray(electrobun.pendingHostSocketMessages)
      ? electrobun.pendingHostSocketMessages.length
      : null,
    flushingSendQueue: Boolean(electrobun.flushingHostSocketSendQueue),
    flushingPendingQueue: Boolean(electrobun.flushingHostSocketMessages),
  };
}

function resetTransportProbe() {
  transportProbe.socketSendCalls = 0;
  transportProbe.encryptCalls = 0;
  transportProbe.encryptResolvedCalls = 0;
  transportProbe.lastEncryptStarted = null;
  transportProbe.lastEncryptResolved = null;
  transportProbe.wrapErrors = [];
}

function installTransportProbe() {
  if (!transportProbe.wrappedEncrypt && typeof window.__electrobun_encrypt === "function") {
    try {
      const originalEncrypt = window.__electrobun_encrypt;
      window.__electrobun_encrypt = async (message: string) => {
        transportProbe.encryptCalls += 1;
        transportProbe.lastEncryptStarted = message.slice(0, 160);
        const result = await originalEncrypt(message);
        transportProbe.encryptResolvedCalls += 1;
        transportProbe.lastEncryptResolved = message.slice(0, 160);
        transportProbe.socketSendCalls += 1;
        return result;
      };
      transportProbe.wrappedEncrypt = true;
    } catch (error) {
      transportProbe.wrapErrors.push(`encrypt: ${String(error)}`);
    }
  }
}

function getTransportProbeSummary(): SocketSendSummary {
  return {
    socketSendCalls: transportProbe.socketSendCalls,
    encryptCalls: transportProbe.encryptCalls,
    encryptResolvedCalls: transportProbe.encryptResolvedCalls,
    lastEncryptStarted: transportProbe.lastEncryptStarted,
    lastEncryptResolved: transportProbe.lastEncryptResolved,
    wrapErrors: transportProbe.wrapErrors.slice(),
    state: getHostSocketStressState(),
  };
}

function runRpcStress(config: {
  messageCount: number;
  requestCount: number;
  enableSocketAt?: number;
  intervalMs?: number;
  sendSocketSummary?: boolean;
}) {
  setTimeout(async () => {
    for (let id = 0; id < config.messageCount; id++) {
      if (id === config.enableSocketAt) {
        electrobun.hostSocketCanSend = true;
      }

      (electrobun.rpc as any).send.stressMessageToBun({
        id,
        payload: `webview-to-bun-${id}`,
      });

      if (config.intervalMs && config.intervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
      }
    }

    const results = await Promise.all(
      Array.from({ length: config.requestCount }, (_, id) =>
        (electrobun.rpc as any).request.echo({ value: id })
          .then((value: unknown) => ({ id, value }))
          .catch((error: Error) => ({
            id,
            error: String(error?.message || error),
          })),
      ),
    );
    const errors = results.filter(
      (result): result is { id: number; error: string } => "error" in result,
    );
    const mismatches = results.filter(
      (result): result is { id: number; value: unknown } =>
        !("error" in result) && result.value !== result.id,
    );

    electrobun.rpc.send.stressWebviewRequestSummary({
      total: config.requestCount,
      received: results.length,
      errorCount: errors.length,
      mismatchCount: mismatches.length,
      errors: errors.slice(0, 10),
      mismatches: mismatches.slice(0, 10),
    });

    if (config.sendSocketSummary) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      electrobun.hostSocketCanSend = false;
      electrobun.rpc.send.stressSocketSendSummary(getTransportProbeSummary());
    }
  }, 250);
}

// Expose for debugging
(window as any).electrobun = electrobun;
(window as any).__electrobunKitchenStress = {
  startStressFromHostControl,
  startTransportTransitionStressFromHostControl,
  startTimedSocketStressFromHostControl,
  getTransportProbeSummary,
};
(window as any).testHarnessReady = true;

console.log("Test harness initialized");
