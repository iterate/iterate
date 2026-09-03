import { describe, expect, test } from "vitest";
import { parseReferences, referenceQueryBefore, type ReferenceKind } from "./references.ts";

const KINDS: ReferenceKind[] = [
  {
    kind: "agent",
    label: (target) => `Agent ${target}`,
    pattern: /@(\/agents\/[A-Za-z0-9_./-]*[A-Za-z0-9_/-])/g,
    trigger: "@",
  },
  {
    kind: "note",
    label: (target) => `Note ${target}`,
    pattern: /\[\[(notes\/[^\]\n]+)\]\]/g,
    trigger: "[[",
  },
];

describe("references", () => {
  test("finds every reference in document order with offsets over the whole syntax", () => {
    const text = "ask @/agents/researcher about [[notes/ideas]] and @/agents/ops.";
    expect(parseReferences(text, KINDS)).toEqual([
      { from: 4, kind: "agent", target: "/agents/researcher", text: "@/agents/researcher", to: 23 },
      { from: 30, kind: "note", target: "notes/ideas", text: "[[notes/ideas]]", to: 45 },
      { from: 50, kind: "agent", target: "/agents/ops", text: "@/agents/ops", to: 62 },
    ]);
  });

  test("ignores text that merely looks close", () => {
    expect(parseReferences("mail me@example.com or see [[tasks/x]]", KINDS)).toEqual([]);
    expect(parseReferences("@/agents/", KINDS)).toEqual([]);
  });

  test("the query before the caret knows both triggers", () => {
    expect(referenceQueryBefore("ping @/agents/res")).toEqual({
      from: 5,
      query: "/agents/res",
      trigger: "@",
    });
    expect(referenceQueryBefore("see [[not")).toEqual({ from: 4, query: "not", trigger: "[[" });
    expect(referenceQueryBefore("see [[notes/ideas]] done")).toBeNull();
    expect(referenceQueryBefore("mail me@example")).toBeNull();
    expect(referenceQueryBefore("(@ops")).toEqual({ from: 1, query: "ops", trigger: "@" });
  });
});
