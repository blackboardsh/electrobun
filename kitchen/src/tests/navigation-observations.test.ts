import { describe, expect, test } from "bun:test";
import { assertBlockedNavigation } from "./navigation-observations";

const initial = "views://test-harness/index.html";
const target = "https://google.com";
const denied = JSON.stringify({ url: `${target}/`, allowed: false });
type Event = { type: "will" | "did"; detail: unknown };

function replay(events: Event[]) {
  const attempts: unknown[] = [];
  const commits: unknown[] = [];
  for (const event of events) {
    (event.type === "will" ? attempts : commits).push(event.detail);
  }
  assertBlockedNavigation(initial, target, attempts, commits);
}

describe("blocked navigation event attribution", () => {
  test("requires a denied target and tolerates late initial-page completion before or after it", () => {
    const attempt: Event = { type: "will", detail: denied };
    const completion: Event = { type: "did", detail: initial };
    replay([attempt]);
    replay([completion, attempt]);
    replay([attempt, completion]);
    replay([
      { type: "will", detail: JSON.stringify({ url: initial, allowed: true }) },
      attempt, completion,
    ]);
  });

  test("handles WebView2 JSON completion without ignoring other URLs", () => {
    replay([{ type: "will", detail: denied }, { type: "did", detail: JSON.stringify({ url: initial }) }]);
    expect(() => replay([
      { type: "will", detail: denied },
      { type: "did", detail: JSON.stringify({ url: `${target}/` }) },
    ])).toThrow("unexpected committed navigation");
  });

  test("rejects blocked, redirected, and unexpected destinations even after explicit denial", () => {
    for (const url of [
      target, `${target}/`, "https://www.google.com/", "https://blackboard.sh/redirect",
      "https://unexpected.example/", "views://test-runner/index.html",
      `${initial}?unexpected=1`, `${initial}#unexpected`, "about:blank", "",
    ]) {
      expect(() => replay([
        { type: "will", detail: denied },
        { type: "did", detail: initial },
        { type: "did", detail: url },
      ])).toThrow("unexpected committed navigation");
    }
  });

  test("a missing, unrelated, or nonboolean denial cannot prove the target was blocked", () => {
    expect(() => replay([])).toThrow("missing explicit denial");
    for (const detail of [
      JSON.stringify({ url: "https://another.example/", allowed: false }),
      JSON.stringify({ url: "https://google.com.evil.example/", allowed: false }),
      JSON.stringify({ url: `${target}/`, allowed: true }),
      JSON.stringify({ url: `${target}/`, allowed: "false" }),
      JSON.stringify({ url: `${target}/` }),
      target, null, {},
    ]) {
      expect(() => replay([{ type: "will", detail }, { type: "did", detail: initial }])).toThrow();
    }
  });

  test("a denied event cannot hide another decision allowing the same target", () => {
    for (const attempts of [
      [denied, JSON.stringify({ url: `${target}/`, allowed: true })],
      [JSON.stringify({ url: target, allowed: true }), denied],
    ]) {
      expect(() => replay(attempts.map((detail) => ({ type: "will", detail })))).toThrow("blocked target was allowed");
    }
  });

  test("malformed completion details fail instead of being treated as the initial page", () => {
    for (const detail of [null, undefined, {}, JSON.stringify({}), { url: false }]) {
      expect(() => replay([{ type: "will", detail: denied }, { type: "did", detail }])).toThrow("invalid committed navigation");
    }
  });
});
