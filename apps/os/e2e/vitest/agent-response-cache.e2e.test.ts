import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const LLM_REQUEST_SETTLED_TYPE = "events.iterate.com/agent/llm-request-settled";
const WEB_MESSAGE_SENT_TYPE = "events.iterate.com/agents/web-message-sent";

test("a second project's identical agent turn is served from the AI Gateway cache", async () => {
  const marker = crypto.randomUUID().slice(0, 8);

  // First turn seeds the cache (HIT if an earlier run already did).
  const first = await runAgentTurn(`aig-cache-a-${marker}`);
  // This env runs the BYOK lane with the response cache on (envs.ts /
  // local-dev vars); evidence missing means the lane regressed.
  expect(first).toMatchObject({
    cacheStatus: expect.stringMatching(/^(HIT|MISS)$/),
    reply: expect.stringMatching(/\S/),
  });

  // The second project differs ONLY in minted identity (project id, agent
  // path) — exactly what cloudflareAiGatewayResponseCacheKey masks — so its
  // turn must be served from the cache without touching OpenAI.
  const second = await runAgentTurn(`aig-cache-b-${marker}`);
  expect(second).toMatchObject({ cacheStatus: "HIT", reply: expect.stringMatching(/\S/) });

  // A cache HIT's contract is a replay of a stored body, so when THIS test
  // seeded the entry (first turn MISS) the second reply is byte-identical.
  // When the first turn already HIT, the seed belongs to some earlier or
  // concurrent lane — the key is deliberately identity-masked and global — and
  // a TTL-boundary reseed between the two turns can legally change the text,
  // so equality would assert another lane's timing, not the cache contract.
  if (first.cacheStatus === "MISS") {
    expect(second).toMatchObject({ reply: first.reply });
  }
}, 300_000);

type LlmCompletionEvidence = {
  cacheStatus: string | undefined;
  reply: string;
};

/**
 * One ordinary agent turn: create a project and agent, send an identical user
 * message, and return the LLM completion's gateway-cache evidence plus reply.
 */
async function runAgentTurn(slug: string): Promise<LlmCompletionEvidence> {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(slug).create({});
  using agent = project.agents.get("/agents/cache-probe");
  await agent.create();
  await agent.message("Reply with exactly: cache probe");
  const reply = await agent.stream.waitForEvent({
    eventTypes: [WEB_MESSAGE_SENT_TYPE],
    timeoutMs: 90_000,
  });
  // The FIRST succeeded settlement is the requested turn — the request whose
  // masked body is identical across projects by construction. Later turns
  // (script results feeding back) may carry their own entropy and are not this
  // test's claim; failed/cancelled settlements never carry a cached response.
  const events = await agent.stream.getEvents({ eventTypes: [LLM_REQUEST_SETTLED_TYPE] });
  const settled = events.find(
    (event) => (event.payload?.result as { status?: unknown } | undefined)?.status === "succeeded",
  ) as
    | {
        payload?: {
          result?: { rawResponse?: { cloudflareAiGatewayResponseCacheStatus?: unknown } };
        };
      }
    | undefined;
  const cacheStatus = settled?.payload?.result?.rawResponse?.cloudflareAiGatewayResponseCacheStatus;
  return {
    cacheStatus: typeof cacheStatus === "string" ? cacheStatus : undefined,
    reply: String((reply.payload as { message?: unknown } | undefined)?.message ?? ""),
  };
}
