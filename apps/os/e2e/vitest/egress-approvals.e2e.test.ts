// Proves human-in-the-loop egress approvals end-to-end: requests matching a
// `hold` rule park at the Project DO egress door as an approval BATCH (a
// lone request is a batch of one; a script run's concurrent burst coalesces
// into one event) with the callers' fetch promises open, a "human" (this
// test, playing the `iterate approve` CLI's role over the same itx surface)
// decides the batch with ONE `human-approval-decided` event, and the door
// releases the real upstream calls / refuses / auto-expires per verdict.
// Once an approval key is enrolled, decisions containing any approve verdict
// must carry a valid P-256 signature over the canonical approval.v2 message
// — an unsigned decision is ignored and only the signed one releases.

import { expect, test } from "vitest";
import {
  APPROVAL_BODY_INSPECTION_LIMIT_BYTES,
  buildApprovalMessage,
  bytesToBase64,
  type HumanApprovalRequestedPayload,
} from "../../src/domains/projects/egress-approvals.ts";
import { STREAM_CONTEXT_HEADER } from "../../src/domains/projects/stream-context.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import {
  startEgressEcho,
  startWebSocketEcho,
  WEBSOCKET_ECHO_GREETING,
} from "./itx-capability-fixtures.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const RULES_CONFIGURED = "events.iterate.com/project/egress-rules-configured";
const KEY_ADDED = "events.iterate.com/project/human-approval-key-added";
const REQUESTED = "events.iterate.com/project/human-approval-requested";
const DECIDED = "events.iterate.com/project/human-approval-decided";
const SETTLED = "events.iterate.com/project/human-approval-settled";
const NOTIFICATION_REQUESTED = "events.iterate.com/notification/requested";

