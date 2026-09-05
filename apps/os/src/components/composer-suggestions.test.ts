import { describe, expect, test } from "vitest";
import {
  activeComposerSuggestion,
  composerSuggestionEdit,
  type ComposerSuggestionProvider,
} from "./composer-suggestions.ts";

const suggestions = [
  {
    id: "agents",
    label: "AGENTS.md",
    completion: {
      type: "attachment" as const,
      display: "@AGENTS.md",
      target: {
        type: "repo-file" as const,
        repoPath: "/repos/config" as const,
        path: "AGENTS.md",
      },
    },
  },
  {
    id: "composer",
    label: "src/components/agent-pill-composer.tsx",
    completion: { type: "text" as const, text: "@src/components/agent-pill-composer.tsx" },
  },
  { id: "worker", label: "worker.ts", completion: { type: "text" as const, text: "@worker.ts" } },
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

test("composerSuggestionEdit replaces the whole token and restores a useful caret", () => {
  const value = "read @agent-old next";
  const active = activeComposerSuggestion(value, 11, [provider]);
  if (active === null) throw new Error("expected an active suggestion");

  expect(composerSuggestionEdit(value, active.from, active.to, suggestions[0]!)).toEqual({
    insert: "@AGENTS.md",
    caret: 16,
    attachment: {
      display: "@AGENTS.md",
      from: 5,
      target: { type: "repo-file", repoPath: "/repos/config", path: "AGENTS.md" },
      to: 15,
    },
  });
});
