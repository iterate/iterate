import { describe, expect, test } from "vitest";
import {
  acceptedSlashInput,
  findSlashCommand,
  formatSlashCommandLabel,
  formatSlashCommandLabelSegments,
  parseSlashAutocompleteQuery,
  suggestSlashCommands,
  type SlashCommandRecord,
} from "./command-discovery.ts";

const commands: SlashCommandRecord[] = [
  {
    path: "append.message",
    title: "Append message",
    description: "Append an agent-style user message",
    slash: { name: "append.message", aliases: ["message", "m"] },
    input: { positional: { name: "content", required: true } },
  },
  {
    path: "stream.reset",
    title: "Reset stream",
    description: "Destroy stream data",
    slash: { name: "stream.reset", aliases: ["reset"] },
    input: { flags: [{ name: "destroyChildren", flag: "--no-children", value: false }] },
  },
  {
    path: "view.state",
    title: "Show reduced state",
    description: "Inspect reducer state",
    slash: { name: "view.state", aliases: ["state"] },
  },
  {
    path: "feed.expand",
    title: "Expand all feed items",
    description: "Expand every raw event card",
    slash: { name: "feed.expand", aliases: ["expand"] },
  },
  {
    path: "view.hidden",
    title: "Hidden command",
    slash: { name: "hidden" },
    menu: { hidden: true },
  },
];

describe("parseSlashAutocompleteQuery", () => {
  test("only parses the slash command word before arguments are being entered", () => {
    expect(parseSlashAutocompleteQuery("/m")).toBe("m");
    expect(parseSlashAutocompleteQuery("/message hello")).toBeUndefined();
    expect(parseSlashAutocompleteQuery("plain message")).toBeUndefined();
  });
});

describe("suggestSlashCommands", () => {
  test("prioritizes exact aliases for short queries", () => {
    expect(
      suggestSlashCommands({ commands, input: "/m", limit: 8 }).map((command) => command.path),
    ).toEqual(["append.message", "stream.reset", "feed.expand"]);
  });

  test("still includes short substring matches for discovery", () => {
    expect(
      suggestSlashCommands({ commands, input: "/p", limit: 8 }).map((command) => command.path),
    ).toContain("feed.expand");
  });

  test("supports small fuzzy queries across command path characters", () => {
    expect(
      suggestSlashCommands({ commands, input: "/pd", limit: 8 }).map((command) => command.path),
    ).toEqual(["feed.expand", "append.message"]);
  });

  test("hides commands marked hidden", () => {
    expect(
      suggestSlashCommands({ commands, input: "/", limit: 8 }).map((command) => command.path),
    ).toEqual(["append.message", "feed.expand", "stream.reset", "view.state"]);
  });
});

describe("slash command helpers", () => {
  test("finds commands by slash alias and formats the accepted input", () => {
    const command = findSlashCommand({ commands, slash: "m" });

    expect(command?.path).toBe("append.message");
    expect(command).toBeDefined();

    const messageCommand = command!;
    expect(acceptedSlashInput(messageCommand)).toBe("/append.message ");
    expect(formatSlashCommandLabel(messageCommand)).toBe(
      "/append.message   Append an agent-style user message",
    );
  });

  test("marks fuzzy-matched command path characters for rendering", () => {
    const expandCommand = commands.find((command) => command.path === "feed.expand");

    expect(expandCommand).toBeDefined();
    expect(
      formatSlashCommandLabelSegments({ command: expandCommand!, input: "/pd" }).filter(
        (segment) => segment.matched,
      ),
    ).toEqual([
      { text: "p", matched: true },
      { text: "d", matched: true },
    ]);
  });

  test("only commands with required positional input are accepted as a prefill", () => {
    const resetCommand = findSlashCommand({ commands, slash: "reset" });

    expect(resetCommand).toBeDefined();
    expect(acceptedSlashInput(resetCommand!)).toBe("/stream.reset");
  });
});
