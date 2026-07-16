// Live human-in-the-loop egress approval round trip through the phone's own
// approver code, from Node — mirrors
// apps/os/e2e/vitest/egress-approvals.e2e.test.ts's "enrolled key" lane but
// signs with approver-core.ts (the exact @noble/curves code the phone runs;
// no Expo imports, same Node-testable split as itx-core.ts) instead of raw
// crypto.subtle. Proves the mobile software-key approver is byte-for-byte
// compatible with the platform's real verifier, end to end: a real held
// fetch, a real Face-ID-shaped signature (minus the Face ID — that's
// approver.ts's job, untestable outside Expo), a real release.
//
//   doppler run --config dev -- pnpm --dir apps/mobile test:e2e   # local dev (pnpm dev must be running)

import { expect, test } from "vitest";
import { newWebSocketRpcSession } from "capnweb";
import { waitForCondition } from "../../os/e2e/test-support/wait-for-condition.ts";
import { withTunnel } from "../../os/e2e/test-support/tunnel.ts";
import type { UnauthenticatedOs } from "../../os/src/itx-api.generated.ts";
import { generateApproverKey, signApprovalMessage } from "../src/lib/approver-core.ts";
import {
  deriveOpenRequests,
  EVENT,
  grant,
  reject,
  type RequestedPayload,
} from "../src/lib/approvals.ts";
import { requireEnv, resolveBaseUrl, wsUrl } from "./e2e-helpers.ts";

const RULES_CONFIGURED = "events.iterate.com/project/egress-rules-configured";

/**
 * Same fixture as apps/os/e2e/vitest/itx-capability-fixtures.ts's
 * startEgressEcho, reimplemented locally: importing that file drags in its
 * WebSocket-echo helper, which is typed against Cloudflare Workers globals
 * apps/mobile's tsconfig doesn't have. withTunnel itself (Node + captun,
 * Workers-free) is the reusable part.
 */
function startEgressEcho() {
  return withTunnel({
    path: "/egress-echo",
    fetch(request) {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return Response.json({ headers });
    },
  });
}

test("phone approver: enrolled key signs a real held request and the door releases it", async () => {
  const baseUrl = resolveBaseUrl();
  const admin = newWebSocketRpcSession<UnauthenticatedOs>(wsUrl(baseUrl));
  const adminSession = await admin.authenticate({
    type: "admin-secret",
    secret: requireEnv("APP_CONFIG_ADMIN_API_SECRET"),
  });

  const echo = await startEgressEcho();
  try {
    const slug = `mobile-approver-e2e-${Date.now().toString(36)}`;
    const project = await adminSession.projects.create({ slug });
    const projectId = (await project.__describe()).projectId;
    const stream = project.streams.get("/");
    const echoHost = new URL(echo.url).hostname;

    // Enroll — the exact key material approver.ts would generate and
    // persist behind Face ID (approver.ts itself needs expo-secure-store,
    // so this drives approver-core.ts directly, same split as itx-core.ts).
    const key = generateApproverKey();
    await stream.append(
      {
        type: RULES_CONFIGURED,
        payload: {
          rules: [
            {
              ruleKey: "mobile-e2e",
              description: "The mobile approver e2e's own held request",
              match: { hosts: [echoHost], methods: ["POST"] },
              verdict: "hold",
              approvalTimeoutMs: 60_000,
            },
          ],
        },
      },
      {
        type: EVENT.keyAdded,
        payload: { keyId: key.keyId, publicKey: key.publicKey, label: "mobile-e2e-phone" },
      },
    );
    await waitForCondition(
      async () => {
        const state = (await project.processor.snapshot()).state;
        return state.egressRules.length === 1 && state.humanApprovalKeys.length === 1;
      },
      { description: "project processor to fold the rule and the phone's approval key" },
    );

    const heldFetch = project.egress.fetch(
      new Request(echo.url, { method: "POST", body: "approve me from the phone" }),
    );
    const requested = await stream.waitForEvent({
      afterOffset: 0,
      eventTypes: [EVENT.requested],
      timeoutMs: 30_000,
    });

    // Confirm the UI's pure derivation agrees before we act — this is what
    // the approvals screen would render right now.
    const backlog = deriveOpenRequests(
      await stream.getEvents({
        eventTypes: [EVENT.requested, EVENT.granted, EVENT.rejected, EVENT.settled],
      }),
    );
    expect(backlog).toMatchObject([{ offset: requested.offset, submitted: false }]);

    await grant({
      stream,
      projectId,
      offset: requested.offset,
      payload: requested.payload as RequestedPayload,
      sign: async (message) => ({
        keyId: key.keyId,
        signature: signApprovalMessage(key.privateKey, message),
      }),
    });

    const released = await heldFetch;
    expect(released).toMatchObject({ status: 200 });

    const settled = await stream.waitForEvent({
      afterOffset: requested.offset,
      eventTypes: [EVENT.settled],
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

test("phone approver: a rejection refuses the held request without signing anything", async () => {
  const baseUrl = resolveBaseUrl();
  const admin = newWebSocketRpcSession<UnauthenticatedOs>(wsUrl(baseUrl));
  const adminSession = await admin.authenticate({
    type: "admin-secret",
    secret: requireEnv("APP_CONFIG_ADMIN_API_SECRET"),
  });

  const echo = await startEgressEcho();
  try {
    const slug = `mobile-approver-reject-e2e-${Date.now().toString(36)}`;
    const project = await adminSession.projects.create({ slug });
    const stream = project.streams.get("/");
    const echoHost = new URL(echo.url).hostname;

    await stream.append({
      type: RULES_CONFIGURED,
      payload: {
        rules: [
          {
            ruleKey: "mobile-e2e-reject",
            match: { hosts: [echoHost], methods: ["POST"] },
            verdict: "hold",
            approvalTimeoutMs: 60_000,
          },
        ],
      },
    });
    await waitForCondition(
      async () => (await project.processor.snapshot()).state.egressRules.length === 1,
      { description: "project processor to fold the rule" },
    );

    const rejectedFetch = project.egress.fetch(
      new Request(echo.url, { method: "POST", body: "reject me from the phone" }),
    );
    const requested = await stream.waitForEvent({
      afterOffset: 0,
      eventTypes: [EVENT.requested],
      timeoutMs: 30_000,
    });

    await reject(stream, requested.offset);

    const rejectedResponse = await rejectedFetch;
    expect(rejectedResponse).toMatchObject({ status: 403 });

    const backlog = deriveOpenRequests(
      await stream.getEvents({
        eventTypes: [EVENT.requested, EVENT.granted, EVENT.rejected, EVENT.settled],
      }),
    );
    expect(backlog).toEqual([]);
  } finally {
    await echo.close();
  }
}, 120_000);
