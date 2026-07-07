import { expect, test } from "vitest";
import { parseChatBangCommand } from "./chat-bang-command.ts";

test("recognises !share and !unshare, case- and whitespace-insensitively", () => {
  expect(parseChatBangCommand("!share")).toEqual({ kind: "share" });
  expect(parseChatBangCommand("  !SHARE  ")).toEqual({ kind: "share" });
  expect(parseChatBangCommand("!unshare")).toEqual({ kind: "unshare" });
});

test("leaves normal messages and unknown bang commands alone", () => {
  expect(parseChatBangCommand("share my screen please")).toBeNull();
  expect(parseChatBangCommand("!debug")).toBeNull();
  expect(parseChatBangCommand("what does !share do?")).toBeNull();
});
