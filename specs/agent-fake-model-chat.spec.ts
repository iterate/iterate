import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

const assistantMessage = '[data-testid="agent-feed-message"][data-kind="assistant"]';

// The deterministic sibling of agent-chat.spec.ts: same UI journey (composer →
// feed), but the "model" is this spec's own interceptor — the fake/* lane —
// so a THREE-turn conversation completes in seconds, free, with scripted
// replies. The real agent loop runs end to end: journaled llm-request events,
// codemode script execution, web-message-sent, feed paint.
test("multi-turn chat with a sarcastic agent served by the spec's own fake-model interceptor", async ({
  helpers,
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await using fixture = await helpers.createFixture("agent-fake-chat");
  if (!baseURL) throw new Error("Playwright baseURL fixture is required.");

  using admin = await connectAdminItx(baseURL);
  using project = admin.projects.get(fixture.project.id);
  const agentPath = `/agents/sarcastic-${crypto.randomUUID().slice(0, 8)}`;
  using agent = project.agents.get(agentPath);
  await agent.create();
  // Point the agent at the fake lane and drop the newborn debounce window —
  // an ordinary journaled config event, the same channel a config worker uses.
  await agent.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: "fake/sarcastic" }, llmRequestDebounceMs: 250 } },
  });

  // The "model": an in-memory function in THIS process, dialed back over
  // capnweb for every fake/* turn. It answers the agent contract's way — one
  // codemode script — sending a sarcastic rendering of whatever the user said.
  using _interception = await project.ai.intercept(async (call) => {
    if (call.source !== "agent-turn") throw new Error(`unexpected source: ${call.source}`);
    const lastUser = [...call.body.messages].reverse().find((m) => m.role === "user");
    const reply = formatSarcasticResponse(stripXmlBlocks(lastUser?.content ?? ""));
    return [
      "```ts",
      `async (itx) => {\n  await itx.chat.sendMessage(${JSON.stringify(reply)})\n}`,
      "```",
    ].join("\n");
  });

  await page.goto(`/projects/${fixture.project.slug}/agents/streams${agentPath}`);
  const composer = page.getByPlaceholder("Message this agent");
  const send = page.getByRole("button", { name: "Send message" });

  const turns = [
    "Can you help me organize my inbox?",
    "Why are you like this?",
    "Fine. I will just do it myself.",
  ];
  for (const [index, message] of turns.entries()) {
    await composer.waitFor();
    await composer.fill(message);
    await send.click();
    // The user message reaches the projection raw (prompt-scenarios pin
    // this), so the EXACT reply is computable here: same responder, same
    // input. Deterministic — no model roulette, no marker fishing.
    await page
      .locator(assistantMessage)
      .filter({ hasText: formatSarcasticResponse(message) })
      .waitFor();
    // Turn count grows one reply per message (nth waits for index+1 to exist).
    await page.locator(assistantMessage).nth(index).waitFor();
  }
});

// -----------------------------------------------------------------------------
// Sarcastic responder, adapted from dumbagent (github.com/mmkal/dumbagent,
// src/presets/sarcastic.ts). Modifications: the wire-protocol Request/Response
// layer is gone — the fake-model lane hands us parsed chat messages — keeping
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
