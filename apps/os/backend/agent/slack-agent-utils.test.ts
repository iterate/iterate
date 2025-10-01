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

  it("returns false when the message includes an os.iterate.com link", () => {
    expect(
      shouldUnfurlSlackMessage({
        text: "Authorize here https://os.iterate.com/some-path",
        unfurl: "all",
      }),
    ).toMatchInlineSnapshot("false");
  });

  it("returns false for auto when there are multiple links", () => {
    expect(
      shouldUnfurlSlackMessage({
        text: "First https://example.com and then https://iterate.com",
        unfurl: "auto",
      }),
    ).toMatchInlineSnapshot("false");
  });
});
