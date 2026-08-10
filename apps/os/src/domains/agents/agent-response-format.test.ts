// Pure unit tests for the fenced-ts response format — the strategy half of
// response parsing. The processor-level consequences (what gets appended for
// each outcome, the open-request gate) stay in agent-processor.test.ts; this
// file pins the pure content → outcome mapping, including the fence-inside-
// string-literal production incident.

import { expect, test } from "vitest";
import { fencedTsResponseFormat } from "./agent-response-format.ts";

test("a single ```ts fence with a leading-async arrow is a script", () => {
  const outcome = fencedTsResponseFormat.parse(
    "```ts\nasync (itx) => {\n  return await itx.__describe();\n}\n```",
  );
  expect(outcome).toMatchObject({
    kind: "script",
    code: "async (itx) => {\n  return await itx.__describe();\n}",
  });
});

test("an unfenced response that IS a leading-async function still runs", () => {
  expect(fencedTsResponseFormat.parse("async (itx) => {\n  return 1;\n}")).toMatchObject({
    kind: "script",
  });
});

test("a fence containing ``` inside a template literal executes in full", () => {
  // The production incident: fences only count at line starts, so a script
  // sending a markdown-formatted chat message must not be cut at the first
  // embedded ``` (which would execute an unparseable prefix with an unclosed
  // string literal).
  const code = [
    "async (itx) => {",
    "  await itx.chat.sendMessage(`Here is some code:\\n\\`\\`\\`ts\\nconst x = 1;\\n\\`\\`\\``);",
    '  await itx.chat.sendMessage("inline ``` mention too");',
    "}",
  ].join("\n");
  expect(fencedTsResponseFormat.parse(`\`\`\`ts\n${code}\n\`\`\``)).toMatchObject({
    kind: "script",
    code,
  });
});

test("two fenced blocks reject the whole response, counting them in the feedback", () => {
  const outcome = fencedTsResponseFormat.parse(
    "```ts\nasync (itx) => 1\n```\nand then\n```ts\nasync (itx) => 2\n```",
  );
  expect(outcome).toMatchObject({ kind: "multiple" });
  expect((outcome as { feedback: string }).feedback).toContain("2 fenced code blocks");
});

test("a fence whose body does not start with async is malformed", () => {
  // Models habitually open code with a comment line; silence here reads as
  // the platform hanging, so the outcome carries corrective feedback.
  expect(
    fencedTsResponseFormat.parse("```ts\n// first, describe\nasync (itx) => 1\n```"),
  ).toMatchObject({ kind: "malformed", feedback: expect.stringContaining("STARTS with `async`") });
});

test("a non-TypeScript language tag is malformed, not silently ignored", () => {
  expect(fencedTsResponseFormat.parse("```python\nprint('hi')\n```")).toMatchObject({
    kind: "malformed",
  });
});

test("prose with no fence at all is a deliberate no-op turn", () => {
  expect(
    fencedTsResponseFormat.parse("I have finished the task. Let me know what's next."),
  ).toEqual({ kind: "none" });
});
