import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const LLM_REQUEST_SETTLED_TYPE = "events.iterate.com/agent/llm-request-settled";
const WEB_MESSAGE_SENT_TYPE = "events.iterate.com/agents/web-message-sent";

test("an identity-masked ordinary agent response becomes an AI Gateway cache hit", async () => {
  const marker = crypto.randomUUID().slice(0, 8);

  // First turn seeds the cache (HIT if an earlier run already did).
  const first = await runAgentTurn(`aig-cache-a-${marker}`);
  // This env runs the BYOK lane with the response cache on (envs.ts /
  // local-dev vars); evidence missing means the lane regressed.
  expect(first).toMatchObject({
    cacheStatus: expect.stringMatching(/^(HIT|MISS)$/),
    reply: expect.stringMatching(/\S/),
  });

  // Later projects differ ONLY in minted identity (project id, agent path) —
  // exactly what cloudflareAiGatewayResponseCacheKey masks. Cloudflare
  // documents the AI Gateway response cache as volatile: even after the first
  // response completes, the following identical request can arrive before the
  // cache write is visible. Model that MISS as an expected bounded warm-up
  // state instead of turning it into a whole-test retry.
  // https://developers.cloudflare.com/ai-gateway/features/caching/
  const observedStatuses = [first.cacheStatus];
  let hit: LlmCompletionEvidence | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const candidate = await runAgentTurn(`aig-cache-hit-${attempt}-${marker}`);
    observedStatuses.push(candidate.cacheStatus);
    if (candidate.cacheStatus === "HIT") {
      hit = candidate;
      break;
    }
    console.info(
      `[ai-gateway-cache] cache still warming after candidate ${attempt}/3; status=${candidate.cacheStatus}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  expect(
    hit,
    `AI Gateway cache never hit; observed ${observedStatuses.join(" -> ")}`,
  ).toMatchObject({
    cacheStatus: "HIT",
    reply: expect.stringMatching(/\S/),
  });
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