test("hold → approve releases, hold → reject refuses, short timeouts expire", async () => {
  const echo = await startEgressEcho();
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });

  try {
    using project = await itx.projects.get(`egress-approvals-${crypto.randomUUID()}`).create({});
    const stream = project.streams.get("/");
    const echoHost = new URL(echo.url).hostname;

    await stream.append({
      type: RULES_CONFIGURED,
      payload: {
        rules: [
          {
            ruleKey: "post-echo",
            description: "POSTs to the echo need a human",
            match: { hosts: [echoHost], methods: ["POST"] },
            verdict: "hold",
            approvalTimeoutMs: 60_000,
          },
          {
            ruleKey: "never-delete",
            description: "DELETEs to the echo are always refused",
            match: { hosts: [echoHost], methods: ["DELETE"] },
            verdict: "deny",
          },
          {
            ruleKey: "impatient",
            description: "PUTs expire almost immediately",
            match: { hosts: [echoHost], methods: ["PUT"] },
            verdict: "hold",
            approvalTimeoutMs: 1_500,
          },
        ],
      },
    });
    await waitForCondition(
      async () => (await project.processor.snapshot()).state.egressRules.length === 3,
      { description: "project processor to fold the egress rules" },
    );

    // ── approve lane: the held fetch resolves with the real upstream response.
    const heldFetch = project.egress.fetch(
      new Request(echo.url, {
        method: "POST",
        headers: { "x-approval-proof": "hold-me" },
        body: "please approve",
      }),
    );
    const requested = await stream.waitForEvent({
      afterOffset: 0,
      eventTypes: [REQUESTED],
      timeoutMs: 30_000,
    });
    const requestedPayload = requested.payload as HumanApprovalRequestedPayload;
    expect(requestedPayload).toMatchObject({
      requests: [
        {
          method: "POST",
          body: {
            encoding: "utf8",
            content: "please approve",
            originalByteLength: 14,
            truncated: false,
          },
          secretPaths: [],
        },
      ],
      ruleKey: "post-echo",
      // A direct /api session (this test, playing the CLI) journals WHO asked
      // — the auth-verified principal, not the anonymous scope-"/" fallback.
      streamContext: { kind: "client-session", principal: "admin", admin: true },
    });
    expect(requestedPayload.requests[0]!.headers["x-approval-proof"]).toBe("hold-me");
    expect(requestedPayload.requests[0]!.body?.sha256).toMatch(/^[0-9a-f]{64}$/);

    await stream.append({
      type: DECIDED,
      payload: {
        approvalRequestEventOffset: requested.offset,
        verdicts: ["approve"],
        decidedBy: "human",
      },
    });
    const releasedResponse = await heldFetch;
    expect(releasedResponse).toMatchObject({ status: 200 });
    const echoed = (await releasedResponse.json()) as { headers: Record<string, string> };
    expect(echoed.headers["x-approval-proof"]).toBe("hold-me");

    const settled = await stream.waitForEvent({
      afterOffset: requested.offset,
      eventTypes: [SETTLED],
      timeoutMs: 30_000,
    });
    expect(settled.payload).toMatchObject({
      approvalRequestEventOffset: requested.offset,
      index: 0,
      status: 200,
    });

    // ── reject lane: a human refusal turns into a 403 for the caller, and an
    // oversized readable body stays a bounded inspection prefix in the event.
    const oversizedBody = "r".repeat(APPROVAL_BODY_INSPECTION_LIMIT_BYTES + 10_000);
    const rejectedFetch = project.egress.fetch(
      new Request(echo.url, { method: "POST", body: oversizedBody }),
    );
    const rejectedRequested = await stream.waitForEvent({
      afterOffset: settled.offset,
      eventTypes: [REQUESTED],
      timeoutMs: 30_000,
    });
    expect(rejectedRequested.payload as HumanApprovalRequestedPayload).toMatchObject({
      requests: [
        {
          body: {
            encoding: "utf8",
            content: "r".repeat(APPROVAL_BODY_INSPECTION_LIMIT_BYTES),
            originalByteLength: oversizedBody.length,
            truncated: true,
          },
        },
      ],
    });
    await stream.append({
      type: DECIDED,
      payload: {
        approvalRequestEventOffset: rejectedRequested.offset,
        verdicts: ["reject"],
        decidedBy: "human",
        reason: "wrong recipient — use the staging address",
      },
    });
    const rejectedResponse = await rejectedFetch;
    expect(rejectedResponse).toMatchObject({ status: 403 });
    // The human's reason lands verbatim in the 403 body — this is what the
    // calling script/agent reads to decide whether to retry differently.
    await expect(rejectedResponse.json()).resolves.toMatchObject({
      error: "approval_rejected",
      deniedBy: "human",
      reason: "wrong recipient — use the staging address",
      detail: expect.stringContaining("wrong recipient — use the staging address"),
      ruleKey: "post-echo",
    });

    // ── deny lane: refused synchronously, no approval round-trip.
    const deniedResponse = await project.egress.fetch(new Request(echo.url, { method: "DELETE" }));
    expect(deniedResponse).toMatchObject({ status: 403 });
    await expect(deniedResponse.json()).resolves.toMatchObject({
      error: "egress_denied",
      ruleKey: "never-delete",
    });

    // A malformed secret template can never be released, so it must fail
    // immediately instead of creating an approval that expires later.
    const malformedHeldResponse = await project.egress.fetch(
      new Request(echo.url, {
        body: "{not-json",
        headers: {
          "content-type": "application/json",
          "x-iterate-secret-template": "json",
        },
        method: "PUT",
      }),
    );
    await expect(malformedHeldResponse.json()).resolves.toMatchObject({
      error: "secret_json_template_invalid_body",
    });

    // Invalid secret paths are malformed input, but still pass through
    // method/host/path policy matching so they cannot bypass a deny rule.
    const deniedInvalidSecretPath = await project.egress.fetch(
      new Request(`${echo.url}/getSecret("/not-a-secret")`, { method: "DELETE" }),
    );
    await expect(deniedInvalidSecretPath.json()).resolves.toMatchObject({
      error: "egress_denied",
      ruleKey: "never-delete",
    });

    // ── expiry lane: nobody answers and the batch auto-rejects with the
    // door's own decided event.
    const expiredResponse = await project.egress.fetch(
      new Request(echo.url, { method: "PUT", body: "too slow" }),
    );
    expect(expiredResponse).toMatchObject({ status: 403 });
    await expect(expiredResponse.json()).resolves.toMatchObject({
      error: "approval_expired",
      deniedBy: "expiry",
      ruleKey: "impatient",
    });
    // The expiry decision is committed before the 403 returns, so a plain
    // page read (no live wait) must already see it.
    const decisions = await stream.getEvents({
      afterOffset: rejectedRequested.offset,
      eventTypes: [DECIDED],
    });
    expect(decisions.map((event) => (event.payload as { decidedBy?: string }).decidedBy)).toContain(
      "expiry",
    );
  } finally {
    await echo.close();
  }
}, 120_000);

