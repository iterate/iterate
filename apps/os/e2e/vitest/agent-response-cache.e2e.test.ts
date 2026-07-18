import { expect, test } from "vitest";
import { ensureOnboardingAgentReady } from "../../src/lib/onboarding-agent.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const LLM_REQUEST_COMPLETED_TYPE = "events.iterate.com/agent/llm-request-completed";

test("a second project's onboarding turn replays the first one's answer from the AI Gateway cache", async () => {
  const marker = crypto.randomUUID().slice(0, 8);

  // First turn seeds the cache (HIT if an earlier run already did).
  const first = await runOnboardingBirthTurn(`aig-cache-a-${marker}`);
  // This env runs the BYOK lane with the response cache on (envs.ts /
  // local-dev vars); evidence missing means the lane regressed.
  expect(first.cacheStatus).toMatch(/^(HIT|MISS)$/);
  expect(first.response).toMatchObject({ streamed: true });

  // The second project differs ONLY in minted identity (project id, agent
  // path) — exactly what cloudflareAiGatewayResponseCacheKey masks — so its
  // birth turn must replay the first one's response without touching OpenAI.
  const second = await runOnboardingBirthTurn(`aig-cache-b-${marker}`);
  expect(second).toMatchObject({ cacheStatus: "HIT" });

  // Compare the cached provider body itself. The eventual onboarding greeting
  // may come from a later tool/result turn carrying project-specific data; it
  // is not evidence about whether this first request replayed.
  expect(second).toMatchObject({ response: first.response });
}, 300_000);

type LlmCompletionEvidence = {
  cacheStatus: string | undefined;
  response: Record<string, unknown>;
};

/**
 * One onboarding birth turn, start to first completion: create a project, open the
 * onboarding agent the way the dashboard chat page does, and return the first
 * LLM completion's gateway-cache header plus its cached provider body.
 */
async function runOnboardingBirthTurn(slug: string): Promise<LlmCompletionEvidence> {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = itx.projects.create({ slug });
  using agent = project.agents.get("/agents/onboarding");
  await ensureOnboardingAgentReady({ agent });
  const completed = await agent.stream.waitForEvent({
    eventTypes: [LLM_REQUEST_COMPLETED_TYPE],
    timeoutMs: 90_000,
  });
  const rawResponse = (completed.payload as { result?: { rawResponse?: unknown } } | undefined)
    ?.result?.rawResponse;
  const response =
    typeof rawResponse === "object" && rawResponse !== null
      ? (rawResponse as Record<string, unknown>)
      : {};
  const { cloudflareAiGatewayResponseCacheStatus: cacheStatus, ...cachedProviderBody } = response;
  return {
    cacheStatus: typeof cacheStatus === "string" ? cacheStatus : undefined,
    response: cachedProviderBody,
  };
}
