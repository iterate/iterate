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
      message.content.includes('<mention type="file" repo="/repos/config" path="ONBOARDING.md">'),
    )?.content;
    return [
      "```ts",
      'async (itx) => { await itx.chat.sendMessage("Mention resolved") }',
      "```",
    ].join("\n");
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(agent.webUrl);
  const composer = page.getByRole("combobox", { name: "Message this agent" });
  await composer.fill("@onb");
  await page.getByRole("option", { name: "ONBOARDING.md" }).click();
  // File completion can finish before the stream connection enables submission.
  await page.getByRole("button", { name: "Send message" }).click();

  await page.getByText("Mention resolved").waitFor();
  await page
    .locator('[data-testid="agent-feed-message"][data-kind="user"]')
    .locator(
      '[data-mention-type="repo-file"][data-mention-resolution="resolved"][title="ONBOARDING.md"]',
    )
    .waitFor();
  expect(modelCalls).toBe(1);
  expect(materializedContext).toContain(
    '<mention type="file" repo="/repos/config" path="ONBOARDING.md">\n',
  );
  expect(materializedContext).toContain("</mention>");
  expect(materializedContext).not.toContain("resolvedCommitOid");
  expect(materializedContext).not.toContain("includedBytes");
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

test("switching agents clears the previous stream's submission acknowledgement", async ({
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("agent-composer-navigation");
  const first = await fixture.createAgent({ infix: "first" });
  const second = await fixture.createAgent({ infix: "second" });
  // A well-used stream has a much higher input offset than the fresh destination.
  await first.stream.append(
    ...Array.from({ length: 100 }, (_, index) => ({
      type: "events.iterate.com/test/navigation-padding",
      payload: { index },
    })),
  );
  first.responses.set(
    async () => '```ts\nasync (itx) => { await itx.chat.sendMessage("First agent replied") }\n```',
  );
  second.responses.set(
    async () => '```ts\nasync (itx) => { await itx.chat.sendMessage("Second agent replied") }\n```',
  );

  await page.goto(first.webUrl);
  const composer = page.getByRole("combobox", { name: "Message this agent" });
  await composer.fill("Hello first");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("First agent replied").waitFor();
  const firstInputs = await first.stream.getEvents({
    eventTypes: ["events.iterate.com/agents/context-added"],
    limit: 500,
  });
  const input = firstInputs.find((event) => event.payload?.content === "Hello first")!;
  expect(input.offset).toBeGreaterThan(
    (await second.liveState.get()).inputAcknowledgedThroughOffset,
  );

  // Navigate in the mounted application: page.goto would hide leaked composer state.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search agents…").fill(second.path);
  await page.getByRole("option", { name: new RegExp(second.path) }).click();
  // The old composer remains mounted while the router loads the destination.
  await page
    .locator(`[data-stream-path="${second.path}"]`)
    .getByRole("combobox", { name: "Message this agent" })
    .fill("Hello second");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("Second agent replied").waitFor();
});

test("recreating an agent at the same path resets its composer", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("agent-composer-recreation");
  const agent = await fixture.createAgent();
  await agent.stream.append(
    ...Array.from({ length: 100 }, (_, index) => ({
      type: "events.iterate.com/test/recreation-padding",
      payload: { index },
    })),
  );
  agent.responses.set(
    async () =>
      '```ts\nasync (itx) => { await itx.chat.sendMessage("Original agent replied") }\n```',
  );
  await page.goto(agent.webUrl);
  const composer = page.getByRole("combobox", { name: "Message this agent" });
  await composer.fill("Hello original");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("Original agent replied").waitFor();
  // Finish the original turn before replacing its stream, so this checks
  // composer lifetime rather than racing an old script's remaining writes.
  await composer.fill("Draft for the original stream");
  await page.getByRole("button", { name: "Send message", disabled: false }).waitFor();

  // The admin-only test operation deletes this fixture stream and aborts its
  // current incarnation; an abort response is expected, other failures are not.
  await (agent.stream as unknown as { testReset(): Promise<void> })
    .testReset()
    .catch((error: unknown) => {
      if (!/kill requested|aborted|reset|disconnected|shut down|canceled/i.test(String(error))) {
        throw error;
      }
    });
  const recreated = await fixture.createAgent({ path: agent.path });
  recreated.responses.set(
    async () =>
      '```ts\nasync (itx) => { await itx.chat.sendMessage("Recreated agent replied") }\n```',
  );
  // Stay on this page: a reload would hide stale composer state. The old row
  // disappearing proves that the browser has recognized the new stream identity.
  await page.getByText("Original agent replied").waitFor({ state: "hidden", timeout: 30_000 }); // timeout: server recreation and event-mirror recovery have no spinner for the spinner-waiter
  await composer.getByText("Message this agent", { exact: true }).waitFor();
  await composer.fill("Hello recreated");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("Recreated agent replied").waitFor();
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
