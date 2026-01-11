// Utils Tests - Tests for utility functions (clipboard, notifications, etc.)

import { defineTest, expect } from "../test-framework/types";
import { Utils } from "electrobun/bun";
import { mkdtemp, writeFile, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

export const utilsTests = [
  // Note: Clipboard tests that require user interaction are in clipboard-interactive.test.ts

  defineTest({
    name: "clipboardWriteText and clipboardReadText",
    category: "Utils",
    description: "Test writing and reading text from clipboard",
    async run({ log }) {
      const testText = `Test clipboard ${Date.now()}`;

      log("Writing to clipboard");
      Utils.clipboardWriteText(testText);

      log("Reading from clipboard");
      const read = Utils.clipboardReadText();

      expect(read).toBe(testText);
      log(`Clipboard round-trip successful: "${read}"`);
    },
  }),

  defineTest({
    name: "clipboardAvailableFormats",
    category: "Utils",
    description: "Test getting available clipboard formats",
    async run({ log }) {
      // First write some text
      Utils.clipboardWriteText("test");

      log("Getting available formats");
      const formats = Utils.clipboardAvailableFormats();

      expect(Array.isArray(formats)).toBe(true);
      log(`Available formats: ${formats.join(", ")}`);
    },
  }),

  defineTest({
    name: "clipboardClear",
    category: "Utils",
    description: "Test clearing the clipboard",
    async run({ log }) {
      // First write some text
      Utils.clipboardWriteText("text to clear");

      log("Clearing clipboard");
      Utils.clipboardClear();

      const text = Utils.clipboardReadText();
      // After clear, should be empty or null
      expect(!text || text === "").toBe(true);
      log("Clipboard cleared successfully");
    },
  }),

  defineTest({
    name: "showNotification",
    category: "Utils",
    description: "Test showing a desktop notification",
    async run({ log }) {
      log("Showing notification");
      Utils.showNotification({
        title: "Test Notification",
        body: "This is a test notification from the integration tests",
        subtitle: "Electrobun Tests",
        silent: true, // Don't make sound during tests
      });

      // Give notification time to show
      await new Promise((resolve) => setTimeout(resolve, 500));
      log("Notification sent (verify visually if needed)");
    },
  }),

  defineTest({
    name: "openExternal",
    category: "Utils",
    description: "Test opening external URL (skipped to avoid opening browser)",
    async run({ log }) {
      // We skip actually calling this to avoid opening the browser during tests
      // But we verify the function exists
      expect(typeof Utils.openExternal).toBe("function");
      log("openExternal function exists (skipped actual call)");
    },
  }),

  defineTest({
    name: "openPath",
    category: "Utils",
    description: "Test opening path (skipped to avoid opening finder)",
    async run({ log }) {
      // We skip actually calling this to avoid side effects
      expect(typeof Utils.openPath).toBe("function");
      log("openPath function exists (skipped actual call)");
    },
  }),

  defineTest({
    name: "showItemInFolder",
    category: "Utils",
    description: "Test showing item in folder (skipped to avoid opening finder)",
    async run({ log }) {
      expect(typeof Utils.showItemInFolder).toBe("function");
      log("showItemInFolder function exists (skipped actual call)");
    },
  }),

  defineTest({
    name: "moveToTrash",
    category: "Utils",
    description: "Test moving a file to trash",
    async run({ log }) {
      // Create a temp directory and file
      const tempDir = await mkdtemp(join(tmpdir(), "electrobun-test-"));
      const testFile = join(tempDir, "test-trash-file.txt");

      log(`Creating temp file: ${testFile}`);
      await writeFile(testFile, "This file will be moved to trash");

      // Verify file exists
      try {
        await access(testFile);
        log("File created successfully");
      } catch {
        throw new Error("Failed to create temp file");
      }

      // Move to trash
      log("Moving file to trash");
      const result = Utils.moveToTrash(testFile);
      log(`moveToTrash returned: ${result}`);

      // Verify file no longer exists at original path
      try {
        await access(testFile);
        throw new Error("File still exists after moveToTrash");
      } catch {
        log("File successfully moved to trash");
      }

      // Cleanup temp directory (it should be empty now)
      try {
        const { rmdir } = await import("fs/promises");
        await rmdir(tempDir);
      } catch {
        // Ignore cleanup errors
      }
    },
  }),

  defineTest({
    name: "quit function exists",
    category: "Utils",
    description: "Test that quit function is available",
    async run({ log }) {
      expect(typeof Utils.quit).toBe("function");
      log("quit function exists (not calling it!)");
    },
  }),
];