test("an agent codemode script carries one durable source through bare and scoped fetch", async () => {
  const echo = await startEgressEcho();
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });

  try {
    using project = await itx.projects
      .get(`egress-approval-source-${crypto.randomUUID()}`)
      .create({});
    const root = project.streams.get("/");
    const agentPath = "/agents/refund-agent";
    const agent = await project.agents.get(agentPath).create();
    const echoHost = new URL(echo.url).hostname;
    await root.append({
      type: RULES_CONFIGURED,
      payload: {
        rules: [
          {
            ruleKey: "refunds-need-confirmation",
            description: "Refunds require confirmation",
            match: { hosts: [echoHost], methods: ["POST"] },
            verdict: "hold",
            approvalTimeoutMs: 60_000,
          },
        ],
      },
    });
    await waitForCondition(
      async () => (await project.processor.snapshot()).state.egressRules.length === 1,
      { description: "project processor to fold the approval rule" },
    );

    // The two fetches are SEQUENTIAL, so each becomes its own batch of one —
    // the second can't coalesce with a request that had to be approved first.
    const code = `async (itx) => {
      const bare = await fetch(${JSON.stringify(echo.url)}, {
        method: "POST",
        body: JSON.stringify({ orderId: 1234, via: "bare fetch" }),
      });
      const scoped = await itx.egress.fetch(new Request(${JSON.stringify(echo.url)}, {
        method: "POST",
        body: JSON.stringify({ orderId: 1234, via: "itx egress" }),
      }));
      return [bare.status, scoped.status];
    }`;
    const execution = agent.capabilityHost.runScript(code);

    const bareRequest = await root.waitForEvent({
      afterOffset: 0,
      eventTypes: [REQUESTED],
      timeoutMs: 30_000,
    });
    const barePayload = bareRequest.payload as HumanApprovalRequestedPayload;
    expect(barePayload).toMatchObject({
      requests: [
        {
          body: {
            encoding: "utf8",
            content: JSON.stringify({ orderId: 1234, via: "bare fetch" }),
          },
        },
      ],
      ruleDescription: "Refunds require confirmation",
      ruleKey: "refunds-need-confirmation",
      streamContext: {
        kind: "script-execution",
        executionId: expect.any(String),
        scriptRunRequestedEventOffset: expect.any(Number),
        streamPath: agentPath,
      },
    });
    if (barePayload.streamContext?.kind !== "script-execution") {
      throw new Error("expected script-execution approval provenance");
    }
    const scriptEvent = await agent.stream.getEvent({
      offset: barePayload.streamContext.scriptRunRequestedEventOffset,
    });
    expect(scriptEvent).toMatchObject({
      type: "events.iterate.com/capability-host/script-run-requested",
      payload: { code, executionId: barePayload.streamContext.executionId },
    });

    await root.append({
      type: DECIDED,
      payload: {
        approvalRequestEventOffset: bareRequest.offset,
        verdicts: ["approve"],
        decidedBy: "human",
      },
    });
    const scopedRequest = await root.waitForEvent({
      afterOffset: bareRequest.offset,
      eventTypes: [REQUESTED],
      timeoutMs: 30_000,
    });
    expect(scopedRequest.payload).toMatchObject({
      requests: [
        {
          body: {
            encoding: "utf8",
            content: JSON.stringify({ orderId: 1234, via: "itx egress" }),
          },
        },
      ],
      streamContext: barePayload.streamContext,
    });
    await root.append({
      type: DECIDED,
      payload: {
        approvalRequestEventOffset: scopedRequest.offset,
        verdicts: ["approve"],
        decidedBy: "human",
      },
    });

    await expect(execution).resolves.toMatchObject({ result: [200, 200] });
  } finally {
    await echo.close();
  }
}, 120_000);

