// One unretried representative CI smoke. The watchdog belongs to the parent experiment process.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectItx } from "iterate/node";
import { cloudflareWorkerVersionOverrideHeaders } from "../../packages/shared/src/test-support/cloudflare-worker-version-overrides.ts";

const startedAt = Date.now();
console.log(
  JSON.stringify({
    phase: "start",
    at: startedAt,
    versions: process.env.E2E_CLOUDFLARE_WORKERS_VERSION_OVERRIDES,
  }),
);
using session = connectItx({
  baseUrl: process.env.EXPERIMENT_ORIGIN!,
  headers: cloudflareWorkerVersionOverrideHeaders(process.env),
});
using root = session.authenticate({
  type: "admin-secret",
  secret: process.env.APP_CONFIG_ADMIN_API_SECRET!,
});
await root.__describe();
console.log(JSON.stringify({ phase: "authenticated", elapsedMs: Date.now() - startedAt }));
using project = await root.projects.get(`lease-cycle-${randomUUID().slice(0, 8)}`).create({});
console.log(
  JSON.stringify({
    phase: "project-created",
    elapsedMs: Date.now() - startedAt,
    project: await project.__describe(),
  }),
);
using agent = project.agents.get("/agents/smoke");
await agent.create();
await agent.message("Reply with exactly: pong");
const reply = await agent.stream.waitForEvent({
  eventTypes: ["events.iterate.com/agents/web-message-sent"],
  timeoutMs: 90_000,
});
assert(reply.payload);
console.log(JSON.stringify({ phase: "reply", elapsedMs: Date.now() - startedAt, reply }));
console.log(JSON.stringify({ phase: "events", events: await agent.stream.getEvents({}) }));
