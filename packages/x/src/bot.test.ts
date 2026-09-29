import { expect, test } from "vitest";
import { verifyMention } from "./bot.ts";

test("a fetched mention from the verified account admits the sender, ignoring handle case", () => {
  expect(verifyMention(mention())).toBeUndefined();
});

test.for([
  {
    name: "a different author",
    overrides: { post: { author_id: "999", entities: { mentions: [{ username: "iterate" }] } } },
    error: "not written",
  },
  { name: "a replaced linked account", overrides: { linkedId: "999" }, error: "not written" },
  {
    name: "text without an explicit mention entity",
    overrides: { post: { author_id: "123" } },
    error: "include a mention",
  },
  {
    name: "a mention of a different bot",
    overrides: { bot: { id: "456", username: "anotherbot" } },
    error: "include a mention",
  },
  {
    name: "the bot itself",
    overrides: { bot: { id: "123", username: "iterate" } },
    error: "invoke itself",
  },
])("$name cannot trigger a reply", ({ overrides, error }) => {
  expect(() => verifyMention(mention(overrides))).toThrow(error);
});

function mention(overrides: Partial<Parameters<typeof verifyMention>[0]> = {}) {
  return {
    senderId: "123",
    linkedId: "123",
    bot: { id: "456", username: "iterate" },
    post: { author_id: "123", entities: { mentions: [{ username: "Iterate" }] } },
    ...overrides,
  };
}