// The incident this reproduces (tasks/script-runs-survive-parked-egress-holds.md):
// a script run's fetch parks at the egress door for however long a human takes
// to answer — minutes, not milliseconds. If the stream Durable Object behind
// the door's resolution wait restarts meanwhile (connection recycle, eviction,
// deploy reset), the door must re-arm from its durable cursor, not fail the
// parked fetch and with it the whole run. `kill()` is the public chaos
// operator injecting exactly that rejection class deterministically.
test("a script run's parked hold survives a stream Durable Object restart", async () => {
  const echo = await startEgressEcho();
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });

  try {
    using project = await itx.projects.get(`egress-hold-restart-${crypto.randomUUID()}`).create({});
    const root = project.streams.get("/");
    const agent = await project.agents.get("/agents/patient-agent").create();
    const echoHost = new URL(echo.url).hostname;
    await root.append({
      type: RULES_CONFIGURED,
      payload: {
        rules: [
          {
            ruleKey: "needs-human",
            description: "POSTs to the echo need a human",
            match: { hosts: [echoHost], methods: ["POST"] },
            verdict: "hold",
            approvalTimeoutMs: 60_000,
          },
        ],
      },
    });
    await waitForCondition(
      async () => (await project.processor.snapshot()).state.egressRules.length === 1,
      { description: "project processor to fold the hold rule" },
    );

    const code = `async (itx) => {
      const response = await fetch(${JSON.stringify(echo.url)}, {
        method: "POST",
        body: "still here after the restart",
      });
      return response.status;
    }`;
    const execution = agent.capabilityHost.runScript(code);

    const requested = await root.waitForEvent({
      afterOffset: 0,
      eventTypes: [REQUESTED],
      timeoutMs: 30_000,
    });

    // Restart only once the door's resolution wait is armed on the stream DO
    // (its one-shot waiter is an ephemeral "waitForEvent" connection; this
    // test holds no live wait of its own here), so the restart deterministically
    // lands mid-hold instead of racing the arming.
    await waitForCondition(
      async () => {
        const state = await root.runtimeState();
        return Object.values(state.runtime.connections).some(
          (connection) => connection.openedBy?.description === "waitForEvent",
        );
      },
      { description: "the egress door's resolution wait to be armed" },
    );
    // The abort rejects the in-flight kill() call itself — expected.
    await root.kill().catch(() => undefined);

    await root.append({
      type: DECIDED,
      idempotencyKey: `human-approval-decided:${requested.offset}`,
      payload: {
        approvalRequestEventOffset: requested.offset,
        verdicts: ["approve"],
        decidedBy: "human",
      },
    });

    await expect(execution).resolves.toMatchObject({ result: 200 });
    const settled = await root.waitForEvent({
      afterOffset: requested.offset,
      eventTypes: [SETTLED],
      timeoutMs: 30_000,
    });
    expect(settled.payload).toMatchObject({
      approvalRequestEventOffset: requested.offset,
      index: 0,
      status: 200,
    });
  } finally {
    await echo.close();
  }
}, 120_000);

test("an approved fetch never succeeds without its durable settlement fact", async () => {
  const echo = await startEgressEcho();
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });

  try {
    using project = await itx.projects
      .get(`egress-settlement-required-${crypto.randomUUID()}`)
      .create({});
    const root = project.streams.get("/");
    await root.append({
      type: RULES_CONFIGURED,
      payload: {
        rules: [
          {
            ruleKey: "needs-human",
            description: "POSTs to the echo need a human",
            match: { hosts: [new URL(echo.url).hostname], methods: ["POST"] },
            verdict: "hold",
            approvalTimeoutMs: 60_000,
          },
        ],
      },
    });
    await waitForCondition(
      async () => (await project.processor.snapshot()).state.egressRules.length === 1,
      { description: "project processor to fold the hold rule" },
    );

    // Normalize capnweb's callable RpcPromise into a native Promise so Vitest
    // does not mistake it for a function matcher target.
    const heldFetch = (async () =>
      await project.egress.fetch(
        new Request(echo.url, {
          method: "POST",
          body: "settlement is part of success",
        }),
      ))();
    const requested = await root.waitForEvent({
      afterOffset: 0,
      eventTypes: [REQUESTED],
      timeoutMs: 30_000,
    });

    // Occupy the deterministic settlement key with a different durable fact.
    // This injects a non-retryable journal failure through the public stream
    // API, without reaching into Stream DO storage or mocking the egress door.
    await root.append({
      type: "events.iterate.com/test/occupied-egress-settlement-key",
      idempotencyKey: `human-approval-settled:${requested.offset}:0`,
      payload: { injectedBy: "egress settlement durability e2e" },
    });
    await root.append({
      type: DECIDED,
      payload: {
        approvalRequestEventOffset: requested.offset,
        verdicts: ["approve"],
        decidedBy: "human",
      },
    });

    await expect(heldFetch).rejects.toThrow(/idempotency/i);
    await expect(
      root.getEvents({ afterOffset: requested.offset, eventTypes: [SETTLED] }),
    ).resolves.toEqual([]);
  } finally {
    await echo.close();
  }
}, 120_000);

