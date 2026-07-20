import { expect, test } from "vitest";
import { llmResponseForDisplay } from "./activity-display.ts";

test("hides the internal model response whenever the activity has parsed execution code", () => {
  expect(llmResponseForDisplay("```ts\nconst generated = true;\n```", true)).toBe("");
});

test("keeps the model response while no execution step exists", () => {
  expect(llmResponseForDisplay("```ts\nconst answer = 42;\n```", false)).toBe(
    "```ts\nconst answer = 42;\n```",
  );
});
