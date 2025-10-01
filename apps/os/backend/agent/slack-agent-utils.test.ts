import { describe, expect, it } from "vitest";
import { shouldUnfurlSlackMessage } from "./slack-agent-utils.ts";

describe("shouldUnfurlSlackMessage", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof shouldUnfurlSlackMessage>[0];
    expected: boolean;
  }> = [
    {
      name: "returns true for auto when there is exactly one non-iterate link",
      input: {
        text: "Check this out https://example.com",
        unfurl: "auto",
      },
      expected: true,
    },
    {
      name: "returns false for auto when the message includes an os.iterate.com link",
      input: {
        text: "Authorize here https://os.iterate.com/some-path",
        unfurl: "auto",
      },
      expected: false,
    },
    {
      name: "returns true for all when the message includes an os.iterate.com link",
      input: {
        text: "Authorize here https://os.iterate.com/some-path",
        unfurl: "all",
      },
      expected: true,
    },
    {
      name: "returns false for auto when the message has multiple links",
      input: {
        text: "Multiple links https://example.com and https://example.org",
        unfurl: "auto",
      },
      expected: false,
    },
    {
      name: "returns true for auto when the message includes a linear link",
      input: {
        text: "Issue link https://linear.app/iterate/issue/OPS-123",
        unfurl: "auto",
      },
      expected: true,
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(shouldUnfurlSlackMessage(input)).toBe(expected);
  });
});
