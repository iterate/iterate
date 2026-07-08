import { expect, test } from "vitest";
import { parseChatSlashCommand } from "./chat-slash-command.ts";

test("recognises /share and /unshare, case- and whitespace-insensitively", () => {
  expect(parseChatSlashCommand("/share")).toEqual({ kind: "share" });
  expect(parseChatSlashCommand("  /SHARE  ")).toEqual({ kind: "share" });
  expect(parseChatSlashCommand("/unshare")).toEqual({ kind: "unshare" });
});

test("leaves normal messages and unknown slash commands alone", () => {
  expect(parseChatSlashCommand("share my screen please")).toBeNull();
  expect(parseChatSlashCommand("/help")).toBeNull();
  expect(parseChatSlashCommand("what does /share do?")).toBeNull();
});
