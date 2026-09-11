// A deployed-only proof that a direct project secret reaches a healthy project-host terminal once.
// The synthetic secret is generated per run and is never printed or asserted as response content.

import { Buffer } from "node:buffer";
import { expect, test } from "vitest";
import { provenanceMessage } from "../src/provenance.ts";
import { append, freshCtx, openItx, readAll, workerUrl } from "./support/client.ts";

const TRUST_CONFIGURED = "events.iterate.com/provenance/trust-configured";
const POLICY_CONFIGURED = "events.iterate.com/egress/policy-configured";
const APPROVAL_DECIDED = "events.iterate.com/approval/decided";
const SECRET_NAME = "UPSTREAM_TOKEN";
const UPSTREAM_ORIGIN = "https://v4-custom.iterate2.app";
const upstream = (approvalId?: string) =>
  new Request(`${UPSTREAM_ORIGIN}/published-proof`, {
    headers: {
      authorization: `{{secret:${SECRET_NAME}}}`,
      ...(approvalId === undefined ? {} : { "x-iterate-approval": approvalId }),
    },
  });

type Gate = {
  code: "APPROVAL_REQUIRED";
  requestId: string;
  fingerprint: string;
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
    async sign(projectId: string, event: Record<string, unknown>) {
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

const deployedEgressProof =
  process.env.WORKER_BASE_URL && process.env.WORKER_DEMO_LOGIN && process.env.EXPERIMENT_ADMIN_TOKEN
    ? test
    : test.skip;

deployedEgressProof(
  "a trusted direct-secret approval reaches the healthy custom-host terminal exactly once",
  async () => {
    const projectId = freshCtx("egress-deployed");
    const secretMaterial = `synthetic-e2e-${crypto.randomUUID()}`;
    const stored = await fetch(workerUrl(`/secrets?context=${encodeURIComponent(projectId)}`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.EXPERIMENT_ADMIN_TOKEN!}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: SECRET_NAME, value: secretMaterial, origin: UPSTREAM_ORIGIN }),
    });
    expect(stored.status, await stored.clone().text()).toBe(200);
    expect(await stored.json()).toEqual({
      name: SECRET_NAME,
      origin: UPSTREAM_ORIGIN,
      revision: 1,
    });

    const itx = openItx(projectId);
    const signer = await signingKey();
    await append(itx, {
      type: TRUST_CONFIGURED,
      payload: { keys: [signer.keyId], minimumLevel: 2 },
      idempotencyKey: `trust-${crypto.randomUUID()}`,
    });
    const policy = {
      type: POLICY_CONFIGURED,
      payload: { approval: "required" as const, expiresInMs: 60_000 },
      idempotencyKey: `policy-${crypto.randomUUID()}`,
    };
    await append(itx, { ...policy, provenance: await signer.sign(projectId, policy) });

    const wrongOrigin = await itx.fetch(
      new Request("https://docs--v4-demo.iterate2.app/published-proof", {
        headers: { authorization: `{{secret:${SECRET_NAME}}}` },
      }),
    );
    expect(wrongOrigin.status).toBe(403);
    expect(await wrongOrigin.json()).toEqual({ code: "SECRET_ORIGIN" });

    const held = await itx.fetch(upstream());
    expect(held.status).toBe(202);
    const gate = (await held.json()) as Gate;
    expect(gate.code).toBe("APPROVAL_REQUIRED");
    const decision = {
      type: APPROVAL_DECIDED,
      payload: { requestId: gate.requestId, fingerprint: gate.fingerprint, allow: true },
      idempotencyKey: `approve-${crypto.randomUUID()}`,
    };
    await append(itx, { ...decision, provenance: await signer.sign(projectId, decision) });

    const released = await itx.fetch(upstream(gate.requestId));
    expect(released.status, await released.clone().text()).toBe(200);
    expect(await released.text()).toContain("# V4 preview proof");

    const replay = await itx.fetch(upstream(gate.requestId));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ code: "APPROVAL_USED" });

    const audit = await readAll(itx);
    expect(audit.filter((event) => event.type === "itx.system.egress.released")).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(secretMaterial);
    expect(JSON.stringify(await itx.secrets.list())).not.toContain(secretMaterial);
    expect(JSON.stringify(await itx.approvals.pending())).not.toContain(secretMaterial);
  },
  60_000,
);
