// approval.e2e.test.ts — public proof for the direct-secret egress gate. The request itself never
// enters the event log: the gate exposes only an opaque request id + fingerprint, and an ordinary
// trusted signed event decides that exact pending request.

import { expect, test } from "vitest";
import { provenanceMessage } from "../src/provenance.ts";
import {
  append,
  freshCtx,
  openItx,
  readAll,
  rejection,
  sleep,
  workerUrl,
} from "./support/client.ts";

const ADMIN = { authorization: "Bearer e2e-admin-token", "content-type": "application/json" };
const TRUST_CONFIGURED = "events.iterate.com/provenance/trust-configured";
const POLICY_CONFIGURED = "events.iterate.com/egress/policy-configured";
const APPROVAL_DECIDED = "events.iterate.com/approval/decided";

type Gate = {
  code: "APPROVAL_REQUIRED";
  requestId: string;
  fingerprint: string;
  expiresAt: number;
};

async function signingKey() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString(
    "base64url",
  );
  return {
    keyId: `ed25519:${publicKey}`,
    async sign(message: string) {
      return {
        algorithm: "Ed25519" as const,
        publicKey,
        signature: Buffer.from(
          await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(message)),
        ).toString("base64url"),
      };
    },
  };
}

async function signed(
  projectId: string,
  event: Record<string, unknown>,
  signer: Awaited<ReturnType<typeof signingKey>>,
) {
  return {
    ...event,
    provenance: {
      signatures: [await signer.sign(provenanceMessage(event, { projectId, path: "/" }))],
    },
  };
}

async function installDirectSecret(projectId: string) {
  const response = await fetch(workerUrl(`/secrets?context=${encodeURIComponent(projectId)}`), {
    method: "POST",
    headers: ADMIN,
    body: JSON.stringify({
      name: "TOKEN",
      value: "e2e-only-plaintext",
      origin: "https://egress.invalid",
    }),
  });
  expect(response.status).toBe(200);
}

function outbound(approvalId?: string) {
  return new Request("https://egress.invalid/approved", {
    method: "POST",
    headers: {
      authorization: "{{secret:TOKEN}}",
      ...(approvalId === undefined ? {} : { "x-iterate-approval": approvalId }),
    },
    body: "body-bound-to-the-approval",
  });
}

async function gate(itx: any): Promise<Gate> {
  const response = await itx.fetch(outbound());
  expect(response.status).toBe(202);
  const result = (await response.json()) as Gate;
  expect(result.code).toBe("APPROVAL_REQUIRED");
  return result;
}

async function configureTrustedGate(projectId: string, expiresInMs = 60_000) {
  const itx = openItx(projectId);
  const alice = await signingKey();
  await append(itx, {
    type: TRUST_CONFIGURED,
    payload: { keys: [alice.keyId], minimumLevel: 2 },
    idempotencyKey: "trust-alice",
  });
  await append(
    itx,
    await signed(
      projectId,
      {
        type: POLICY_CONFIGURED,
        payload: { approval: "required", expiresInMs },
        idempotencyKey: "gate-required",
      },
      alice,
    ),
  );
  return { itx, alice };
}

test("an untouched context keeps the legacy egress terminal rather than minting an approval", async () => {
  const itx = openItx(freshCtx("approval-legacy"));
  // The isolated fallback may return a network error, but a 202 would prove the new gate changed
  // a request that has neither direct-secret syntax nor an installed policy.
  expect((await itx.fetch(new Request("https://egress.invalid/legacy"))).status).not.toBe(202);
  expect((await readAll(itx)).some((event) => event.type === "itx.system.egress.requested")).toBe(
    false,
  );
});

test("a trusted approval releases exactly its pending request once", async () => {
  const projectId = freshCtx("approval-roundtrip");
  await installDirectSecret(projectId);
  const { itx, alice } = await configureTrustedGate(projectId);
  const pending = await gate(itx);
  const decision = await signed(
    projectId,
    {
      type: APPROVAL_DECIDED,
      payload: { requestId: pending.requestId, fingerprint: pending.fingerprint, allow: true },
      idempotencyKey: "approve-once",
    },
    alice,
  );
  const [approved] = await append(itx, decision);
  expect(approved.verification).toMatchObject({ level: 2, signerKeyIds: [alice.keyId] });

  // `egress.invalid` need not answer in the isolated workerd topology. Reaching any non-202
  // terminal response proves the gate released it; the durable audit proves the output claim won.
  expect((await itx.fetch(outbound(pending.requestId))).status).not.toBe(202);
  expect(
    (await readAll(itx)).filter((event) => event.type === "itx.system.egress.released"),
  ).toHaveLength(1);

  const replay = await itx.fetch(outbound(pending.requestId));
  expect(replay.status).toBe(409);
  expect(await replay.text()).toContain("APPROVAL_USED");
  expect(
    (await readAll(itx)).filter((event) => event.type === "itx.system.egress.released"),
  ).toHaveLength(1);
});

test("approval is authorized at commit time, so rotation and a failed sequential batch cannot leak it", async () => {
  const projectId = freshCtx("approval-rotation");
  await installDirectSecret(projectId);
  const { itx, alice } = await configureTrustedGate(projectId);
  const pending = await gate(itx);
  const bob = await signingKey();
  const charlie = await signingKey();
  const rotateToBob = await signed(
    projectId,
    {
      type: TRUST_CONFIGURED,
      payload: { keys: [bob.keyId], minimumLevel: 2 },
      idempotencyKey: "trust-bob",
    },
    alice,
  );
  await append(itx, rotateToBob);

  const staleApproval = await signed(
    projectId,
    {
      type: APPROVAL_DECIDED,
      payload: { requestId: pending.requestId, fingerprint: pending.fingerprint, allow: true },
      idempotencyKey: "alice-after-rotation",
    },
    alice,
  );
  expect((await rejection(append(itx, staleApproval))).code).toBe("PROVENANCE_REQUIRED");

  const rotateToCharlie = await signed(
    projectId,
    {
      type: TRUST_CONFIGURED,
      payload: { keys: [charlie.keyId], minimumLevel: 2 },
      idempotencyKey: "trust-charlie",
    },
    bob,
  );
  const bobApproval = await signed(
    projectId,
    {
      type: APPROVAL_DECIDED,
      payload: { requestId: pending.requestId, fingerprint: pending.fingerprint, allow: true },
      idempotencyKey: "bob-approval",
    },
    bob,
  );
  const beforeRejectedBatch = await readAll(itx);
  expect((await rejection(append(itx, rotateToCharlie, bobApproval))).code).toBe(
    "PROVENANCE_REQUIRED",
  );
  expect(await readAll(itx)).toEqual(beforeRejectedBatch);

  await append(itx, bobApproval);
  expect((await itx.fetch(outbound(pending.requestId))).status).not.toBe(202);
});

test("an expired approval cannot be decided or replayed", async () => {
  const projectId = freshCtx("approval-expiry");
  await installDirectSecret(projectId);
  const { itx, alice } = await configureTrustedGate(projectId, 1_000);
  const pending = await gate(itx);
  await sleep(1_100);
  const decision = await signed(
    projectId,
    {
      type: APPROVAL_DECIDED,
      payload: { requestId: pending.requestId, fingerprint: pending.fingerprint, allow: true },
      idempotencyKey: "late-approval",
    },
    alice,
  );
  expect((await rejection(append(itx, decision))).code).toBe("APPROVAL_EXPIRED");
  const replay = await itx.fetch(outbound(pending.requestId));
  expect(replay.status).toBe(409);
  expect(await replay.text()).toContain("APPROVAL_EXPIRED");
});
