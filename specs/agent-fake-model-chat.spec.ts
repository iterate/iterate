import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";

test("a config file mention is materialized before the model sees the turn", async ({
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("agent-file-mention");
  const agent = await fixture.createAgent();
  let modelCalls = 0;
  let materializedContext: string | undefined;
  agent.responses.set(async (call) => {
    modelCalls += 1;
    materializedContext = call.body.messages.find((message) =>
      message.content.includes("Config repository references resolved at latest HEAD"),
    )?.content;
    return [
      "```ts",
      'async (itx) => { await itx.chat.sendMessage("Reference resolved") }',
      "```",
    ].join("\n");
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(agent.webUrl);
  const composer = page.getByRole("combobox", { name: "Message this agent" });
  await composer.fill("@onb");
  await page.getByRole("option", { name: "ONBOARDING.md" }).click();
  await composer.press("Enter");

  await page.getByText("Reference resolved").waitFor();
  await page
    .locator('[data-testid="agent-feed-message"][data-kind="user"]')
    .locator(
      '[data-reference-kind="config-repo-file"][data-reference-resolution="resolved"][title="ONBOARDING.md"]',
    )
    .waitFor();
  expect(modelCalls).toBe(1);
  expect(materializedContext).toContain('"status": "resolved"');
  expect(materializedContext).toContain('"path": "ONBOARDING.md"');
  expect(materializedContext).toContain('"content":');
});

// The deterministic sibling of agent-chat.spec.ts: same UI journey (composer →
// feed), but the "model" is this spec's own interceptor serving intercepted/* —
// so a THREE-turn conversation completes in seconds, free, with scripted
// replies. The real agent loop runs end to end: journaled llm-request events,
// codemode script execution, web-message-sent, feed paint.
test("multi-turn chat with a sarcastic agent served by the spec's own fake-model interceptor", async ({
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("agent-fake-chat");

  const agent = await fixture.createAgent();
  agent.responses.set(async (call) => {
    const lastUser = [...call.body.messages].reverse().find((m) => m.role === "user");
    const reply = formatSarcasticResponse(stripXmlBlocks(lastUser?.content ?? ""));
    return [
      "```ts",
      `async (itx) => {\n  await itx.chat.sendMessage(${JSON.stringify(reply)})\n}`,
      "```",
    ].join("\n");
  });

  await page.goto(agent.webUrl);
  const composer = page.getByPlaceholder("Message this agent");
  const send = page.getByRole("button", { name: "Send message" });

  await composer.fill("Can you help me organize my inbox?");
  await send.click();
  await page.getByText(/"can you help me .*" do you hear yourself/i).waitFor();

  await composer.fill("Why are you like this?");
  await send.click();
  await page.getByText(/"why are you like this\?" do you hear yourself/i).waitFor();

  await composer.fill("Fine. I will just do it myself.");
  await send.click();
  await page.getByText(/"fine. .*" do you hear yourself/i).waitFor();
});

// -----------------------------------------------------------------------------
// Sarcastic responder, adapted from dumbagent (github.com/mmkal/dumbagent,
// src/presets/sarcastic.ts). Modifications: the wire-protocol Request/Response
// layer is gone — the interceptor receives parsed chat messages — keeping
// the text pipeline: strip xml-ish blocks, spongebob-case the first 50 chars
// (deterministic FNV-1a bit stream, not randomness), sneer.
// -----------------------------------------------------------------------------

function formatSarcasticResponse(text: string) {
  const cleanText = text.trim();
  if (!cleanText) {
    return "fake model ready";
  }
  return `"${spongebobCase(cleanText.slice(0, 50))}" do you hear yourself`;
}

function stripXmlBlocks(text: string) {
  let result = text;
  let previous = "";
  while (result !== previous) {
    previous = result;
    result = result.replace(/<([A-Za-z][\w:-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, "");
  }
  return result.replace(/<\/?[A-Za-z][\w:-]*(?:\s[^>]*)?>/g, "");
}

function spongebobCase(text: string) {
  let state = 0x81_1c_9d_c5;
  let result = "";
  for (const char of text) {
    state = Math.imul(state ^ char.codePointAt(0)!, 0x01_00_01_93);
    if (!/[a-z]/i.test(char)) {
      result += char;
      continue;
    }
    result += state & 1 ? char.toUpperCase() : char.toLowerCase();
  }
  return result;
}
