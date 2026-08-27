// The fixture machinery itself: elapsed-time labels, event synthesis (batch
// expansion, derived expiry), comment weaving (✂ cache cut + annotations),
// and in-place fixture regeneration. The scenario fixtures' own freshness is
// asserted by prompt-scenarios.test.ts; this file exercises the helpers on
// small inline data.

import { expect, test } from "vitest";
import {
  formatElapsed,
  parseElapsed,
  regenerateFixtureText,
  synthesizeEvents,
  weaveComments,
  yamlifyValue,
} from "./fixture-helpers.ts";

test("elapsed-time labels round-trip the explainer's vocabulary", () => {
  expect(parseElapsed("0ms")).toBe(0);
  expect(parseElapsed("250ms")).toBe(250);
  expect(parseElapsed("4.2s")).toBe(4200);
  expect(parseElapsed("10m 16.3s")).toBe(616_300);
  expect(parseElapsed("3m–19m")).toBe(19 * 60_000);
  expect(formatElapsed(250)).toBe("250ms");
  expect(formatElapsed(4200)).toBe("4.2s");
  expect(formatElapsed(61_000)).toBe("61s");
  expect(formatElapsed(21 * 60_000 + 4000)).toBe("21m 4s");
});

test("a sections payload expands into one keyed event per section, offsets off..off+N-1", () => {
  const events = synthesizeEvents({
    off: 10,
    t: "0ms",
    type: "agents/context-added",
    payload: {
      role: "system",
      sections: [
        { key: "identity", content: "You are the test agent." },
        { key: "gotchas", content: "Await handles." },
      ],
    },
  });
  expect(events).toMatchObject([
    {
      offset: 10,
      payload: { role: "system", key: "identity", content: "You are the test agent." },
    },
    { offset: 11, payload: { role: "system", key: "gotchas", content: "Await handles." } },
  ]);
});

test("a requested event without expiresAt gets a derived scheduling horizon; an explicit one wins", () => {
  const [derived] = synthesizeEvents({
    off: 26,
    t: "4.5s",
    type: "agent/llm-request-requested",
    payload: { model: "test-model" },
  });
  expect(derived!.payload).toMatchObject({ model: "test-model", expiresAt: expect.any(Number) });
  const [explicit] = synthesizeEvents({
    off: 26,
    t: "4.5s",
    type: "agent/llm-request-requested",
    payload: { model: "test-model", expiresAt: 123 },
  });
  expect(explicit!.payload).toMatchObject({ expiresAt: 123 });
});

test("the ✂ cut lands where the request diverges from the previous one", () => {
  const woven = weaveComments({
    plainLines: ["model: m", "messages:", "  - role: user", '    content: "hi"'],
    previousPlainLines: ["model: m", "messages:"],
    annotations: [],
    context: "test",
  });
  expect(woven.split("\n")[2]).toContain("✂ provider cache");
});

test("annotations insert above the first matching line; a stale find fails loudly", () => {
  const woven = weaveComments({
    plainLines: ["model: m", "messages:", "  - role: user", '    content: "hi"'],
    previousPlainLines: null,
    annotations: [{ request: "@1", find: 'content: "hi"', comment: "the greeting" }],
    context: "test",
  });
  expect(woven.split("\n")).toEqual([
    "model: m",
    "messages:",
    "  - role: user",
    "    # the greeting",
    '    content: "hi"',
    "",
  ]);
  expect(() =>
    weaveComments({
      plainLines: ["model: m"],
      previousPlainLines: null,
      annotations: [{ request: "@1", find: "no such line", comment: "stale" }],
      context: "test",
    }),
  ).toThrow(/matches no rendered line/);
});

test("regeneration preserves the hand-authored head and rebuilds the request blocks", () => {
  const original = [
    "# Scenario X",
    "",
    "intro",
    "",
    "<details>",
    "<summary>events</summary>",
    "",
    "```yaml (events.yaml)",
    "id: x",
    "events: []",
    "```",
    "",
    "</details>",
    "",
    "<details>",
    "<summary>request @9</summary>",
    "",
    "```yaml (request@9.yaml)",
    "stale: content",
    "```",
    "",
    "</details>",
    "",
  ].join("\n");
  const regenerated = regenerateFixtureText(original, [{ offset: 5, content: "model: m\n" }]);
  expect(regenerated).toContain("<summary>request @5</summary>");
  expect(regenerated).toContain("```yaml (request@5.yaml)\nmodel: m\n```");
  expect(regenerated).not.toContain("stale: content");
  expect(regenerated).toContain("id: x");
});

test("yamlifyValue prints event payloads deterministically, block scalars for multiline strings", () => {
  expect(
    yamlifyValue(
      {
        role: "assistant",
        content: "line one\nline two",
        llmRequestOffset: 26,
        nested: { flag: true },
        list: [{ key: "identity" }],
      },
      "",
    ),
  ).toEqual([
    'role: "assistant"',
    "content: |-",
    "  line one",
    "  line two",
    "llmRequestOffset: 26",
    "nested:",
    "  flag: true",
    "list:",
    '  - key: "identity"',
  ]);
});
