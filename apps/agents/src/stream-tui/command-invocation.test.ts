import { describe, expect, test } from "vitest";
import {
  MissingCommandArgumentsError,
  parseSlashCommandInput,
  parseSlashInvocation,
  readStringOption,
  removeStringOption,
} from "./command-invocation.ts";

describe("parseSlashInvocation", () => {
  test("splits the slash name from raw arguments", () => {
    expect(parseSlashInvocation("/message hello world")).toEqual({
      slash: "message",
      rawArgs: "hello world",
    });
    expect(parseSlashInvocation("hello world")).toBeUndefined();
  });
});

describe("parseSlashCommandInput", () => {
  test("parses message content and stream override", () => {
    expect(
      parseSlashCommandInput({
        commandTitle: "Append message",
        slashName: "message",
        input: {
          positional: { name: "content", required: true },
          options: [{ name: "streamPath", flag: "--stream" }],
        },
        rawArgs: "hello --stream ./child",
      }),
    ).toEqual({ content: "hello", streamPath: "./child" });
  });

  test("parses reset flags with children enabled by default", () => {
    expect(
      parseSlashCommandInput({
        commandTitle: "Reset stream",
        slashName: "reset",
        input: {
          options: [{ name: "streamPath", flag: "--stream" }],
          flags: [{ name: "destroyChildren", flag: "--no-children", value: false }],
        },
        rawArgs: "--no-children --stream ./child",
      }),
    ).toEqual({ destroyChildren: false, streamPath: "./child" });
  });

  test("throws a typed error for missing required arguments", () => {
    expect(() =>
      parseSlashCommandInput({
        commandTitle: "Append message",
        slashName: "message",
        input: { positional: { name: "content", required: true } },
        rawArgs: "",
      }),
    ).toThrow(MissingCommandArgumentsError);
  });
});

describe("string options", () => {
  test("supports quoted and unquoted values", () => {
    expect(readStringOption("--stream './child stream'", "--stream")).toBe("./child stream");
    expect(removeStringOption("hello --stream ./child", "--stream")).toBe("hello");
  });
});
