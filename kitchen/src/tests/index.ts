// Test Index - Exports all test definitions

import type { TestDefinition } from "../test-framework/types";

// Automated tests
import { rpcTests } from "./rpc.test";
import { windowTests } from "./window.test";
import { navigationTests } from "./navigation.test";
import { utilsTests } from "./utils.test";
import { screenTests } from "./screen.test";
import { sessionTests } from "./session.test";
import { eventsTests } from "./events.test";
import { preloadTests } from "./preload.test";
import { updaterTests } from "./updater.test";

// Interactive tests
import { dialogTests } from "./interactive/dialogs.test";
import { trayTests } from "./interactive/tray.test";
import { shortcutTests } from "./interactive/shortcuts.test";
import { webviewTagTests } from "./interactive/webview-tag.test";
import { clipboardInteractiveTests } from "./interactive/clipboard.test";
import { menuTests } from "./interactive/menus.test";
import { windowEventTests } from "./interactive/window-events.test";
import { chromelessTests } from "./interactive/chromeless.test";

// Collect all tests
export const allTests: TestDefinition[] = [
  // Automated tests (run in parallel)
  ...rpcTests,
  ...windowTests,
  ...navigationTests,
  ...utilsTests,
  ...screenTests,
  ...sessionTests,
  ...eventsTests,
  ...preloadTests,
  ...updaterTests,

  // Interactive tests (run sequentially, require user)
  ...dialogTests,
  ...trayTests,
  ...shortcutTests,
  ...webviewTagTests,
  ...clipboardInteractiveTests,
  ...menuTests,
  ...windowEventTests,
  ...chromelessTests,
];

// Export by category for selective running
export const automatedTests: TestDefinition[] = allTests.filter((t) => !t.interactive);
export const interactiveTests: TestDefinition[] = allTests.filter((t) => t.interactive);

// Export individual test suites for reference
export {
  rpcTests,
  windowTests,
  navigationTests,
  utilsTests,
  screenTests,
  sessionTests,
  eventsTests,
  preloadTests,
  updaterTests,
  dialogTests,
  trayTests,
  shortcutTests,
  webviewTagTests,
  clipboardInteractiveTests,
  menuTests,
  windowEventTests,
  chromelessTests,
};