test("approved worker WebSocket egress stays on the fetch-native transport", async () => {
  await using echo = await startWebSocketEcho();
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects
    .get(`egress-approval-websocket-${crypto.randomUUID()}`)
    .create({});
  const root = project.streams.get("/");
  const agent = await project.agents.get("/agents/websocket-agent").create();
  const websocketUrl = new URL(echo.url);
  websocketUrl.protocol = "wss:";

  await root.append({
    type: RULES_CONFIGURED,
    payload: {
      rules: [
        {
          ruleKey: "websockets-need-confirmation",
          description: "WebSocket connections require confirmation",
          match: { hosts: [websocketUrl.hostname], methods: ["GET"] },
          verdict: "hold",
          approvalTimeoutMs: 60_000,
        },
      ],
    },
  });
  await waitForCondition(
    async () => (await project.processor.snapshot()).state.egressRules.length === 1,
    { description: "project processor to fold the WebSocket approval rule" },
  );

  const echoedMessage = `approved-websocket-${crypto.randomUUID()}`;
  const execution = agent.capabilityHost.runScript(`async () => {
    const socket = new WebSocket(${JSON.stringify(websocketUrl.href)});
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket echo timed out")), 30_000);
      socket.addEventListener("message", (event) => {
        const message = String(event.data);
        if (message === ${JSON.stringify(WEBSOCKET_ECHO_GREETING)}) {
          socket.send(${JSON.stringify(echoedMessage)});
        }
        if (message === ${JSON.stringify(echoedMessage)}) {
          clearTimeout(timeout);
          socket.close(1000, "approval-proof-complete");
          resolve(message);
        }
      });
      socket.addEventListener("error", () => reject(new Error("WebSocket echo failed")));
    });
  }`);

  const requested = await root.waitForEvent({
    afterOffset: 0,
    eventTypes: [REQUESTED],
    timeoutMs: 30_000,
  });
  expect(requested.payload).toMatchObject({
    requests: [{ method: "GET" }],
    ruleKey: "websockets-need-confirmation",
    streamContext: {
      kind: "script-execution",
      streamPath: "/agents/websocket-agent",
    },
  });
  expect(
    (requested.payload as HumanApprovalRequestedPayload).requests[0]!.headers,
  ).not.toHaveProperty(STREAM_CONTEXT_HEADER);
  await root.append({
    type: DECIDED,
    payload: {
      approvalRequestEventOffset: requested.offset,
      verdicts: ["approve"],
      decidedBy: "human",
    },
  });

  await expect(execution).resolves.toMatchObject({ result: echoedMessage });
});

