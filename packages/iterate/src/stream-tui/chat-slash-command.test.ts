import { expect, test } from "vitest";
import { computerCapabilityName, parseChatSlashCommand } from "./chat-slash-command.ts";

test("recognises /use-my-computer without turning nearby text into a command", () => {
  expect(parseChatSlashCommand("/use-my-computer")).toEqual({ kind: "use-my-computer" });
  expect(parseChatSlashCommand("  /USE-MY-COMPUTER  ")).toEqual({ kind: "use-my-computer" });
  expect(parseChatSlashCommand("please /use-my-computer")).toBeNull();
  expect(parseChatSlashCommand("/use-my-computer now")).toBeNull();
  expect(parseChatSlashCommand("/unknown")).toBeNull();
});

test("turns the operating-system username into a valid personal computer capability name", () => {
  expect(computerCapabilityName("joebloggs")).toBe("joebloggsComputer");
  expect(computerCapabilityName("joe-bloggs")).toBe("joeBloggsComputer");
  expect(computerCapabilityName("123-joe")).toBe("user123JoeComputer");
});
