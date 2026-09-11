// fetch-policy-authority.e2e.test.ts — policy facts use the same public full-write append
// capability as every other durable fact. A project that needs a policy lockdown chooses it in
// the global provenance policy; approval tokens do not restrict a policy writer.

import { expect, test } from "vitest";
import { provenanceMessage } from "../src/provenance.ts";
import { append, freshCtx, openItx, readAll, rejection } from "./support/client.ts";

const TRUST_CONFIGURED = "events.iterate.com/provenance/trust-configured";
const POLICY_CONFIGURED = "events.iterate.com/egress/policy-configured";

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
    async sign(event: Record<string, unknown>, projectId: string) {
      return {
        signatures: [
          {
            algorithm: "Ed25519" as const,
            publicKey,
            signature: Buffer.from(
              await crypto.subtle.sign(
                "Ed25519",
                pair.privateKey,
                new TextEncoder().encode(provenanceMessage(event, { projectId, path: "/" })),
              ),
            ).toString("base64url"),
          },
        ],
      };
    },
  };
}

const outbound = (path: string) => new Request(`https://egress.invalid/${path}`);

test("minimumLevel 0 intentionally lets a full public ITX writer change the gate", async () => {
  const projectId = freshCtx("fetch-policy-level-zero");
  const itx = openItx(projectId);
  const alice = await signingKey();
  await append(itx, {
    type: TRUST_CONFIGURED,
    payload: { keys: [alice.keyId], minimumLevel: 0 },
    idempotencyKey: "trust-level-zero",
  });
  await append(itx, {
    type: POLICY_CONFIGURED,
    payload: { approval: "required", expiresInMs: 60_000 },
    idempotencyKey: "require-approval",
  });
  expect((await itx.fetch(outbound("held"))).status).toBe(202);

  await append(itx, {
    type: POLICY_CONFIGURED,
    payload: { approval: "none" },
    idempotencyKey: "disable-approval",
  });
  expect((await readAll(itx)).some((event) => event.idempotencyKey === "disable-approval")).toBe(
    true,
  );
  // The isolated fallback cannot resolve egress.invalid, so its 500 proves the fresh request
  // reached the terminal rather than being held by the approval gate.
  expect((await itx.fetch(outbound("released"))).status).toBe(500);
});

test("minimumLevel 2 rejects an unsigned policy change and accepts the configured trusted signer", async () => {
  const projectId = freshCtx("fetch-policy-level-two");
  const itx = openItx(projectId);
  const alice = await signingKey();
  await append(itx, {
    type: TRUST_CONFIGURED,
    payload: { keys: [alice.keyId], minimumLevel: 2 },
    idempotencyKey: "trust-level-two",
  });
  const required = {
    type: POLICY_CONFIGURED,
    payload: { approval: "required", expiresInMs: 60_000 },
    idempotencyKey: "signed-require-approval",
  };
  await append(itx, { ...required, provenance: await alice.sign(required, projectId) });
  expect((await itx.fetch(outbound("held"))).status).toBe(202);

  const unsignedDisable = {
    type: POLICY_CONFIGURED,
    payload: { approval: "none" },
    idempotencyKey: "unsigned-disable-approval",
  };
  expect((await rejection(append(itx, unsignedDisable))).code).toBe("PROVENANCE_REQUIRED");
  expect((await itx.fetch(outbound("still-held"))).status).toBe(202);

  const signedDisable = {
    ...unsignedDisable,
    idempotencyKey: "signed-disable-approval",
  };
  const [committed] = await append(itx, {
    ...signedDisable,
    provenance: await alice.sign(signedDisable, projectId),
  });
  expect(committed.verification).toMatchObject({ level: 2, signerKeyIds: [alice.keyId] });
  expect((await itx.fetch(outbound("released"))).status).toBe(500);
});