test("a script's burst coalesces into ONE batch event, one push, and one decision releases all", async () => {
  const echo = await startEgressEcho();
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });

  try {
    using project = await itx.projects
      .get(`egress-approval-batch-${crypto.randomUUID()}`)
      .create({});
    const root = project.streams.get("/");
    const agent = await project.agents.get("/agents/burst-agent").create();
    const echoHost = new URL(echo.url).hostname;
    await root.append({
      type: RULES_CONFIGURED,
      payload: {
        rules: [
          {
            ruleKey: "burst-needs-a-human",
            description: "Echo POSTs need a human",
            match: { hosts: [echoHost], methods: ["POST"] },
            verdict: "hold",
            approvalTimeoutMs: 120_000,
            // Generous window so a CI-slow burst still lands in ONE batch —
            // the default 100ms is tuned for production burst latencies.
            debounceMs: 2_000,
          },
        ],
      },
    });
    await waitForCondition(
      async () => (await project.processor.snapshot()).state.egressRules.length === 1,
      { description: "project processor to fold the burst hold rule" },
    );

    const execution = agent.capabilityHost.runScript(`async () => {
      const responses = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          fetch(${JSON.stringify(echo.url)}, { method: "POST", body: "burst " + index }),
        ),
      );
      return responses.map((response) => response.status);
    }`);

    // The dataloader commits the whole burst as ONE requested event.
    const requested = await root.waitForEvent({
      afterOffset: 0,
      eventTypes: [REQUESTED],
      timeoutMs: 60_000,
    });
    const payload = requested.payload as HumanApprovalRequestedPayload;
    expect(payload.requests).toHaveLength(4);
    expect(payload.streamContext).toMatchObject({ kind: "script-execution" });

    // ONE push intent, straight off the batch event — no debounce state
    // machine anywhere downstream.
    const intent = await root.waitForEvent({
      afterOffset: 0,
      eventTypes: [NOTIFICATION_REQUESTED],
      timeoutMs: 30_000,
    });
    expect(intent.payload).toMatchObject({
      audience: { kind: "project" },
      // A batch born of an agent thread's run deep-links to that thread;
      // only scope holds keep the approvals-screen destination.
      destination: { kind: "agent-chat", path: "/agents/burst-agent" },
      // The push body names hosts with their ports — that's what identifies a
      // local destination.
      body: `Script run waiting: 4 requests (4x ${new URL(echo.url).host})`,
    });

    // ONE decision releases all four.
    await root.append({
      type: DECIDED,
      payload: {
        approvalRequestEventOffset: requested.offset,
        verdicts: ["approve", "approve", "approve", "approve"],
        decidedBy: "human",
      },
    });
    await expect(execution).resolves.toMatchObject({ result: [200, 200, 200, 200] });

    // Exactly one requested event and one intent for the whole burst.
    await waitForCondition(
      async () => (await root.getEvents({ eventTypes: [SETTLED] })).length === 4,
      { description: "all four released requests to settle" },
    );
    expect(await root.getEvents({ eventTypes: [REQUESTED] })).toHaveLength(1);
    expect(await root.getEvents({ eventTypes: [NOTIFICATION_REQUESTED] })).toHaveLength(1);
  } finally {
    await echo.close();
  }
}, 120_000);

test("mixed verdicts in one decision: approved indexes release, rejected indexes refuse", async () => {
  const echo = await startEgressEcho();
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });

  try {
    using project = await itx.projects
      .get(`egress-approval-mixed-${crypto.randomUUID()}`)
      .create({});
    const root = project.streams.get("/");
    const agent = await project.agents.get("/agents/mixed-agent").create();
    const echoHost = new URL(echo.url).hostname;
    await root.append({
      type: RULES_CONFIGURED,
      payload: {
        rules: [
          {
            ruleKey: "mixed-feelings",
            match: { hosts: [echoHost], methods: ["POST"] },
            verdict: "hold",
            approvalTimeoutMs: 60_000,
            debounceMs: 2_000,
          },
        ],
      },
    });
    await waitForCondition(
      async () => (await project.processor.snapshot()).state.egressRules.length === 1,
      { description: "project processor to fold the mixed hold rule" },
    );

    const execution = agent.capabilityHost.runScript(`async () => {
      const responses = await Promise.all([
        fetch(${JSON.stringify(echo.url)}, { method: "POST", body: "the good one" }),
        fetch(${JSON.stringify(echo.url)}, { method: "POST", body: "the bad one" }),
      ]);
      return responses.map((response) => response.status);
    }`);

    const requested = await root.waitForEvent({
      afterOffset: 0,
      eventTypes: [REQUESTED],
      timeoutMs: 60_000,
    });
    const payload = requested.payload as HumanApprovalRequestedPayload;
    expect(payload.requests).toHaveLength(2);
    // Verdicts are by index: approve whichever slot holds "the good one".
    const goodIndex = payload.requests.findIndex(
      (request) => request.body?.content === "the good one",
    );
    await root.append({
      type: DECIDED,
      payload: {
        approvalRequestEventOffset: requested.offset,
        verdicts: goodIndex === 0 ? ["approve", "reject"] : ["reject", "approve"],
        decidedBy: "human",
      },
    });

    const { result } = (await execution) as { result: number[] };
    expect([...result].sort()).toEqual([200, 403]);
    // Only the approved index settles; the rejected one has no outcome to record.
    const settled = await root.getEvents({ eventTypes: [SETTLED] });
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({
      approvalRequestEventOffset: requested.offset,
      index: goodIndex,
      status: 200,
    });
  } finally {
    await echo.close();
  }
}, 120_000);

