import { expect, test } from "vitest";
import { analyzeNoteText } from "./analysis.ts";

test("note analysis uses the caller's model and records it in the result", async () => {
  const calls: unknown[] = [];
  const model = "intercepted/@cf/meta/llama-4-scout-17b-16e-instruct";
  const result = await analyzeNoteText(
    {
      async run(model, body) {
        calls.push({ model, body });
        return { response: JSON.stringify({ title: "Standing desk: 76cm", tags: ["reference"] }) };
      },
    },
    { text: "Standing desk height: 76cm" },
    model,
  );
  expect(calls).toMatchObject([{ model, body: { max_tokens: 256 } }]);
  expect(result).toEqual({ title: "Standing desk: 76cm", tags: ["reference"], processedBy: model });
});
