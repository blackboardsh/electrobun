import Electrobun, { Electroview } from "electrobun/view";
import type { TestRunnerRPC, TestInfo, UpdateInfo, UpdateStatusEntry } from "./rpc";
import type { TestResult, TestStatus } from "../test-framework/types";
import { groupTestsForDisplay } from "./test-order";

// RPC setup
const rpc = Electroview.defineRPC<TestRunnerRPC>({
  maxRequestTime: 300000, // 5 minutes for long test runs
  handlers: {
    requests: {},
    messages: {
      testStarted: ({ testId, name }) => {
        updateTestStatus(testId, 'running');
        console.log(`Test started: ${name}`);
      },
      testCompleted: ({ testId, result }) => {
        updateTestStatus(testId, result.status, result);
        updateSummary();
        console.log(`Test completed: ${result.name} - ${result.status}`);
      },
      testLog: ({ testId, message }) => {
        console.log(`[${testId}] ${message}`);
      },
      allCompleted: ({ results: _results }) => {
        // UI-initiated runs are unlocked by their request's finally block.
        // Avoid briefly enabling a second run before that request resolves.
        if (!runInProgress) setButtonsEnabled(true);
        updateSummary();
        console.log('All tests completed');
      },
      buildConfig: (config) => {
        updateBuildConfigUI(config);
        console.log(`Build config: defaultRenderer=${config.defaultRenderer}, available=[${config.availableRenderers.join(', ')}]`);
      },
      updateStatus: (info) => {
        updateUpdateUI(info);
        console.log(`Update status: ${info.status}, current=${info.currentVersion}, new=${info.newVersion || 'n/a'}`);
      },
      updateStatusEntry: (entry) => {
        addStatusEntryToUI(entry);
      },
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

// State
let tests: TestInfo[] = [];
let testResults: Map<string, TestResult> = new Map();
let statusHistoryVisible = false;
let searchQuery = '';
let runInProgress = false;

// DOM elements - will be initialized in init()
let testList: HTMLElement;
let totalCount: HTMLElement;
let passedCount: HTMLElement;
let failedCount: HTMLElement;
let pendingCount: HTMLElement;
let btnRunAll: HTMLButtonElement;
let btnRunInteractive: HTMLButtonElement;
let historyToggle: HTMLButtonElement;
let historyPanel: HTMLElement;
let historyList: HTMLElement;
let historyClear: HTMLButtonElement;
let searchInput: HTMLInputElement;
let searchMeta: HTMLElement;

// Initialize
async function init() {
  // Get DOM elements
  testList = document.getElementById('test-list')!;
  totalCount = document.getElementById('total-count')!;
  passedCount = document.getElementById('passed-count')!;
  failedCount = document.getElementById('failed-count')!;
  pendingCount = document.getElementById('pending-count')!;
  btnRunAll = document.getElementById('btn-run-all')! as HTMLButtonElement;
  btnRunInteractive = document.getElementById('btn-run-interactive')! as HTMLButtonElement;
  historyToggle = document.getElementById('update-history-toggle')! as HTMLButtonElement;
  historyPanel = document.getElementById('update-history-panel')!;
  historyList = document.getElementById('update-history-list')!;
  historyClear = document.getElementById('update-history-clear')! as HTMLButtonElement;
  searchInput = document.getElementById('test-search')! as HTMLInputElement;
  searchMeta = document.getElementById('search-meta')!;

  if (!testList || !btnRunAll) {
    console.error('DOM elements not found, retrying in 100ms...');
    setTimeout(init, 100);
    return;
  }

  // Setup event handlers
  btnRunAll.addEventListener('click', runAllAutomated);
  btnRunInteractive.addEventListener('click', runInteractiveTests);
  searchInput.addEventListener('input', onSearchInput);

  await loadPersistedSearchQuery();

  // Update button handler
  const updateBtn = document.getElementById('update-btn');
  if (updateBtn) {
    updateBtn.addEventListener('click', applyUpdate);
  }

  // History panel handlers
  if (historyToggle) {
    historyToggle.addEventListener('click', toggleHistoryPanel);
  }
  if (historyClear) {
    historyClear.addEventListener('click', clearStatusHistory);
  }

  // Use event delegation for run buttons (set up once)
  testList.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('run-btn')) {
      const testId = target.dataset['testId'];
      if (testId) {
        await runSingleTest(testId);
      }
    }
  });

  // Wait for RPC to be ready and get tests
  await loadTests();
}

async function loadTests(retries = 10): Promise<void> {
  console.log('Loading tests from bun...');

  for (let i = 0; i < retries; i++) {
    try {
      if (!electrobun.rpc) {
        console.log(`RPC not ready yet, retrying in 500ms (attempt ${i + 1}/${retries})...`);
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }

      const response = await electrobun.rpc.request.getTests({});
      if (response && response.length > 0) {
        tests = response;
        console.log(`Loaded ${tests.length} tests`);
        renderTests();
        updateSummary();
        return;
      }
    } catch (err) {
      console.log(`Failed to get tests (attempt ${i + 1}/${retries}):`, err);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.error('Failed to load tests after all retries');
  testList.innerHTML = '<div style="padding: 20px; color: #f87171;">Failed to load tests. Please refresh the window.</div>';
}

function renderTests() {
  const visibleTests = getVisibleTests();

  // Keep category grouping, but split mixed categories so every interactive
  // test remains above every automated test.
  const testGroups = groupTestsForDisplay(visibleTests);

  testList.innerHTML = '';

  if (visibleTests.length === 0) {
    testList.innerHTML = `<div class="empty-search-state">No tests match "<strong>${escapeHtml(searchQuery)}</strong>".</div>`;
    updateSearchMeta(0);
    return;
  }

  for (const { category, interactive, tests: categoryTests } of testGroups) {
    const categoryEl = document.createElement('div');
    categoryEl.className = 'category';

    const categoryHeaderEl = document.createElement('div');
    categoryHeaderEl.className = 'category-header';

    const categoryNameEl = document.createElement('span');
    categoryNameEl.textContent = category;

    const categoryStatsEl = document.createElement('span');
    categoryStatsEl.className = 'category-stats';
    categoryStatsEl.textContent = `${categoryTests.length} tests`;

    categoryHeaderEl.append(categoryNameEl, categoryStatsEl);

    const categoryTestsEl = document.createElement('div');
    categoryTestsEl.className = 'category-tests';
    categoryTestsEl.id = `category-${interactive ? 'interactive' : 'automated'}-${category.replace(/[^a-z0-9]/gi, '-')}`;
    categoryTestsEl.append(...categoryTests.map(test => renderTest(test)));

    categoryEl.append(categoryHeaderEl, categoryTestsEl);
    testList.appendChild(categoryEl);
  }

  updateSearchMeta(visibleTests.length);
}

async function runSingleTest(testId: string) {
  if (!beginRun()) return;

  const test = tests.find(t => t.id === testId);
  if (!test) {
    finishRun();
    return;
  }

  // Update UI to show running state
  updateTestStatus(testId, 'running');

  // Disable the button while running
  const btn = document.querySelector(`.run-btn[data-test-id="${testId}"]`) as HTMLButtonElement;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '...';
  }

  try {
    console.log(`Running test: ${test.name}`);
    // The backend owns each test's timeout. Interactive tests can legitimately
    // remain open longer than the runner RPC's default request deadline.
    await electrobun.rpc?.request.runTest(
      { testId },
      { maxRequestTime: Infinity },
    );
  } catch (err) {
    console.error(`Failed to run test ${testId}:`, err);
  } finally {
    // Re-enable button
    if (btn) btn.textContent = test.interactive ? 'Open' : 'Run';
    finishRun();
  }
}

function renderTest(test: TestInfo): HTMLElement {
  const result = testResults.get(test.id);
  const status = result?.status || 'pending';
  const statusIcon = getStatusIcon(status);
  const actionLabel = test.interactive ? 'Open' : 'Run';

  const testEl = document.createElement('div');
  testEl.className = 'test-item';
  testEl.id = `test-${test.id}`;
  testEl.dataset['testId'] = test.id;

  const statusEl = document.createElement('div');
  statusEl.className = `test-status ${status}`;
  statusEl.textContent = statusIcon;

  const infoEl = document.createElement('div');
  infoEl.className = 'test-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'test-name';
  nameEl.textContent = test.name;
  if (test.interactive) {
    const badgeEl = document.createElement('span');
    badgeEl.className = 'interactive-badge';
    badgeEl.textContent = 'Interactive';
    nameEl.appendChild(badgeEl);
  }
  infoEl.appendChild(nameEl);

  if (test.description) {
    const descriptionEl = document.createElement('div');
    descriptionEl.className = 'test-description';
    descriptionEl.textContent = test.description;
    infoEl.appendChild(descriptionEl);
  }

  if (test.instructions?.length) {
    const instructionsEl = document.createElement('ol');
    instructionsEl.className = 'test-instructions';
    for (const instruction of test.instructions) {
      const instructionEl = document.createElement('li');
      instructionEl.textContent = instruction;
      instructionsEl.appendChild(instructionEl);
    }
    infoEl.appendChild(instructionsEl);
  }

  const metaEl = document.createElement('div');
  metaEl.className = 'test-meta';
  if (result?.duration) {
    const durationEl = document.createElement('span');
    durationEl.className = 'test-duration';
    durationEl.textContent = `${result.duration}ms`;
    metaEl.appendChild(durationEl);
  }
  if (result?.error) {
    const errorEl = document.createElement('span');
    errorEl.className = 'test-error';
    errorEl.title = result.error;
    errorEl.textContent = truncate(result.error, 40);
    metaEl.appendChild(errorEl);
  }

  const runButtonEl = document.createElement('button');
  runButtonEl.className = 'run-btn';
  runButtonEl.dataset['testId'] = test.id;
  runButtonEl.title = `${actionLabel} this test`;
  runButtonEl.textContent = actionLabel;
  runButtonEl.disabled = runInProgress;

  testEl.append(statusEl, infoEl, metaEl, runButtonEl);
  return testEl;
}

function getStatusIcon(status: TestStatus): string {
  switch (status) {
    case 'pending': return '○';
    case 'running': return '◎';
    case 'passed': return '✓';
    case 'failed': return '✗';
    case 'skipped': return '−';
    default: return '?';
  }
}

function updateTestStatus(testId: string, status: TestStatus, result?: TestResult) {
  if (result) {
    testResults.set(testId, result);
  }

  const testEl = document.getElementById(`test-${testId}`);
  if (!testEl) return;

  const statusEl = testEl.querySelector('.test-status');
  if (statusEl) {
    statusEl.className = `test-status ${status}`;
    statusEl.textContent = getStatusIcon(status);
  }

  const metaEl = testEl.querySelector('.test-meta');
  if (metaEl && result) {
    metaEl.innerHTML = `
      ${result.duration ? `<span class="test-duration">${result.duration}ms</span>` : ''}
      ${result.error ? `<span class="test-error" title="${escapeHtml(result.error)}">${truncate(result.error, 40)}</span>` : ''}
    `;
  }
}

function updateSummary() {
  const results = Array.from(testResults.values());
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const pending = tests.length - results.length;

  totalCount.textContent = String(tests.length);
  passedCount.textContent = String(passed);
  failedCount.textContent = String(failed);
  pendingCount.textContent = String(pending);
}

function onSearchInput() {
  searchQuery = searchInput.value.trim();
  void persistSearchQuery(searchQuery);
  renderTests();
}

function updateSearchMeta(visibleCount: number) {
  if (!searchMeta) return;

  if (!searchQuery) {
    searchMeta.textContent = `${tests.length} tests`;
    return;
  }

  searchMeta.textContent = `Showing ${visibleCount} of ${tests.length}`;
}

function getVisibleTests(): TestInfo[] {
  if (!searchQuery) return tests;

  return tests.filter((test) => fuzzyMatches(test, searchQuery));
}

function fuzzyMatches(test: TestInfo, rawQuery: string): boolean {
  const queryTokens = rawQuery
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (queryTokens.length === 0) return true;

  const haystacks = [
    test.name.toLowerCase(),
    test.category.toLowerCase(),
    (test.description || '').toLowerCase(),
    ...(test.instructions || []).map((instruction) => instruction.toLowerCase()),
  ];

  return queryTokens.every((token) =>
    haystacks.some((value) => {
      if (value.includes(token)) return true;
      return isSubsequence(token, value);
    }),
  );
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let needleIndex = 0;
  for (let i = 0; i < haystack.length; i += 1) {
    if (haystack[i] === needle[needleIndex]) {
      needleIndex += 1;
      if (needleIndex === needle.length) return true;
    }
  }
  return false;
}

async function persistSearchQuery(query: string) {
  try {
    await electrobun.rpc?.request.setTestRunnerPreferences({ searchQuery: query });
  } catch (err) {
    console.warn('Failed to persist search query', err);
  }
}

async function loadPersistedSearchQuery(): Promise<void> {
  try {
    const response = await electrobun.rpc?.request.getTestRunnerPreferences({});
    const query = response?.searchQuery || '';
    searchQuery = query;
    searchInput.value = query;
  } catch (err) {
    console.warn('Failed to load persisted search query', err);
  }
}

function setButtonsEnabled(enabled: boolean) {
  btnRunAll.disabled = !enabled;
  btnRunInteractive.disabled = !enabled;
  document.querySelectorAll<HTMLButtonElement>('.run-btn').forEach((button) => {
    button.disabled = !enabled;
  });
}

function beginRun(): boolean {
  if (runInProgress) return false;
  runInProgress = true;
  setButtonsEnabled(false);
  return true;
}

function finishRun() {
  runInProgress = false;
  setButtonsEnabled(true);
}

async function runAllAutomated() {
  if (!beginRun()) return;
  testResults.clear();
  renderTests();

  try {
    await electrobun.rpc?.request.runAllAutomated(
      {},
      { maxRequestTime: Infinity },
    );
  } catch (err) {
    console.error('Failed to run tests:', err);
  } finally {
    finishRun();
  }
}

async function runInteractiveTests() {
  if (!beginRun()) return;

  try {
    // This request covers the entire sequential interactive suite, including
    // however long the tester keeps each playground open.
    await electrobun.rpc?.request.runInteractiveTests(
      {},
      { maxRequestTime: Infinity },
    );
  } catch (err) {
    console.error('Failed to run interactive tests:', err);
  } finally {
    finishRun();
  }
}

// Build Config UI
function updateBuildConfigUI(config: {
  defaultRenderer: string;
  availableRenderers: string[];
  mainProcess?: 'bun' | 'cottontail' | 'zig' | 'rust' | 'go' | 'odin';
  cefVersion?: string;
  bunVersion?: string;
  zigVersion?: string;
  rustVersion?: string;
  goVersion?: string;
}) {
  const defaultRendererEl = document.getElementById('default-renderer');
  const availableRenderersEl = document.getElementById('available-renderers');

  if (defaultRendererEl) {
    defaultRendererEl.textContent = config.defaultRenderer;
  }
  if (availableRenderersEl) {
    availableRenderersEl.textContent = config.availableRenderers.join(', ');
  }

  const chromiumVersionEl = document.getElementById('chromium-version');
  if (chromiumVersionEl) {
    if (config.cefVersion) {
      // Extract chromium version from CEF version string like "144.0.12+g1a1008c+chromium-144.0.7559.110"
      const chromiumMatch = config.cefVersion.match(/chromium-([\d.]+)/);
      chromiumVersionEl.textContent = chromiumMatch ? chromiumMatch[1]! : config.cefVersion;
    } else {
      const chromeMatch = navigator.userAgent.match(/Chrome\/(\S+)/);
      chromiumVersionEl.textContent = chromeMatch
        ? chromeMatch[1]!
        : 'N/A (system webview)';
    }
  }

  const hostRuntimeVersionEl = document.getElementById('host-runtime-version');
  if (hostRuntimeVersionEl) {
    if (config.mainProcess === 'zig' && config.zigVersion) {
      hostRuntimeVersionEl.textContent = `Zig ${config.zigVersion}`;
    } else if (config.mainProcess === 'rust' && config.rustVersion) {
      hostRuntimeVersionEl.textContent = `Rust ${config.rustVersion}`;
    } else if (config.mainProcess === 'go' && config.goVersion) {
      hostRuntimeVersionEl.textContent = `Go ${config.goVersion}`;
    } else if (config.mainProcess === 'bun' && config.bunVersion) {
      hostRuntimeVersionEl.textContent = `Bun ${config.bunVersion}`;
    } else if (config.mainProcess === 'cottontail') {
      hostRuntimeVersionEl.textContent = 'Cottontail';
    } else if (config.zigVersion) {
      hostRuntimeVersionEl.textContent = `Zig ${config.zigVersion}`;
    } else if (config.rustVersion) {
      hostRuntimeVersionEl.textContent = `Rust ${config.rustVersion}`;
    } else if (config.goVersion) {
      hostRuntimeVersionEl.textContent = `Go ${config.goVersion}`;
    } else if (config.mainProcess) {
      hostRuntimeVersionEl.textContent = config.mainProcess;
    } else {
      hostRuntimeVersionEl.textContent = 'N/A';
    }
  }

  const userAgentEl = document.getElementById('user-agent-value');
  if (userAgentEl) {
    userAgentEl.textContent = navigator.userAgent;
  }
}

// Update UI
function updateUpdateUI(info: UpdateInfo) {
  const banner = document.getElementById('update-banner');
  const message = document.getElementById('update-message');
  const btn = document.getElementById('update-btn') as HTMLButtonElement;
  const versionBadge = document.getElementById('version-badge');

  if (!banner || !message || !btn) return;

  // Always show current version
  if (versionBadge) {
    versionBadge.textContent = `v${info.currentVersion}`;
  }

  // Reset classes
  banner.className = 'update-banner';

  switch (info.status) {
    case 'checking':
      banner.style.display = 'flex';
      banner.classList.add('checking');
      message.textContent = 'Checking for updates...';
      btn.style.display = 'none';
      break;

    case 'update-available':
      banner.style.display = 'flex';
      message.textContent = `Update available: v${info.newVersion}`;
      btn.style.display = 'none';
      break;

    case 'downloading':
      banner.style.display = 'flex';
      banner.classList.add('downloading');
      message.textContent = `Downloading update v${info.newVersion}...`;
      btn.style.display = 'none';
      break;

    case 'update-ready':
      banner.style.display = 'flex';
      banner.classList.add('ready');
      message.textContent = `Update v${info.newVersion} ready to install`;
      btn.style.display = 'inline-block';
      btn.textContent = 'Update Now';
      break;

    case 'no-update':
      banner.style.display = 'flex';
      banner.classList.add('checking'); // Use neutral gray styling
      message.textContent = 'No update available';
      btn.style.display = 'none';
      break;

    case 'error':
      banner.style.display = 'flex';
      banner.classList.add('error');
      message.textContent = `Update error: ${info.error || 'Unknown error'}`;
      btn.style.display = 'none';
      break;
  }
}

async function applyUpdate() {
  try {
    await electrobun.rpc?.request.applyUpdate({});
  } catch (err) {
    console.error('Failed to apply update:', err);
  }
}

// Status History Panel
async function toggleHistoryPanel() {
  statusHistoryVisible = !statusHistoryVisible;

  if (statusHistoryVisible) {
    historyPanel.style.display = 'flex';
    historyToggle.textContent = 'Hide History';
    // Load existing history
    try {
      const history = await electrobun.rpc?.request.getUpdateStatusHistory({});
      if (history) {
        historyList.innerHTML = '';
        for (const entry of history) {
          addStatusEntryToUI(entry);
        }
      }
    } catch (err) {
      console.error('Failed to load status history:', err);
    }
  } else {
    historyPanel.style.display = 'none';
    historyToggle.textContent = 'Show History';
  }
}

async function clearStatusHistory() {
  try {
    await electrobun.rpc?.request.clearUpdateStatusHistory({});
    historyList.innerHTML = '';
  } catch (err) {
    console.error('Failed to clear status history:', err);
  }
}

function addStatusEntryToUI(entry: UpdateStatusEntry) {
  if (!historyList) return;

  const entryEl = document.createElement('div');
  entryEl.className = 'status-entry';

  const time = new Date(entry.timestamp);
  const timeStr = time.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }) + '.' + String(time.getMilliseconds()).padStart(3, '0');

  // Build details string if present
  let detailsStr = '';
  if (entry.details) {
    const parts: string[] = [];
    if (entry.details.progress !== undefined) {
      parts.push(`${entry.details.progress}%`);
    }
    if (entry.details.bytesDownloaded !== undefined) {
      const mb = (entry.details.bytesDownloaded / 1024 / 1024).toFixed(1);
      parts.push(`${mb}MB`);
    }
    if (entry.details.patchNumber !== undefined) {
      parts.push(`patch #${entry.details.patchNumber}`);
    }
    if (entry.details.totalPatchesApplied !== undefined && entry.details.totalPatchesApplied > 0) {
      parts.push(`${entry.details.totalPatchesApplied} patches`);
    }
    if (entry.details.usedPatchPath !== undefined) {
      parts.push(entry.details.usedPatchPath ? 'patch path' : 'full download');
    }
    if (entry.details.currentHash) {
      parts.push(entry.details.currentHash.slice(0, 8));
    }
    if (parts.length > 0) {
      detailsStr = ` [${parts.join(', ')}]`;
    }
  }

  entryEl.innerHTML = `
    <span class="timestamp">${timeStr}</span>
    <span class="status-badge ${entry.status}">${entry.status}</span>
    <span class="message">${escapeHtml(entry.message)}${detailsStr ? `<span class="details">${detailsStr}</span>` : ''}</span>
  `;

  historyList.appendChild(entryEl);

  // Auto-scroll to bottom
  historyList.scrollTop = historyList.scrollHeight;
}

// Helpers
function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m] || m));
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str;
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
