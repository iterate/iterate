import { expect, test } from "vitest";
import { llmResponseForDisplay } from "./activity-display.ts";

test("hides a fenced model response duplicated by the following execution step", () => {
  expect(
    llmResponseForDisplay("```ts\nconst generated = true;\n```", "const generated = true;"),
  ).toBe("");
});

test("keeps a later model explanation after code has run", () => {
  expect(llmResponseForDisplay("The request succeeded.", undefined)).toBe("The request succeeded.");
});

test("keeps a model response that differs from the following execution step", () => {
  expect(llmResponseForDisplay("```ts\nconst answer = 42;\n```", "const answer = 43;")).toBe(
    "```ts\nconst answer = 42;\n```",
  );
});
