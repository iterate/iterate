import { describe, expect, test } from "vitest";
import {
  agentMessageFromEditorDocument,
  agentMessageToEditorDocument,
  configRepoFileReferenceId,
  decodeMessageReferences,
  type Message,
  type Reference,
} from "./message.ts";

const reference = {
  id: "config-repo/AGENTS.md",
  type: "repo-file",
  repoPath: "/repos/config",
  path: "AGENTS.md",
} satisfies Reference;

describe("agent message reference codec", () => {
  test("plain messages accept omitted or empty references and serialize without metadata", () => {
    const plain: Message = { content: "Hello" };
    const explicitEmpty: Message = { content: "Hello", references: [] };
    for (const message of [plain, explicitEmpty]) {
      const editor = agentMessageToEditorDocument(message);
      expect(editor).toEqual({ text: "Hello", references: [] });
      expect(agentMessageFromEditorDocument(editor.text, editor.references)).toEqual(plain);
    }
    expect(decodeMessageReferences("Hello", [])).toEqual({
      text: "Hello",
      references: [],
      ranges: [],
    });
  });
  test("round-trips repeated Markdown-like links through one reference", () => {
    const message = {
      content:
        "Read [@AGENTS.md](ref://config-repo/AGENTS.md) and [@AGENTS.md](ref://config-repo/AGENTS.md)",
      references: [reference],
    };
    const editor = agentMessageToEditorDocument(message);
    expect(editor.text).toBe("Read @AGENTS.md and @AGENTS.md");
    expect(editor.references).toHaveLength(2);
    expect(agentMessageFromEditorDocument(editor.text, editor.references)).toEqual(message);
  });

  test("rejects missing, dangling, duplicate, and malformed reference metadata", () => {
    const content = "Read [@AGENTS.md](ref://config-repo/AGENTS.md)";
    expect(decodeMessageReferences(content, [])).toBeNull();
    expect(decodeMessageReferences("plain fallback", [reference])).toBeNull();
    expect(decodeMessageReferences(content, [reference, reference])).toBeNull();
    expect(decodeMessageReferences(content, [{ ...reference, path: "../secret" }])).toBeNull();
  });

  test("drops a stale editor range but preserves its readable label", () => {
    const message = {
      content: "Read [@AGENTS.md](ref://config-repo/AGENTS.md)",
      references: [reference],
    };
    const editor = agentMessageToEditorDocument(message);
    const text = editor.text.replace("@AGENTS.md", "@OTHERS.md");
    expect(agentMessageFromEditorDocument(text, editor.references)).toEqual({
      content: "Read @OTHERS.md",
    });
  });

  test("escapes labels and creates readable deterministic config-repo ids", () => {
    const target = {
      id: configRepoFileReferenceId("docs/a file [draft].md"),
      type: "repo-file" as const,
      repoPath: "/repos/config" as const,
      path: "docs/a file [draft].md",
    };
    const encoded = agentMessageFromEditorDocument("@docs/a file [draft].md", [
      { reference: target, display: "@docs/a file [draft].md", from: 0, to: 23 },
    ]);
    expect(encoded.content).toBe(
      "[@docs/a file \\[draft\\].md](ref://config-repo/docs/a%20file%20%5Bdraft%5D.md)",
    );
    expect(agentMessageToEditorDocument(encoded).text).toBe("@docs/a file [draft].md");
  });

  test("percent-encodes filename punctuation omitted by encodeURIComponent", () => {
    const path = "docs/!'()*.md";
    const id = configRepoFileReferenceId(path);
    const punctuationAttachment = {
      id,
      type: "repo-file" as const,
      repoPath: "/repos/config" as const,
      path,
    };
    const message = {
      content: `[@${path}](ref://${id})`,
      references: [punctuationAttachment],
    };

    expect(id).toBe("config-repo/docs/%21%27%28%29%2A.md");
    expect(agentMessageToEditorDocument(message)).toEqual({
      text: `@${path}`,
      references: [
        {
          reference: punctuationAttachment,
          display: `@${path}`,
          from: 0,
          to: 14,
        },
      ],
    });
  });
});
