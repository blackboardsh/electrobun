import Electrobun, { Electroview } from "electrobun/view";
import type { TestRunnerRPC, TestInfo } from "./rpc";
import type { TestResult, TestStatus } from "../test-framework/types";

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
      allCompleted: ({ results }) => {
        setButtonsEnabled(true);
        updateSummary();
        console.log('All tests completed');
      },
      interactiveWaiting: ({ testId, instructions }) => {
        showInteractiveModal(testId, instructions, 'legacy');
      },
      interactiveReady: ({ testId, instructions }) => {
        showInteractiveModal(testId, instructions, 'ready');
      },
      interactiveVerify: ({ testId }) => {
        showVerificationModal(testId);
      },
      buildConfig: (config) => {
        updateBuildConfigUI(config);
        console.log(`Build config: defaultRenderer=${config.defaultRenderer}, available=[${config.availableRenderers.join(', ')}]`);
      },
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

// State
let tests: TestInfo[] = [];
let testResults: Map<string, TestResult> = new Map();
let currentInteractiveTestId: string | null = null;

// DOM elements - will be initialized in init()
let testList: HTMLElement;
let totalCount: HTMLElement;
let passedCount: HTMLElement;
let failedCount: HTMLElement;
let pendingCount: HTMLElement;
let btnRunAll: HTMLButtonElement;
let btnRunInteractive: HTMLButtonElement;
let modal: HTMLElement;
let modalTitle: HTMLElement;
let modalInstructions: HTMLElement;
let modalButtons: HTMLElement;
let btnStart: HTMLButtonElement;
let btnPass: HTMLButtonElement;
let btnFail: HTMLButtonElement;
let btnRetest: HTMLButtonElement;
let notesInput: HTMLInputElement;

// Modal mode
type ModalMode = 'legacy' | 'ready' | 'verify';
let currentModalMode: ModalMode = 'legacy';

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
  modal = document.getElementById('interactive-modal')!;
  modalTitle = document.getElementById('modal-title')!;
  modalInstructions = document.getElementById('modal-instructions')!;
  modalButtons = document.getElementById('modal-buttons')!;
  btnStart = document.getElementById('btn-start')! as HTMLButtonElement;
  btnPass = document.getElementById('btn-pass')! as HTMLButtonElement;
  btnFail = document.getElementById('btn-fail')! as HTMLButtonElement;
  btnRetest = document.getElementById('btn-retest')! as HTMLButtonElement;
  notesInput = document.getElementById('notes-input')! as HTMLInputElement;

  if (!testList || !btnRunAll) {
    console.error('DOM elements not found, retrying in 100ms...');
    setTimeout(init, 100);
    return;
  }

  // Setup event handlers
  btnRunAll.addEventListener('click', runAllAutomated);
  btnRunInteractive.addEventListener('click', runInteractiveTests);
  btnStart.addEventListener('click', submitReady);
  btnPass.addEventListener('click', () => submitVerification('pass'));
  btnFail.addEventListener('click', () => submitVerification('fail'));
  btnRetest.addEventListener('click', () => submitVerification('retest'));

  // Use event delegation for run buttons (set up once)
  testList.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('run-btn')) {
      const testId = target.dataset.testId;
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
  // Group by category
  const byCategory = new Map<string, TestInfo[]>();
  for (const test of tests) {
    const existing = byCategory.get(test.category) || [];
    existing.push(test);
    byCategory.set(test.category, existing);
  }

  testList.innerHTML = '';

  for (const [category, categoryTests] of byCategory) {
    const categoryEl = document.createElement('div');
    categoryEl.className = 'category';
    categoryEl.innerHTML = `
      <div class="category-header">
        <span>${category}</span>
        <span class="category-stats">${categoryTests.length} tests</span>
      </div>
      <div class="category-tests" id="category-${category.replace(/[^a-z0-9]/gi, '-')}">
        ${categoryTests.map(test => renderTest(test)).join('')}
      </div>
    `;
    testList.appendChild(categoryEl);
  }

}

async function runSingleTest(testId: string) {
  const test = tests.find(t => t.id === testId);
  if (!test) return;

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
    await electrobun.rpc?.request.runTest({ testId });
  } catch (err) {
    console.error(`Failed to run test ${testId}:`, err);
  } finally {
    // Re-enable button
    if (btn) {
      btn.disabled = false;
      btn.textContent = test.interactive ? 'Open' : 'Run';
    }
  }
}

