// Headless smoke of the chat TUI's data layer — the exact modules the OpenTUI
// adapter renders from, minus the PTY: connect via the shared itx client,
// fold the live subscription through the shared agent-ui reducer, send a user
// message, and wait for the assistant reply to land as a settled feed item.
//
//   cd apps/os && doppler run -- pnpm exec tsx e2e/tui-test/data-layer-smoke.ts
//
// Requires an LLM provider on the deployment under test (local dev with the
// OpenAI key, or a preview). Exits 0 on PASS, 1 on timeout/failure.

import process from "node:process";
import { createAgentFeedModel } from "../../../../packages/iterate/src/stream-tui/agent-feed-model.ts";
import {
  connectAgentFeed,
  resolveItxAuth,
} from "../../../../packages/iterate/src/stream-tui/agent-connection.ts";
import { createTestProject } from "../test-support/create-test-project.ts";

const AGENT_PATH = "/agents/onboarding";
const REPLY_TIMEOUT_MS = 120_000;
const startedAt = Date.now();

const project = await createTestProject({ slugPrefix: "tui-smoke" });
log(`created project ${project.project.id} at ${project.baseUrl}`);

const model = createAgentFeedModel();
let notifyChange = () => {};

const connection = connectAgentFeed({
  auth: resolveItxAuth({ configName: undefined }),
  baseUrl: project.baseUrl,
  projectId: project.project.id,
  agentPath: AGENT_PATH,
  replayAfterOffset: () => model.snapshot().lastOffset,
  onEvents: (events) => {
    if (model.applyEvents(events)) notifyChange();
  },
  onStatus: (status) => log(`connection: ${status.kind}`),
});

try {
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
  await connection.sendMessage(message);
  log(`sent: ${message}`);

  await waitFor("user message settles as a feed item", 30_000, () =>
    model
      .snapshot()
      .items.some((item) => item.kind === "user" && item.text.includes("Reply with exactly")),
  );

  // 3. Assistant reply appears as a settled feed item (full loop: agent
  //    processor -> LLM provider -> web-message-sent -> reducer).
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
  connection.dispose();
  await project[Symbol.asyncDispose]();
}

function log(message: string) {
  console.info(`[tui-smoke +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
}

async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      log(`ok: ${label}`);
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      notifyChange = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}
