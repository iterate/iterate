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
  buildApprovalMessage,
  bytesToBase64,
  type HumanApprovalRequestedPayload,
} from "../../src/domains/projects/egress-approvals.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { startEgressEcho } from "./itx-capability-fixtures.ts";
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
    using project = itx.projects.create({ slug: `egress-approvals-${crypto.randomUUID()}` });
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
      bodyPreview: "please approve",
      secretPaths: [],
    });
    expect(requestedPayload.headers["x-approval-proof"]).toBe("hold-me");
    expect(requestedPayload.bodySha256).toMatch(/^[0-9a-f]{64}$/);

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

    // ── reject lane: a human refusal turns into a 403 for the caller.
    const rejectedFetch = project.egress.fetch(
      new Request(echo.url, { method: "POST", body: "please reject" }),
    );
    const rejectedRequested = await stream.waitForEvent({
      afterOffset: settled.offset,
      eventTypes: [REQUESTED],
      timeoutMs: 30_000,
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

test("enrolled approval keys make unsigned grants inert; a signed grant releases", async () => {
  const echo = await startEgressEcho();
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });

  try {
    using project = itx.projects.create({
      slug: `egress-approvals-signed-${crypto.randomUUID()}`,
    });
    // The signed message binds the real prj_… id (what the DO verifies with).
    const projectId = (await project.processor.snapshot()).state.createRequest!.projectId;
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
