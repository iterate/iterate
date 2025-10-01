import { describe, expect, it } from "vitest";
import { shouldUnfurlSlackMessage } from "./slack-agent-utils.ts";

describe("shouldUnfurlSlackMessage", () => {
  it("returns true for auto when there is exactly one non-iterate link", () => {
    expect(
      shouldUnfurlSlackMessage({
        text: "Check this out https://example.com",
        unfurl: "auto",
      }),
    ).toMatchInlineSnapshot("true");
  });

  it("returns false for auto when the message includes an os.iterate.com link", () => {
    expect(
      shouldUnfurlSlackMessage({
        text: "Authorize here https://os.iterate.com/some-path",
        unfurl: "auto",
      }),
    ).toMatchInlineSnapshot("false");
  });

  it("returns true for all when the message includes an os.iterate.com link", () => {
    expect(
      shouldUnfurlSlackMessage({
        text: "Authorize here https://os.iterate.com/some-path",
        unfurl: "all",
      }),
    ).toMatchInlineSnapshot("true");
  });
});
