import { expect, test } from "vitest";
import { looksLikeCode } from "./activity-display.ts";

// (llmResponseForDisplay is gone: rounds with a code step no longer render
// the raw response at all — the Script tab, chat bubbles, and Meta →
// response carry it — so there is nothing left to dedupe.)

test("code-looking responses: fences, code-ish first tokens, codemode tags", () => {
  expect(looksLikeCode("```ts\nconst x = 1;\n```")).toBe(true);
  expect(looksLikeCode("async (itx) => 1")).toBe(true);
  expect(looksLikeCode('Hi!\n<codemode status="Working">\nreturn 1\n</codemode>')).toBe(true);
});

test("prose responses stay prose — even mentioning a <codemode> tag mid-line", () => {
  expect(looksLikeCode("The request succeeded.")).toBe(false);
  expect(looksLikeCode("\\[ 42 = 6 \\times 7 \\]")).toBe(false);
  expect(looksLikeCode("use a <codemode> tag to run code")).toBe(false);
});