test("enrolled approval keys make unsigned approvals inert; a signed decision releases", async () => {
  const echo = await startEgressEcho();
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });

  try {
    using project = await itx.projects
      .get(`egress-approvals-signed-${crypto.randomUUID()}`)
      .create({});
    // The signed message binds the real prj_… id (what the DO verifies with).
    const projectId = (await project.__describe()).projectId;
    const stream = project.streams.get("/");
    const echoHost = new URL(echo.url).hostname;

    // The human's keypair — what the Secure Enclave holds on a real Mac.
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const publicKey = bytesToBase64(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    );
    const keyId = "e2e-test-key";

    await stream.append(
      {
        type: RULES_CONFIGURED,
        payload: {
          rules: [
            {
              ruleKey: "post-echo-signed",
              match: { hosts: [echoHost], methods: ["POST"] },
              verdict: "hold",
              approvalTimeoutMs: 60_000,
            },
          ],
        },
      },
      { type: KEY_ADDED, payload: { keyId, publicKey, label: "e2e" } },
    );
    await waitForCondition(
      async () => {
        const state = (await project.processor.snapshot()).state;
        return state.egressRules.length === 1 && state.humanApprovalKeys.length === 1;
      },
      { description: "project processor to fold the rule and the approval key" },
    );

    const heldFetch = project.egress.fetch(
      new Request(echo.url, { method: "POST", body: "sign me" }),
    );
    const requested = await stream.waitForEvent({
      afterOffset: 0,
      eventTypes: [REQUESTED],
      timeoutMs: 30_000,
    });
    const requestedPayload = requested.payload as HumanApprovalRequestedPayload;

    // An unsigned approval (and one with a bad signature) must NOT release.
    await stream.append(
      {
        type: DECIDED,
        payload: {
          approvalRequestEventOffset: requested.offset,
          verdicts: ["approve"],
          decidedBy: "human",
        },
      },
      {
        type: DECIDED,
        payload: {
          approvalRequestEventOffset: requested.offset,
          verdicts: ["approve"],
          decidedBy: "human",
          keyId,
          signature: bytesToBase64(new Uint8Array(64)),
        },
      },
    );

    const message = buildApprovalMessage({
      projectId,
      approvalRequestEventOffset: requested.offset,
      requests: requestedPayload.requests,
      verdicts: ["approve"],
    });
    const signature = bytesToBase64(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          message as BufferSource,
        ),
      ),
    );
    await stream.append({
      type: DECIDED,
      payload: {
        approvalRequestEventOffset: requested.offset,
        verdicts: ["approve"],
        decidedBy: "human",
        keyId,
        signature,
      },
    });

    const releasedResponse = await heldFetch;
    expect(releasedResponse).toMatchObject({ status: 200 });

    // The settled event proves release happened via the SIGNED decision path:
    // it appends strictly after the signed decision's offset. (Had either
    // unsigned/bad decision released, settle would have landed before it.)
    const settled = await stream.waitForEvent({
      afterOffset: requested.offset,
      eventTypes: [SETTLED],
      timeoutMs: 30_000,
    });
    expect(settled.payload).toMatchObject({
      approvalRequestEventOffset: requested.offset,
      index: 0,
      status: 200,
    });
    const decisions = await stream.getEvents({
      afterOffset: requested.offset,
      eventTypes: [DECIDED],
    });
    const signedDecisionOffset = decisions.find(
      (event) => (event.payload as { signature?: string }).signature === signature,
    )!.offset;
    expect(settled.offset).toBeGreaterThan(signedDecisionOffset);
  } finally {
    await echo.close();
  }
}, 120_000);
