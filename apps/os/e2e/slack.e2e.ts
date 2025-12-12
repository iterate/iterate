import { expect, test } from "vitest";
import { createE2EHelper } from "./helpers.ts";

test("slack agent", { timeout: 15 * 60 * 1000 }, async () => {
  await using h = await createE2EHelper("slack-e2e");

  const sent = await h.sendUserMessage("what is 1+2");
  const reply = await sent.waitForReply();
  expect(reply).toMatch(/3|three/i);
});