function renderTest(test: TestInfo): string {
  const result = testResults.get(test.id);
  const status = result?.status || 'pending';
  const statusIcon = getStatusIcon(status);
  const actionLabel = test.interactive ? 'Open' : 'Run';

  return `
    <div class="test-item" id="test-${test.id}" data-test-id="${test.id}">
      <div class="test-status ${status}">${statusIcon}</div>
      <div class="test-info">
        <div class="test-name">
          ${test.name}
          ${test.interactive ? '<span class="interactive-badge">Interactive</span>' : ''}
        </div>
        ${test.description ? `<div class="test-description">${test.description}</div>` : ''}
      </div>
      <div class="test-meta">
        ${result?.duration ? `<span class="test-duration">${result.duration}ms</span>` : ''}
        ${result?.error ? `<span class="test-error" title="${escapeHtml(result.error)}">${truncate(result.error, 40)}</span>` : ''}
      </div>
      <button class="run-btn" data-test-id="${test.id}" title="${actionLabel} this test">${actionLabel}</button>
    </div>
  `;
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

function setButtonsEnabled(enabled: boolean) {
  btnRunAll.disabled = !enabled;
  btnRunInteractive.disabled = !enabled;
}

async function runAllAutomated() {
  setButtonsEnabled(false);
  testResults.clear();
  renderTests();

  try {
    await electrobun.rpc?.request.runAllAutomated({});
  } catch (err) {
    console.error('Failed to run tests:', err);
  } finally {
    setButtonsEnabled(true);
  }
}

async function runInteractiveTests() {
  setButtonsEnabled(false);

  try {
    await electrobun.rpc?.request.runInteractiveTests({});
  } catch (err) {
    console.error('Failed to run interactive tests:', err);
  } finally {
    setButtonsEnabled(true);
    hideInteractiveModal();
  }
}

function showInteractiveModal(testId: string, instructions: string[], mode: ModalMode) {
  currentInteractiveTestId = testId;
  currentModalMode = mode;
  const test = tests.find(t => t.id === testId);

  modalTitle.textContent = test?.name || 'Interactive Test';
  modalInstructions.innerHTML = `
    <ol>
      ${instructions.map(i => `<li>${i}</li>`).join('')}
    </ol>
  `;
  notesInput.value = '';

  // Show/hide buttons based on mode
  if (mode === 'ready') {
    // Show only "Start Test" button - user reads instructions first
    btnStart.style.display = 'inline-block';
    btnPass.style.display = 'none';
    btnFail.style.display = 'none';
    btnRetest.style.display = 'none';
    notesInput.style.display = 'none';
  } else {
    // Legacy mode - show pass/fail (used for tests that show dialog then instructions)
    btnStart.style.display = 'none';
    btnPass.style.display = 'inline-block';
    btnFail.style.display = 'inline-block';
    btnRetest.style.display = 'none';
    notesInput.style.display = 'block';
  }

  modal.style.display = 'flex';
}

function showVerificationModal(testId: string) {
  currentInteractiveTestId = testId;
  currentModalMode = 'verify';
  const test = tests.find(t => t.id === testId);

  modalTitle.textContent = `Verify: ${test?.name || 'Test'}`;
  modalInstructions.innerHTML = `
    <p>Did the test work as expected?</p>
    <ul>
      <li><strong>Pass</strong> - Everything worked correctly</li>
      <li><strong>Fail</strong> - Something didn't work</li>
      <li><strong>Re-test</strong> - Run the action again</li>
    </ul>
  `;
  notesInput.value = '';

  // Show verification buttons
  btnStart.style.display = 'none';
  btnPass.style.display = 'inline-block';
  btnFail.style.display = 'inline-block';
  btnRetest.style.display = 'inline-block';
  notesInput.style.display = 'block';

  modal.style.display = 'flex';
}

function hideInteractiveModal() {
  modal.style.display = 'none';
  currentInteractiveTestId = null;
}

async function submitReady() {
  if (!currentInteractiveTestId) return;

  try {
    await electrobun.rpc?.request.submitReady({
      testId: currentInteractiveTestId,
    });
  } catch (err) {
    console.error('Failed to submit ready:', err);
  }

  hideInteractiveModal();
}

async function submitVerification(action: 'pass' | 'fail' | 'retest') {
  if (!currentInteractiveTestId) return;

  const notes = notesInput.value.trim() || undefined;

  try {
    await electrobun.rpc?.request.submitVerification({
      testId: currentInteractiveTestId,
      action,
      notes,
    });
  } catch (err) {
    console.error('Failed to submit verification:', err);
  }

  if (action !== 'retest') {
    hideInteractiveModal();
  }
}

// Build Config UI
function updateBuildConfigUI(config: { defaultRenderer: string; availableRenderers: string[] }) {
  const defaultRendererEl = document.getElementById('default-renderer');
  const availableRenderersEl = document.getElementById('available-renderers');

  if (defaultRendererEl) {
    defaultRendererEl.textContent = config.defaultRenderer;
  }
  if (availableRenderersEl) {
    availableRenderersEl.textContent = config.availableRenderers.join(', ');
  }
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
