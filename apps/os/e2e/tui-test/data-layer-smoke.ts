// Headless smoke of the chat TUI's data layer — the exact modules the OpenTUI
// adapter renders from, minus the PTY: point the shared one-socket keeper
// (`iterate/client`, same code path the TUI's `configureIterateSession` sets
// up) at the deployment, subscribe the agent stream on it, fold the live
// subscription through the shared agent-ui reducer, send a user message, and
// wait for the assistant reply to land as a settled feed item.
//
//   cd apps/os && doppler run -- pnpm exec tsx e2e/tui-test/data-layer-smoke.ts
//
// Requires Workers AI on the deployment under test (local dev or a preview).
// Exits 0 on PASS, 1 on timeout/failure.

import process from "node:process";
import {
  configureIterateSession,
  connectItx,
  releaseItxSubscription,
  type ItxLiveSubscriptionHandle,
} from "iterate/client";
import { createAgentFeedModel } from "../../../../packages/iterate/src/stream-tui/agent-feed-model.ts";
import { resolveItxAuth } from "../../../../packages/iterate/src/stream-tui/itx-auth.ts";
import { ensureOnboardingAgentReady } from "../../src/lib/onboarding-agent.ts";
import { createTestProject } from "../test-support/create-test-project.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";

const AGENT_PATH = "/agents/onboarding";
const REPLY_TIMEOUT_MS = 120_000;
const startedAt = Date.now();

const project = await createTestProject({ slugPrefix: "tui-smoke" });
log(`created project ${project.project.id} at ${project.baseUrl}`);

const model = createAgentFeedModel();
let notifyChange = () => {};

// The TUI's exact connection setup: one keeper socket, explicit target +
// credentials (admin secret in doppler/e2e lanes).
configureIterateSession({
  baseUrl: project.baseUrl,
  credentials: resolveItxAuth({ configName: undefined }),
});
const itx = await connectItx(project.project.id);
const agent = itx.agents.get(AGENT_PATH);
let subscription: ItxLiveSubscriptionHandle | undefined;

try {
  // Fresh project: birth the onboarding agent with the real birth batch when
  // unborn — the same create-if-unborn the TUI's subscribeAgentFeed performs
  // (births are deferred to first chat-open; they cost a real LLM turn).
  await ensureOnboardingAgentReady({ agent });
  subscription = await agent.stream.subscribe({
    processEventBatch: (batch) => {
      if (model.applyEvents(batch.events)) notifyChange();
    },
    replayAfterOffset: model.snapshot().lastOffset,
    subscriber: { description: "TUI data-layer smoke" },
  });
  log("subscribed on the shared keeper socket");

  // 1. Feed renders live: the onboarding bootstrap greets unprompted, so the
  //    subscription must deliver events and the reducer must fold them —
  //    including the greeting as a settled assistant item — before we type.
  //    Sending earlier races the bootstrap trigger and the agent coalesces
  //    both inputs into one greeting-only reply.
  await waitFor("first feed fold", 60_000, () => model.snapshot().lastOffset > 0);
  await waitFor("onboarding greeting settles as an assistant item", REPLY_TIMEOUT_MS, () =>
    model.snapshot().items.some((item) => item.kind === "assistant"),
  );

  // 2. Send through the same door the TUI composer uses.
  const message = "Reply with exactly: pong";
  await agent.message(message);
  log(`sent: ${message}`);

  await waitFor("user message settles as a feed item", 30_000, () =>
    model
      .snapshot()
      .items.some((item) => item.kind === "user" && item.text.includes("Reply with exactly")),
  );

  // 3. Assistant reply appears as a settled feed item (full loop: agent
  //    processor -> LLM (env.AI) -> web-message-sent -> reducer).
  await waitFor("assistant reply appears", REPLY_TIMEOUT_MS, () =>
    model
      .snapshot()
      .items.some((item) => item.kind === "assistant" && item.text.toLowerCase().includes("pong")),
  );

  const snapshot = model.snapshot();
  log(`feed items: ${snapshot.items.map((item) => item.kind).join(" → ")}`);
  const assistant = snapshot.items.findLast((item) => item.kind === "assistant");
  log(`assistant said: ${assistant && "text" in assistant ? assistant.text : "?"}`);
  log(`PASS in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  process.exit(0);
} catch (error) {
  console.error(`[tui-smoke] FAIL:`, error);
  const snapshot = model.snapshot();
  console.error(
    `[tui-smoke] state at failure: ${snapshot.eventCount} events, items=${snapshot.items
      .map((item) => item.kind)
      .join(",")}, live=${snapshot.live?.status ?? "none"}`,
  );
  process.exit(1);
} finally {
  if (subscription) releaseItxSubscription(subscription);
  await project[Symbol.asyncDispose]();
}

function log(message: string) {
  console.info(`[tui-smoke +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
}

async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  await waitForCondition(check, {
    description: label,
    intervalMs: 250,
    timeoutMs,
    // Event-driven wake: appendEvent notifications short-circuit the interval.
    sleep: (intervalMs) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        notifyChange = () => {
          clearTimeout(timer);
          resolve();
        };
      }),
  });
  log(`ok: ${label}`);
}
