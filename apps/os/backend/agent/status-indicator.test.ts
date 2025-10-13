import { describe, expect, test } from "vitest";
import { buildSlackThreadStatusPayload, resolveStatusIndicatorText } from "./status-indicator.ts";

describe("resolveStatusIndicatorText", () => {
  test.for([
    {
      name: "returns fallback when template is not provided",
      input: {
        toolName: "exec",
        statusIndicatorText: undefined,
        argsJson: undefined,
      },
      expected: "🛠️ exec...",
    },
    {
      name: "renders template with JSONata expression",
      input: {
        toolName: "exec",
        statusIndicatorText: "⚙️ ${args.command}",
        argsJson: JSON.stringify({ command: "ls -la" }),
      },
      expected: "⚙️ ls -la",
    },
    {
      name: "stringifies non-string results",
      input: {
        toolName: "exec",
        statusIndicatorText: "payload: ${args}",
        argsJson: { command: "ls", flags: ["-l"] },
      },
      expected: 'payload: {"command":"ls","flags":["-l"]}',
    },
    {
      name: "ignores invalid JSON arguments",
      input: {
        toolName: "exec",
        statusIndicatorText: "command: ${args.command}",
        argsJson: "{ invalid json",
      },
      expected: "command: ",
    },
    {
      name: "supports additional template context",
      input: {
        toolName: "exec",
        statusIndicatorText: "tool: ${tool.displayName}",
        argsJson: "{}",
        templateContext: { tool: { displayName: "Execute" } },
      },
      expected: "tool: Execute",
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveStatusIndicatorText(input)).toBe(expected);
  });
});

describe("buildSlackThreadStatusPayload", () => {
  test.for([
    {
      name: "clears status when value is null",
      input: null,
      expected: { status: "" },
    },
    {
      name: "maps writing response to typing indicator",
      input: "✏️ writing response",
      expected: { status: "is typing...", loading_messages: ["✏️ writing response..."] },
    },
    {
      name: "defaults to thinking indicator for other statuses",
      input: "🧠 thinking",
      expected: { status: "is thinking...", loading_messages: ["🧠 thinking..."] },
    },
  ])("$name", ({ input, expected }) => {
    expect(buildSlackThreadStatusPayload(input)).toEqual(expected);
  });
});
