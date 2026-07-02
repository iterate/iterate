/**
 * Manual smoke: create a project as admin and watch the onboarding agent greet.
 *
 *   doppler run -- pnpm exec tsx e2e/itx/onboarding-smoke.ts [baseUrl]
 */
import { connectItx } from "../../src/itx-client.ts";

const baseUrl = (process.argv[2] ?? process.env.ITX_BASE_URL ?? "http://localhost:56455").replace(
  /\/+$/,
  "",
);
const secret =
  process.env.OS_ADMIN_API_SECRET?.trim() || process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
if (!secret) throw new Error("need APP_CONFIG_ADMIN_API_SECRET (run under doppler)");

const marker = Math.random().toString(36).slice(2, 8);

using session = connectItx({ baseUrl });
const start = Date.now();
using root = session.authenticate({ type: "admin-secret", secret });
using project = root.projects.create({ slug: `onboarding-smoke-${marker}` });
const description = await project.describe();
console.log(`project created in ${Date.now() - start}ms:`, description.projectId);

using agent = project.agents.get("/agents/onboarding");
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
