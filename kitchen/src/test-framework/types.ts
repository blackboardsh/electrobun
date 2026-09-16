// Test framework types

export type TestStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface TestResult {
  testId: string;
  name: string;
  status: TestStatus;
  duration?: number;
  error?: string;
  logs?: string[];
}

export interface TestDefinition {
  id: string;
  name: string;
  category: string;
  description?: string;
  instructions?: string[];
  requires?: TestRequirements;
  interactive: boolean;
  timeout?: number;
  run: (context: TestContext) => Promise<void>;
}

export type WindowRenderer = 'cef' | 'native';

export interface TestRequirements {
  /** Native platform behavior that must be reported as skipped elsewhere. */
  platform?: 'win32' | 'darwin' | 'linux';
  /**
   * A hard runtime prerequisite proven by the test's stated purpose/assertions.
   * Never infer this from WindowOptions.renderer: Kitchen deliberately requests
   * "cef" in renderer-neutral tests so no-CEF builds exercise system fallback.
   */
  renderer?: WindowRenderer;
}

export interface TestSuiteDefinition {
  name: string;
  category: string;
  tests: Omit<TestDefinition, 'category'>[];
  setup?: () => Promise<any>;
  teardown?: (fixture: any) => Promise<void>;
}

export interface TestContext {
  // Window creation helpers
  createWindow: (options: WindowOptions) => Promise<TestWindow>;
  // Log to test output
  log: (message: string) => void;
}

export type TitleBarStyle = 'default' | 'hiddenInset' | 'hidden';

export interface WindowOptions {
  url?: string;
  html?: string;
  preload?: string;
  rpc?: any;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  title?: string;
  titleBarStyle?: TitleBarStyle;
  trafficLightOffset?: { x: number; y: number };
  /**
   * Requested renderer, not a requirement. A "cef" request intentionally falls
   * back to the system webview when CEF is not bundled; that path is critical
   * Kitchen coverage and must not be converted into TestRequirements.renderer.
   */
  renderer?: WindowRenderer;
  hidden?: boolean;
  activate?: boolean;
  sandbox?: boolean; // When true, disables RPC and only allows event emission
  allowedProtocols?: { views?: boolean; appData?: boolean };
  spellCheck?: boolean;
}

export interface TestWindow {
  id: number;
  webviewId: number;
  window: any; // BrowserWindow
  webview: any; // BrowserView
  close: () => void;
}

// Assertion error
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

// Simple expect assertions
export function expect<T>(actual: T, label?: string) {
  const prefix = label ? `[${label}] ` : '';

  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new AssertionError(`${prefix}Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toEqual(expected: T) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new AssertionError(`${prefix}Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toBeGreaterThan(n: number) {
      if (typeof actual !== 'number' || actual <= n) {
        throw new AssertionError(`${prefix}Expected ${actual} > ${n}`);
      }
    },
    toBeGreaterThanOrEqual(n: number) {
      if (typeof actual !== 'number' || actual < n) {
        throw new AssertionError(`${prefix}Expected ${actual} >= ${n}`);
      }
    },
    toBeLessThan(n: number) {
      if (typeof actual !== 'number' || actual >= n) {
        throw new AssertionError(`${prefix}Expected ${actual} < ${n}`);
      }
    },
    toBeLessThanOrEqual(n: number) {
      if (typeof actual !== 'number' || actual > n) {
        throw new AssertionError(`${prefix}Expected ${actual} <= ${n}`);
      }
    },
    toBeTruthy() {
      if (!actual) {
        throw new AssertionError(`${prefix}Expected truthy, got ${JSON.stringify(actual)}`);
      }
    },
    toBeFalsy() {
      if (actual) {
        throw new AssertionError(`${prefix}Expected falsy, got ${JSON.stringify(actual)}`);
      }
    },
    toBeNull() {
      if (actual !== null) {
        throw new AssertionError(`${prefix}Expected null, got ${JSON.stringify(actual)}`);
      }
    },
    toBeUndefined() {
      if (actual !== undefined) {
        throw new AssertionError(`${prefix}Expected undefined, got ${JSON.stringify(actual)}`);
      }
    },
    toBeDefined() {
      if (actual === undefined) {
        throw new AssertionError(`${prefix}Expected defined, got undefined`);
      }
    },
    toContain(item: any) {
      if (typeof actual === 'string') {
        if (!actual.includes(item)) {
          throw new AssertionError(`${prefix}Expected string to contain "${item}"`);
        }
      } else if (Array.isArray(actual)) {
        if (!actual.includes(item)) {
          throw new AssertionError(`${prefix}Expected array to contain ${JSON.stringify(item)}`);
        }
      } else {
        throw new AssertionError(`${prefix}toContain only works with strings and arrays`);
      }
    },
    toHaveLength(length: number) {
      if (!Array.isArray(actual) && typeof actual !== 'string') {
        throw new AssertionError(`${prefix}toHaveLength only works with strings and arrays`);
      }
      if ((actual as any).length !== length) {
        throw new AssertionError(`${prefix}Expected length ${length}, got ${(actual as any).length}`);
      }
    },
    toBeInstanceOf(constructor: any) {
      if (!(actual instanceof constructor)) {
        throw new AssertionError(`${prefix}Expected instance of ${constructor.name}`);
      }
    },
    toMatch(regex: RegExp) {
      if (typeof actual !== 'string' || !regex.test(actual)) {
        throw new AssertionError(`${prefix}Expected "${actual}" to match ${regex}`);
      }
    },
    toThrow() {
      if (typeof actual !== 'function') {
        throw new AssertionError(`${prefix}toThrow expects a function`);
      }
      try {
        (actual as any)();
        throw new AssertionError(`${prefix}Expected function to throw`);
      } catch (e) {
        if (e instanceof AssertionError) throw e;
        // Function threw as expected
      }
    },
  };
}

// Helper to define a test
let testIdCounter = 0;
export function defineTest(config: {
  name: string;
  category: string;
  description?: string;
  instructions?: string[];
  requires?: TestRequirements;
  interactive?: boolean;
  timeout?: number;
  run: (context: TestContext) => Promise<void>;
}): TestDefinition {
  return {
    id: `test-${++testIdCounter}-${config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: config.name,
    category: config.category,
    description: config.description,
    instructions: config.instructions,
    requires: config.requires,
    interactive: config.interactive ?? false,
    timeout: config.timeout ?? 10000,
    run: config.run,
  };
}

// Helper to define a test suite with shared setup/teardown
export function defineTestSuite(config: TestSuiteDefinition): TestDefinition[] {
  return config.tests.map((test, index) => ({
    id: `test-${++testIdCounter}-${config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index}`,
    name: test.name,
    category: config.category,
    description: test.description,
    instructions: test.instructions,
    requires: test.requires,
    interactive: test.interactive,
    timeout: test.timeout ?? 10000,
    run: test.run,
  }));
}
