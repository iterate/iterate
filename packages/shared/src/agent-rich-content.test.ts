import { describe, expect, test } from "vitest";
import {
  agentRichContentFromEditorDocument,
  agentRichContentToEditorDocument,
  decodeAgentRichContent,
  deriveAgentContextRepoFileRefs,
  flattenAgentRichContent,
  type AgentRichContentV1,
} from "./agent-rich-content.ts";

const document = {
  version: 1,
  nodes: [
    { type: "text", text: "Read " },
    {
      type: "reference",
      occurrenceId: "first",
      display: "@AGENTS.md",
      target: { kind: "config-repo-file", repoPath: "/repos/config", path: "AGENTS.md" },
    },
    { type: "text", text: " and " },
    {
      type: "reference",
      occurrenceId: "second",
      display: "@AGENTS.md",
      target: { kind: "config-repo-file", repoPath: "/repos/config", path: "AGENTS.md" },
    },
  ],
} satisfies AgentRichContentV1;

describe("agent rich-content codec", () => {
  test("round-trips duplicate occurrences while deriving one repo coordinate", () => {
    const editor = agentRichContentToEditorDocument(document);
    expect(agentRichContentFromEditorDocument(editor.text, editor.references)).toEqual(document);
    expect(deriveAgentContextRepoFileRefs(document)).toEqual([
      { type: "repo-file", repoPath: "/repos/config", path: "AGENTS.md" },
    ]);
  });

  test("rejects projection mismatches and unknown versions without losing plain text", () => {
    expect(decodeAgentRichContent(flattenAgentRichContent(document), document)).toEqual(document);
    expect(decodeAgentRichContent("different", document)).toBeNull();
    expect(decodeAgentRichContent("plain fallback", { version: 2, nodes: [] })).toBeNull();
  });

  test("drops a stale editor range but preserves its visible text", () => {
    const editor = agentRichContentToEditorDocument(document);
    const text = editor.text.replace("@AGENTS.md", "@OTHERS.md");
    const encoded = agentRichContentFromEditorDocument(text, editor.references);
    expect(flattenAgentRichContent(encoded)).toBe(text);
    expect(encoded.nodes.filter((node) => node.type === "reference")).toHaveLength(1);
  });
});
