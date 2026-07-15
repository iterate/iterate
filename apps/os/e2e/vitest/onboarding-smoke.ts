/**
 * Smoke: create a project as admin and watch the onboarding agent greet.
 * Runs manually and as the preview test lane's sequential entry gate
 * (scripts/preview/preview.ts), where it pays the create-saga cold-start
 * costs before the concurrent suites begin.
 *
 *   doppler run -- pnpm exec tsx e2e/vitest/onboarding-smoke.ts [baseUrl]
 *
 * Two attempts, a fresh project each — an attempt IS this gate's "test", so
 * per the fleet retry policy (docs/testing.md#retries-and-timeouts) it gets
 * exactly one retry, same as every vitest/playwright test. It used to run
 * with none at all: a single 90s greeting tail took down the whole run, as
 * an uncaught remote rejection crashing the process no less
 * (docs/preview-e2e-flake-hunt.md run log, marathon6 run 26). A genuinely
 * broken slot still fails both attempts inside ~3.5 minutes, and a slow
 * greeting that needs attempt 2 is logged as retry telemetry rather than
 * silently absorbed — the 90s tail is a real product-latency signal.
 */
import { fileURLToPath } from "node:url";
import { ONBOARDING_AGENT_SYSTEM_PROMPT } from "../../src/domains/agents/agent-defaults.ts";
import { connectItx } from "../../src/itx-client.ts";
import { onboardingStartEvent } from "../../src/lib/onboarding-agent.ts";
import { resolveBaseUrl } from "../test-support/dev-server.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const baseUrl = (process.argv[2] ?? resolveBaseUrl(appRoot) ?? "http://localhost:56455").replace(
  /\/+$/,
  "",
);
const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
if (!secret) throw new Error("need APP_CONFIG_ADMIN_API_SECRET (run under doppler)");

async function attemptOnboardingSmoke(): Promise<void> {
  const marker = Math.random().toString(36).slice(2, 8);

  using session = connectItx({ baseUrl });
  const start = Date.now();
  using root = session.authenticate({ type: "admin-secret", secret: secret! });
  using project = root.projects.create({ slug: `onboarding-smoke-${marker}` });
  const description = await project.__describe();
  console.log(`project created in ${Date.now() - start}ms:`, description.projectId);

  using agent = project.agents.get("/agents/onboarding");
  // Match the dashboard's explicit onboarding flow: agent birth is generic,
  // while this caller supplies the onboarding prompt and startup input.
  await agent.create({ systemPrompt: ONBOARDING_AGENT_SYSTEM_PROMPT });
  await agent.stream.append(onboardingStartEvent(description.projectId));
  const greeting = await agent.stream.waitForEvent({
    eventTypes: ["events.iterate.com/agents/web-message-sent"],
    timeoutMs: 90_000,
  });
  console.log(`onboarding agent greeted in ${Date.now() - start}ms:`);
  console.log(JSON.stringify(greeting.payload, null, 2));

  const events = await agent.stream.getEvents({});
  console.log(
    "agent stream events:",
    events.map((event) => event.type.replace("events.iterate.com/", "")),
  );
}

const ATTEMPTS = 2;
let lastError: unknown;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  try {
    await attemptOnboardingSmoke();
    if (attempt > 1) {
      console.log(
        `[retry-telemetry] onboarding smoke passed on attempt ${attempt}/${ATTEMPTS} — ` +
          `attempt 1's failure above is a real (absorbed) failure`,
      );
    }
    process.exit(0);
  } catch (error) {
    lastError = error;
    console.error(`onboarding smoke attempt ${attempt}/${ATTEMPTS} failed:`, error);
  }
}
console.error(`onboarding smoke failed after ${ATTEMPTS} attempts`);
console.error(lastError);
process.exit(1);
