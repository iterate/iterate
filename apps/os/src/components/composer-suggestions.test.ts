import { describe, expect, test } from "vitest";
import {
  activeComposerSuggestion,
  applyComposerSuggestion,
  type ComposerSuggestionProvider,
} from "./composer-suggestions.ts";

const suggestions = [
  { id: "agents", label: "AGENTS.md", text: "@AGENTS.md" },
  {
    id: "composer",
    label: "src/components/agent-pill-composer.tsx",
    text: "@src/components/agent-pill-composer.tsx",
  },
  { id: "worker", label: "worker.ts", text: "@worker.ts" },
];

const provider: ComposerSuggestionProvider = {
  id: "files",
  trigger: "@",
  label: "Files",
  cacheKey: ["test"],
  search: async () => suggestions,
};

describe("activeComposerSuggestion", () => {
  test("finds the provider token at the caret and its complete replacement range", () => {
    expect(activeComposerSuggestion("please read @agent-old next", 18, [provider])).toMatchObject({
      provider,
      query: "agent",
      from: 12,
      to: 22,
    });
  });

  test("requires a word boundary so email addresses remain ordinary text", () => {
    expect(activeComposerSuggestion("hello@example.com", 13, [provider])).toBeNull();
  });

  test("uses the last matching provider token", () => {
    const value = "compare @worker.ts with @agent";
    expect(activeComposerSuggestion(value, value.length, [provider])).toMatchObject({
      query: "agent",
      from: 24,
    });
  });
});

test("applyComposerSuggestion replaces the whole token and restores a useful caret", () => {
  const value = "read @agent-old next";
  const active = activeComposerSuggestion(value, 11, [provider]);
  if (active === null) throw new Error("expected an active suggestion");

  expect(applyComposerSuggestion(value, active, suggestions[0]!)).toEqual({
    value: "read @AGENTS.md next",
    caret: 15,
  });
});
