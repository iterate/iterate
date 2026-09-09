import { describe, expect, test } from "vitest";
import {
  agentMessageFromEditorDocument,
  agentMessageToEditorDocument,
  configRepoFileMentionId,
  decodeMessageMentions,
  type Message,
  type Mention,
} from "./message.ts";

const mention = {
  id: "config-repo/AGENTS.md",
  type: "repo-file",
  repoPath: "/repos/config",
  path: "AGENTS.md",
} satisfies Mention;

describe("agent message mention codec", () => {
  test("plain messages accept omitted or empty mentions and serialize without metadata", () => {
    const plain: Message = { content: "Hello" };
    const explicitEmpty: Message = { content: "Hello", mentions: [] };
    for (const message of [plain, explicitEmpty]) {
      const editor = agentMessageToEditorDocument(message);
      expect(editor).toEqual({ text: "Hello", mentions: [] });
      expect(agentMessageFromEditorDocument(editor.text, editor.mentions)).toEqual(plain);
    }
    expect(decodeMessageMentions("Hello", [])).toEqual({
      text: "Hello",
      mentions: [],
      ranges: [],
    });
  });
  test("round-trips repeated Markdown-like links through one mention", () => {
    const message = {
      content:
        "Read [@AGENTS.md](mention://config-repo/AGENTS.md) and [@AGENTS.md](mention://config-repo/AGENTS.md)",
      mentions: [mention],
    };
    const editor = agentMessageToEditorDocument(message);
    expect(editor.text).toBe("Read @AGENTS.md and @AGENTS.md");
    expect(editor.mentions).toHaveLength(2);
    expect(agentMessageFromEditorDocument(editor.text, editor.mentions)).toEqual(message);
  });

  test("rejects missing, dangling, duplicate, and malformed mention metadata", () => {
    const content = "Read [@AGENTS.md](mention://config-repo/AGENTS.md)";
    expect(decodeMessageMentions(content, [])).toBeNull();
    expect(decodeMessageMentions("plain fallback", [mention])).toBeNull();
    expect(decodeMessageMentions(content, [mention, mention])).toBeNull();
    expect(decodeMessageMentions(content, [{ ...mention, path: "../secret" }])).toBeNull();
  });

  test("does not interpret the old ref URI scheme as a mention", () => {
    expect(
      decodeMessageMentions("Read [@AGENTS.md](ref://config-repo/AGENTS.md)", [mention]),
    ).toBeNull();
  });

  test("drops a stale editor range but preserves its readable label", () => {
    const message = {
      content: "Read [@AGENTS.md](mention://config-repo/AGENTS.md)",
      mentions: [mention],
    };
    const editor = agentMessageToEditorDocument(message);
    const text = editor.text.replace("@AGENTS.md", "@OTHERS.md");
    expect(agentMessageFromEditorDocument(text, editor.mentions)).toEqual({
      content: "Read @OTHERS.md",
    });
  });

  test("escapes labels and creates readable deterministic config-repo ids", () => {
    const target = {
      id: configRepoFileMentionId("docs/a file [draft].md"),
      type: "repo-file" as const,
      repoPath: "/repos/config" as const,
      path: "docs/a file [draft].md",
    };
    const encoded = agentMessageFromEditorDocument("@docs/a file [draft].md", [
      { mention: target, display: "@docs/a file [draft].md", from: 0, to: 23 },
    ]);
    expect(encoded.content).toBe(
      "[@docs/a file \\[draft\\].md](mention://config-repo/docs/a%20file%20%5Bdraft%5D.md)",
    );
    expect(agentMessageToEditorDocument(encoded).text).toBe("@docs/a file [draft].md");
  });

  test("percent-encodes filename punctuation omitted by encodeURIComponent", () => {
    const path = "docs/!'()*.md";
    const id = configRepoFileMentionId(path);
    const punctuationAttachment = {
      id,
      type: "repo-file" as const,
      repoPath: "/repos/config" as const,
      path,
    };
    const message = {
      content: `[@${path}](mention://${id})`,
      mentions: [punctuationAttachment],
    };

    expect(id).toBe("config-repo/docs/%21%27%28%29%2A.md");
    expect(agentMessageToEditorDocument(message)).toEqual({
      text: `@${path}`,
      mentions: [
        {
          mention: punctuationAttachment,
          display: `@${path}`,
          from: 0,
          to: 14,
        },
      ],
    });
  });
});
