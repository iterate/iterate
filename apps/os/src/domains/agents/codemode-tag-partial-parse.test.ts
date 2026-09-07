import { describe, expect, test } from "vitest";
import {
  parseCodemodePartial,
  parseCodemodeResponse,
} from "../../../../../configs/codemode-tag/codemode-format.ts";

// The live-window half of the codemode-tag template's parser (the settled
// half, parseCodemodeResponse, is exercised through agent-response-format's
// grammar tests — this file covers what STREAMING adds: partial lines,
// mid-tag ambiguity, and convergence with the settled parse).

const FULL_RESPONSE = [
  "Good question! Let me look into it.",
  "",
  '<codemode status="Checking your files">',
  "const foo = await itx.doWhatever()",
  "return { abc: foo.bar }",
  "</codemode>",
  "",
  "Back shortly.",
].join("\n");

test("a response streaming token by token classifies prose and script progressively", () => {
  // Cut the response at every possible byte boundary — every prefix must
  // parse without ever showing tag syntax as prose.
  for (let cut = 0; cut <= FULL_RESPONSE.length; cut++) {
    const view = parseCodemodePartial(FULL_RESPONSE.slice(0, cut));
    expect(view.prose).not.toContain("<codemode");
    expect(view.prose).not.toContain("</codemode>");
    if (view.script) {
      expect(view.script.code).not.toContain("</codemode>");
    }
  }

  const beforeTag = parseCodemodePartial("Good question! Let me look into it.\n");
  expect(beforeTag).toMatchObject({ prose: "Good question! Let me look into it." });
  expect(beforeTag.script).toBeUndefined();

  const midTagLine = parseCodemodePartial("Good question! Let me look into it.\n<codemode stat");
  // The partial line might still become an opening tag — withheld from prose.
  expect(midTagLine).toMatchObject({ prose: "Good question! Let me look into it." });
  expect(midTagLine.script).toBeUndefined();

  const openTagStreamed = parseCodemodePartial(
    'Good question! Let me look into it.\n<codemode status="Checking your files">\nconst foo = aw',
  );
  expect(openTagStreamed).toMatchObject({
    prose: "Good question! Let me look into it.",
    script: { code: "const foo = aw", status: "Checking your files", closed: false },
  });

  const closed = parseCodemodePartial(FULL_RESPONSE);
  expect(closed).toMatchObject({
    prose: "Good question! Let me look into it.\n\nBack shortly.",
    script: {
      code: "const foo = await itx.doWhatever()\nreturn { abc: foo.bar }",
      status: "Checking your files",
      closed: true,
    },
  });
});

test("the complete text's partial view agrees with the settled parse", () => {
  const partial = parseCodemodePartial(FULL_RESPONSE);
  const settled = parseCodemodeResponse(FULL_RESPONSE);
  expect(settled).toMatchObject({
    kind: "script",
    status: "Checking your files",
    prose: "Good question! Let me look into it.\n\nBack shortly.",
  });
  if (settled.kind !== "script") throw new Error("unreachable: asserted above");
  // The settled code gains the async envelope; the raw body must match.
  expect(settled.code).toContain(partial.script!.code);
  expect(partial.prose).toBe(settled.prose);
});

test("prose-only responses stream as prose with no script", () => {
  const view = parseCodemodePartial("hello! the codemode-tag format is now active in this chat.");
  expect(view).toMatchObject({
    prose: "hello! the codemode-tag format is now active in this chat.",
  });
  expect(view.script).toBeUndefined();
});

test("mentioning <codemode> mid-sentence never opens a script", () => {
  const view = parseCodemodePartial("use a <codemode> tag when you want to run code\nok?\n");
  expect(view.script).toBeUndefined();
  expect(view.prose).toContain("use a <codemode> tag");
});

describe("live-vs-settled divergences are the documented ones only", () => {
  test("first closer ends the live script even when a later closer is the real one", () => {
    const trickyBody = ["<codemode>", "const s = `", "</codemode>", "`", "</codemode>", ""].join(
      "\n",
    );
    const partial = parseCodemodePartial(trickyBody);
    const settled = parseCodemodeResponse(trickyBody);
    // Live view stops at the first closer (cosmetic, mid-stream)…
    expect(partial.script).toMatchObject({ code: "const s = `", closed: true });
    // …while the settled parse applies the last-closer rule and keeps the
    // template literal intact.
    expect(settled).toMatchObject({ kind: "script" });
    if (settled.kind !== "script") throw new Error("unreachable: asserted above");
    expect(settled.code).toContain("const s = `\n</codemode>\n`");
  });

  test("a second opening tag streams as prose; the settled parse rejects the response", () => {
    const doubled = ["<codemode>", "return 1", "</codemode>", "<codemode>", "return 2", ""].join(
      "\n",
    );
    const partial = parseCodemodePartial(doubled);
    expect(partial.script).toMatchObject({ code: "return 1", closed: true });
    expect(partial.prose).toContain("<codemode");
    expect(parseCodemodeResponse(doubled)).toMatchObject({ kind: "multiple" });
  });
});
