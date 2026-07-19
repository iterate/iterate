import { expect, test } from "vitest";
import { responseWithoutParsedCode } from "./activity-display.ts";

test("hides a fenced model response once the same code has a parsed execution step", () => {
  const code = `async (itx) => {
  await itx.chat.sendMessage("Great!");
}`;

  expect(responseWithoutParsedCode(`\`\`\`ts\n${code}\n\`\`\``, [code])).toBe("");
});

test("keeps model prose while removing its redundant parsed code fence", () => {
  const code = "return await itx.repos.get('config');";

  expect(
    responseWithoutParsedCode(`I’ll inspect the repository.\n\n\`\`\`ts\n${code}\n\`\`\``, [code]),
  ).toBe("I’ll inspect the repository.");
});

test("keeps an unparsed fenced response visible while it is streaming", () => {
  expect(responseWithoutParsedCode("```ts\nconst answer = 42;\n```", [])).toBe(
    "```ts\nconst answer = 42;\n```",
  );
});
