import { describe, expect, test } from "vitest";
import {
  agentMessageFromEditorDocument,
  agentMessageToEditorDocument,
  configRepoFileAttachmentId,
  decodeAgentMessageAttachments,
  type AgentMessageAttachment,
} from "./agent-message-attachments.ts";

const attachment = {
  id: "config-repo/AGENTS.md",
  type: "repo-file",
  repoPath: "/repos/config",
  path: "AGENTS.md",
} satisfies AgentMessageAttachment;

describe("agent message attachment codec", () => {
  test("round-trips repeated Markdown-like links through one attachment", () => {
    const message = {
      content:
        "Read [@AGENTS.md](attachment:config-repo/AGENTS.md) and [@AGENTS.md](attachment:config-repo/AGENTS.md)",
      attachments: [attachment],
    };
    const editor = agentMessageToEditorDocument(message);
    expect(editor.text).toBe("Read @AGENTS.md and @AGENTS.md");
    expect(editor.references).toHaveLength(2);
    expect(agentMessageFromEditorDocument(editor.text, editor.references)).toEqual(message);
  });

  test("rejects missing, dangling, duplicate, and malformed attachment metadata", () => {
    const content = "Read [@AGENTS.md](attachment:config-repo/AGENTS.md)";
    expect(decodeAgentMessageAttachments(content, [])).toBeNull();
    expect(decodeAgentMessageAttachments("plain fallback", [attachment])).toBeNull();
    expect(decodeAgentMessageAttachments(content, [attachment, attachment])).toBeNull();
    expect(
      decodeAgentMessageAttachments(content, [{ ...attachment, path: "../secret" }]),
    ).toBeNull();
  });

  test("drops a stale editor range but preserves its readable label", () => {
    const message = {
      content: "Read [@AGENTS.md](attachment:config-repo/AGENTS.md)",
      attachments: [attachment],
    };
    const editor = agentMessageToEditorDocument(message);
    const text = editor.text.replace("@AGENTS.md", "@OTHERS.md");
    expect(agentMessageFromEditorDocument(text, editor.references)).toEqual({
      content: "Read @OTHERS.md",
      attachments: [],
    });
  });

  test("escapes labels and creates readable deterministic config-repo ids", () => {
    const target = {
      id: configRepoFileAttachmentId("docs/a file [draft].md"),
      type: "repo-file" as const,
      repoPath: "/repos/config" as const,
      path: "docs/a file [draft].md",
    };
    const encoded = agentMessageFromEditorDocument("@docs/a file [draft].md", [
      { attachment: target, display: "@docs/a file [draft].md", from: 0, to: 23 },
    ]);
    expect(encoded.content).toBe(
      "[@docs/a file \\[draft\\].md](attachment:config-repo/docs/a%20file%20%5Bdraft%5D.md)",
    );
    expect(agentMessageToEditorDocument(encoded).text).toBe("@docs/a file [draft].md");
  });
});
