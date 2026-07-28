// Proves human-in-the-loop egress approvals end-to-end: a request matching a
// `hold` rule parks at the Project DO egress door with the caller's fetch
// promise open, a "human" (this test, playing the `iterate approve` CLI's
// role over the same itx surface) grants or rejects on the project stream,
// and the door releases the real upstream call / refuses / auto-expires.
// Once an approval key is enrolled, grants must carry a valid P-256
// signature over the canonical approval.v1 message — an unsigned grant is
// ignored and only the signed one releases.

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
const GRANTED = "events.iterate.com/project/human-approval-granted";
const REJECTED = "events.iterate.com/project/human-approval-rejected";
const SETTLED = "events.iterate.com/project/human-approval-settled";

test("hold → grant releases, hold → reject refuses, short timeouts expire", async () => {
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

    // ── grant lane: the held fetch resolves with the real upstream response.
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
      method: "POST",
      ruleKey: "post-echo",
      body: {
        encoding: "utf8",
        content: "please approve",
        originalByteLength: 14,
        truncated: false,
      },
      secretPaths: [],
    });
    expect(requestedPayload.headers["x-approval-proof"]).toBe("hold-me");
    expect(requestedPayload.body?.sha256).toMatch(/^[0-9a-f]{64}$/);

    await stream.append({
      type: GRANTED,
      payload: { approvalRequestEventOffset: requested.offset },
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
      body: {
        encoding: "utf8",
        content: "r".repeat(APPROVAL_BODY_INSPECTION_LIMIT_BYTES),
        originalByteLength: oversizedBody.length,
        truncated: true,
      },
    });
    await stream.append({
      type: REJECTED,
      payload: { approvalRequestEventOffset: rejectedRequested.offset, reason: "human" },
    });
    const rejectedResponse = await rejectedFetch;
    expect(rejectedResponse).toMatchObject({ status: 403 });
    await expect(rejectedResponse.json()).resolves.toMatchObject({
      error: "approval_rejected",
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

    // ── expiry lane: nobody answers and the hold auto-rejects.
    const expiredResponse = await project.egress.fetch(
      new Request(echo.url, { method: "PUT", body: "too slow" }),
    );
    expect(expiredResponse).toMatchObject({ status: 403 });
    await expect(expiredResponse.json()).resolves.toMatchObject({
      error: "approval_expired",
      ruleKey: "impatient",
    });
    // The expiry rejection is committed before the 403 returns, so a plain
    // page read (no live wait) must already see it.
    const rejections = await stream.getEvents({
      afterOffset: rejectedRequested.offset,
      eventTypes: [REJECTED],
    });
    expect(rejections.map((event) => (event.payload as { reason?: string }).reason)).toContain(
      "expired",
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
      body: {
        encoding: "utf8",
        content: JSON.stringify({ orderId: 1234, via: "bare fetch" }),
      },
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
      type: GRANTED,
      payload: { approvalRequestEventOffset: bareRequest.offset },
    });
    const scopedRequest = await root.waitForEvent({
      afterOffset: bareRequest.offset,
      eventTypes: [REQUESTED],
      timeoutMs: 30_000,
    });
    expect(scopedRequest.payload).toMatchObject({
      body: {
        encoding: "utf8",
        content: JSON.stringify({ orderId: 1234, via: "itx egress" }),
      },
      streamContext: barePayload.streamContext,
    });
    await root.append({
      type: GRANTED,
      payload: { approvalRequestEventOffset: scopedRequest.offset },
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
      type: GRANTED,
      payload: { approvalRequestEventOffset: requested.offset },
    });

    await expect(execution).resolves.toMatchObject({ result: 200 });
    const settled = await root.waitForEvent({
      afterOffset: requested.offset,
      eventTypes: [SETTLED],
      timeoutMs: 30_000,
    });
    expect(settled.payload).toMatchObject({
      approvalRequestEventOffset: requested.offset,
      status: 200,
    });
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
    method: "GET",
    ruleKey: "websockets-need-confirmation",
    streamContext: {
      kind: "script-execution",
      streamPath: "/agents/websocket-agent",
    },
  });
  expect((requested.payload as HumanApprovalRequestedPayload).headers).not.toHaveProperty(
    STREAM_CONTEXT_HEADER,
  );
  await root.append({
    type: GRANTED,
    payload: { approvalRequestEventOffset: requested.offset },
  });

  await expect(execution).resolves.toMatchObject({ result: echoedMessage });
});

test("enrolled approval keys make unsigned grants inert; a signed grant releases", async () => {
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

    // An unsigned grant (and one with a bad signature) must NOT release.
    await stream.append(
      { type: GRANTED, payload: { approvalRequestEventOffset: requested.offset } },
      {
        type: GRANTED,
        payload: {
          approvalRequestEventOffset: requested.offset,
          keyId,
          signature: bytesToBase64(new Uint8Array(64)),
        },
      },
    );

    const message = buildApprovalMessage({
      projectId,
      approvalRequestEventOffset: requested.offset,
      requested: requestedPayload,
      decision: "granted",
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
      type: GRANTED,
      payload: { approvalRequestEventOffset: requested.offset, keyId, signature },
    });

    const releasedResponse = await heldFetch;
    expect(releasedResponse).toMatchObject({ status: 200 });

    // The settled event proves release happened via the SIGNED grant path:
    // it appends strictly after the signed grant's offset. (Had either
    // unsigned/bad grant released, settle would have landed before it.)
    const settled = await stream.waitForEvent({
      afterOffset: requested.offset,
      eventTypes: [SETTLED],
      timeoutMs: 30_000,
    });
    expect(settled.payload).toMatchObject({
      approvalRequestEventOffset: requested.offset,
      status: 200,
    });
    const grants = await stream.getEvents({
      afterOffset: requested.offset,
      eventTypes: [GRANTED],
    });
    const signedGrantOffset = grants.find(
      (event) => (event.payload as { signature?: string }).signature === signature,
    )!.offset;
    expect(settled.offset).toBeGreaterThan(signedGrantOffset);
  } finally {
    await echo.close();
  }
}, 120_000);
