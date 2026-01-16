// Session/Cookie API Tests

import { defineTest, expect } from "../test-framework/types";
import { Session } from "electrobun/bun";

export const sessionTests = [
  defineTest({
    name: "Session.fromPartition",
    category: "Session",
    description: "Test creating a session from a partition name",
    async run({ log }) {
      const session = Session.fromPartition("persist:test-partition");

      expect(session).toBeTruthy();
      expect(session.partition).toBe("persist:test-partition");

      log(`Created session for partition: ${session.partition}`);
    },
  }),

  defineTest({
    name: "Session.defaultSession",
    category: "Session",
    description: "Test accessing the default session",
    async run({ log }) {
      const session = Session.defaultSession;

      expect(session).toBeTruthy();
      expect(session.partition).toBeTruthy();

      log(`Default session partition: ${session.partition}`);
    },
  }),

  defineTest({
    name: "cookies API exists",
    category: "Session",
    description: "Test that cookies API methods exist",
    async run({ log }) {
      const session = Session.fromPartition("persist:cookie-api-test");

      // Test that all cookie methods exist
      expect(typeof session.cookies.set).toBe("function");
      expect(typeof session.cookies.get).toBe("function");
      expect(typeof session.cookies.remove).toBe("function");
      expect(typeof session.cookies.clear).toBe("function");

      log("All cookies API methods exist");
    },
  }),

  // DISABLED: Causes AVX crash in ARM Windows VM
  // defineTest({
  //   name: "cookies.set call",
  //   category: "Session",
  //   description: "Test calling cookies.set without error",
  //   async run({ log }) {
  //     const session = Session.fromPartition("persist:cookie-set-test");

  //     log("Setting test cookie");
  //     // Just test that the call doesn't throw
  //     const result = session.cookies.set({
  //       name: "test-cookie",
  //       value: "test-value-123",
  //       domain: "localhost",
  //       path: "/",
  //       secure: false,
  //       httpOnly: false,
  //       sameSite: "lax",
  //       expirationDate: Math.floor(Date.now() / 1000) + 3600,
  //     });

  //     // We expect this to return something (true/false or a result)
  //     log(`cookies.set returned: ${result}`);
  //   },
  // }),

  // DISABLED: Causes AVX crash in ARM Windows VM
  // defineTest({
  //   name: "cookies.get call",
  //   category: "Session",
  //   description: "Test calling cookies.get without error",
  //   async run({ log }) {
  //     const session = Session.fromPartition("persist:cookie-get-test");

  //     log("Getting all cookies");
  //     const allCookies = session.cookies.get();
  //     expect(Array.isArray(allCookies)).toBe(true);

  //     log(`cookies.get returned ${allCookies.length} cookies`);
  //   },
  // }),

  // DISABLED: Causes AVX crash in ARM Windows VM
  // defineTest({
  //   name: "cookies.clear call",
  //   category: "Session",
  //   description: "Test calling cookies.clear without error",
  //   async run({ log }) {
  //     const session = Session.fromPartition("persist:cookie-clear-test");

  //     log("Clearing all cookies");
  //     // Just verify this doesn't throw
  //     session.cookies.clear();

  //     log("cookies.clear completed without error");
  //   },
  // }),
];
