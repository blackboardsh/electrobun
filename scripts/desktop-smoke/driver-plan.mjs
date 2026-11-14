import { run } from '../accept-published-template.mjs';

export const DESKTOP_DRIVER_TIMEOUT_MS = 900_000;
const KITCHEN_CLEANUP_FALLBACK_SECONDS = DESKTOP_DRIVER_TIMEOUT_MS / 1000 + 30;

export function kitchenDesktopPlan(scenario, { hutch, kitchen, output }) {
  return { ...scenario, name: scenario.id, output, cwd: kitchen,
    // The driver owns observation time. Keep a later matrix fallback so a
    // forcibly terminated POSIX driver cannot strand its separate app group.
    command: [hutch, 'scripts/kitchen-matrix.ts', '--with=cottontail:cef', '--launch-only',
      `--timeout=${KITCHEN_CLEANUP_FALLBACK_SECONDS}`],
    env: { AUTO_RUN_TEST_NAME: scenario.test } };
}

export function runDesktopDriver(python, driver, planPath, options, runCommand = run) {
  // Match template and Kitchen supervision; individual UI response and OCR
  // deadlines remain inside desktop.py and are not extended by this budget.
  return runCommand(python, [driver, planPath], { ...options, timeout: DESKTOP_DRIVER_TIMEOUT_MS });
}
