import { expect, test } from "vitest";
import { ensureOnboardingAgentReady } from "../../src/lib/onboarding-agent.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const LLM_REQUEST_SETTLED_TYPE = "events.iterate.com/agent/llm-request-settled";
const WEB_MESSAGE_SENT_TYPE = "events.iterate.com/agents/web-message-sent";

test("a second project's onboarding turn is served from the AI Gateway cache", async () => {
  const marker = crypto.randomUUID().slice(0, 8);

  // First turn seeds the cache (HIT if an earlier run already did).
  const first = await runOnboardingBirthTurn(`aig-cache-a-${marker}`);
  // This env runs the BYOK lane with the response cache on (envs.ts /
  // local-dev vars); evidence missing means the lane regressed.
  expect(first).toMatchObject({
    cacheStatus: expect.stringMatching(/^(HIT|MISS)$/),
    greeting: expect.stringMatching(/\S/),
  });

  // The second project differs ONLY in minted identity (project id, agent
  // path) — exactly what cloudflareAiGatewayResponseCacheKey masks — so its
  // birth turn must be served from the cache without touching OpenAI.
  const second = await runOnboardingBirthTurn(`aig-cache-b-${marker}`);
  expect(second).toMatchObject({ cacheStatus: "HIT", greeting: expect.stringMatching(/\S/) });
}, 300_000);

type LlmCompletionEvidence = {
  cacheStatus: string | undefined;
  greeting: string;
};

/**
 * One onboarding birth turn, start to greeting: create a project, open the
 * onboarding agent the way the dashboard chat page does, and
 * return the LLM completion's gateway-cache evidence plus the greeting text.
 */
async function runOnboardingBirthTurn(slug: string): Promise<LlmCompletionEvidence> {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(slug).create({});
  using agent = project.agents.get("/agents/onboarding");
  await ensureOnboardingAgentReady({ agent });
  const greeting = await agent.stream.waitForEvent({
    eventTypes: [WEB_MESSAGE_SENT_TYPE],
    timeoutMs: 90_000,
  });
  // The FIRST succeeded settlement is the birth turn — the request whose
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
    greeting: String((greeting.payload as { message?: unknown } | undefined)?.message ?? ""),
  };
}
