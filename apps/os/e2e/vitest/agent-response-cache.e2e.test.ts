import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const LLM_REQUEST_COMPLETED_TYPE = "events.iterate.com/agent/llm-request-completed";
const WEB_MESSAGE_SENT_TYPE = "events.iterate.com/agents/web-message-sent";

test("a second project's onboarding turn replays the first one's answer from the AI Gateway cache", async () => {
  const marker = crypto.randomUUID().slice(0, 8);

  // First turn seeds the cache (HIT if an earlier run already did).
  const first = await runOnboardingBirthTurn(`aig-cache-a-${marker}`);
  // This env runs the BYOK lane with the response cache on (envs.ts /
  // local-dev vars); evidence missing means the lane regressed.
  expect(first.cacheStatus).toMatch(/^(HIT|MISS)$/);

  // The second project differs ONLY in minted identity (project id, agent
  // path) — exactly what cloudflareAiGatewayResponseCacheKey masks — so its
  // birth turn must replay the first one's response without touching OpenAI.
  const second = await runOnboardingBirthTurn(`aig-cache-b-${marker}`);
  expect(second.cacheStatus).toBe("HIT");

  // A replay is byte-identical: same greeting, deterministic e2e for free.
  expect(second.greeting).toBe(first.greeting);
}, 300_000);

type LlmCompletionEvidence = {
  cacheStatus: string | undefined;
  greeting: string;
};

/**
 * One onboarding birth turn, start to greeting: create a project, open the
 * onboarding agent the way the dashboard chat page does (configure({})), and
 * return the LLM completion's gateway-cache evidence plus the greeting text.
 */
async function runOnboardingBirthTurn(slug: string): Promise<LlmCompletionEvidence> {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = itx.projects.create({ slug });
  using agent = project.agents.get("/agents/onboarding");
  await agent.configure({});
  const greeting = await agent.stream.waitForEvent({
    eventTypes: [WEB_MESSAGE_SENT_TYPE],
    timeoutMs: 90_000,
  });
  // The FIRST completion is the birth turn — the request whose masked body is
  // identical across projects by construction. Later turns (script results
  // feeding back) may carry their own entropy and are not this test's claim.
  const events = await agent.stream.getEvents({ eventTypes: [LLM_REQUEST_COMPLETED_TYPE] });
  const completed = events.at(0) as
    | {
        payload?: {
          result?: { rawResponse?: { cloudflareAiGatewayResponseCacheStatus?: unknown } };
        };
      }
    | undefined;
  const cacheStatus =
    completed?.payload?.result?.rawResponse?.cloudflareAiGatewayResponseCacheStatus;
  return {
    cacheStatus: typeof cacheStatus === "string" ? cacheStatus : undefined,
    greeting: String((greeting.payload as { message?: unknown } | undefined)?.message ?? ""),
  };
}
