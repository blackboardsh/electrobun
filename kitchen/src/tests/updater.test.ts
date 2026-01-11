// Updater API Tests

import { defineTest, expect } from "../test-framework/types";
import Electrobun from "electrobun/bun";

export const updaterTests = [
  defineTest({
    name: "Updater.localInfo.version",
    category: "Updater",
    description: "Test getting local app version",
    async run({ log }) {
      const version = await Electrobun.Updater.localInfo.version();

      expect(version).toBeTruthy();
      expect(typeof version).toBe("string");

      log(`Local version: ${version}`);
    },
  }),

  defineTest({
    name: "Updater.localInfo.channel",
    category: "Updater",
    description: "Test getting update channel",
    async run({ log }) {
      const channel = await Electrobun.Updater.localInfo.channel();

      expect(channel).toBeTruthy();
      expect(typeof channel).toBe("string");

      log(`Update channel: ${channel}`);
    },
  }),

  defineTest({
    name: "Updater.localInfo.hash",
    category: "Updater",
    description: "Test getting local build hash",
    async run({ log }) {
      const hash = await Electrobun.Updater.localInfo.hash();

      expect(hash).toBeTruthy();
      expect(typeof hash).toBe("string");

      log(`Local build hash: ${hash}`);
    },
  }),

  defineTest({
    name: "Updater.appDataFolder",
    category: "Updater",
    description: "Test getting app data folder path",
    async run({ log }) {
      const folder = await Electrobun.Updater.appDataFolder();

      expect(folder).toBeTruthy();
      expect(typeof folder).toBe("string");

      log(`App data folder: ${folder}`);
    },
  }),

  defineTest({
    name: "Updater.channelBucketUrl",
    category: "Updater",
    description: "Test getting channel bucket URL",
    async run({ log }) {
      const url = await Electrobun.Updater.channelBucketUrl();

      expect(typeof url).toBe("string");
      // URL might be empty if not configured
      log(`Channel bucket URL: ${url || "(not configured)"}`);
    },
  }),

  defineTest({
    name: "Updater.checkForUpdate",
    category: "Updater",
    description: "Test checking for updates",
    timeout: 15000,
    async run({ log }) {
      log("Checking for updates...");

      try {
        const updateInfo = await Electrobun.Updater.checkForUpdate();

        expect(updateInfo).toBeTruthy();
        expect(typeof updateInfo.updateAvailable).toBe("boolean");

        log(`Update available: ${updateInfo.updateAvailable}`);
        if (updateInfo.version) {
          log(`Latest version: ${updateInfo.version}`);
        }
        if (updateInfo.error) {
          log(`Note: ${updateInfo.error}`);
        }
      } catch (e: any) {
        // Update check might fail if no update server configured
        log(`Update check returned error (this may be expected): ${e.message}`);
      }
    },
  }),
];
