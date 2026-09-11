// Optional provenance is independently verifiable evidence, not caller-asserted trust. This
// exercises the public append/read seam: legacy envelopes remain unchanged; a durable event can
// carry two distinct Ed25519 proofs bound to this exact { projectId, path, semantic event }.

import { expect, test } from "vitest";
import { provenanceMessage } from "../src/provenance.ts";
import { append, freshCtx, openItx, readAll, rejection } from "./support/client.ts";

const encode = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");

async function evidence(message: string) {
  const signer = await signingKey();
  return signer.sign(message);
}

async function signingKey() {
  const key = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = encode((await crypto.subtle.exportKey("raw", key.publicKey)) as ArrayBuffer);
  return {
    keyId: `ed25519:${publicKey}`,
    async sign(message: string) {
      return {
        algorithm: "Ed25519" as const,
        publicKey,
        signature: encode(
          await crypto.subtle.sign("Ed25519", key.privateKey, new TextEncoder().encode(message)),
        ),
      };
    },
  };
}

async function signed(
  projectId: string,
  path: string,
  event: Record<string, unknown>,
  signer: Awaited<ReturnType<typeof signingKey>>,
) {
  return {
    ...event,
    provenance: {
      signatures: [await signer.sign(provenanceMessage(event, { projectId, path }))],
    },
  };
}

test("append verifies plural provenance evidence without changing the legacy envelope", async () => {
  const projectId = freshCtx("provenance");
  const itx = openItx(projectId).cd("/signed");
  const legacy = { type: "note", payload: { text: "old shape" }, idempotencyKey: "legacy" };
  await append(itx, legacy);

  const event = { type: "note", payload: { text: "signed" }, idempotencyKey: "signed" };
  // Canonical UTF-8 message for this worked example. `source` is deliberately absent: processor
  // attribution is not cryptographic provenance, and provenance never signs itself.
  const message = `{"event":{"idempotencyKey":"signed","payload":{"text":"signed"},"type":"note"},"path":"/signed","projectId":"${projectId}","v":1}`;
  const signatures = await Promise.all([evidence(message), evidence(message)]);
  const [committed] = await append(itx, {
    ...event,
    provenance: { signatures },
  });

  expect(committed.provenance).toEqual({ signatures });
  expect(committed.verification).toEqual({
    signerKeyIds: signatures.map((signature) => `ed25519:${signature.publicKey}`).sort(),
    signers: signatures
      .map((signature) => ({ keyId: `ed25519:${signature.publicKey}`, trusted: false }))
      // `prepareProvenance` uses Array#sort's specified UTF-16 code-unit ordering for key IDs.
      // Do not use localeCompare here: its locale/case collation can reorder random base64url keys.
      .sort((a, b) => (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0)),
    level: 1,
    policyOffset: 0,
  });

  const records = await readAll(itx);
  const legacyRecord = records.find((record) => record.idempotencyKey === "legacy");
  expect(legacyRecord).toMatchObject(legacy);
  expect(legacyRecord).not.toHaveProperty("provenance");
  expect(legacyRecord).not.toHaveProperty("verification");
});

test("a signature binds the semantic payload and a refusal leaves no new record", async () => {
  const projectId = freshCtx("provenance-tamper");
  const itx = openItx(projectId).cd("/signed");
  const event = { type: "note", payload: { text: "signed" }, idempotencyKey: "tamper" };
  const message = `{"event":{"idempotencyKey":"tamper","payload":{"text":"signed"},"type":"note"},"path":"/signed","projectId":"${projectId}","v":1}`;
  const signatures = [await evidence(message)];
  const before = await readAll(itx);

  const error = await rejection(
    append(itx, {
      ...event,
      payload: { text: "altered after signing" },
      provenance: { signatures },
    }),
  );

  expect(error.code).toBe("PROVENANCE_INVALID");
  expect(await readAll(itx)).toEqual(before);
});

test("a signed idempotent retry returns its original verified receipt", async () => {
  const projectId = freshCtx("provenance-retry");
  const itx = openItx(projectId).cd("/signed");
  const event = { type: "note", payload: { text: "once" }, idempotencyKey: "signed-once" };
  const message = `{"event":{"idempotencyKey":"signed-once","payload":{"text":"once"},"type":"note"},"path":"/signed","projectId":"${projectId}","v":1}`;
  const provenance = { signatures: [await evidence(message)] };

  const [first] = await append(itx, { ...event, provenance });
  const recordsAfterFirst = await readAll(itx);
  const [replayed] = await append(itx, { ...event, provenance });

  expect(replayed).toEqual(first);
  expect(await readAll(itx)).toEqual(recordsAfterFirst);
});

test("a signed retry cannot replace processor attribution", async () => {
  const projectId = freshCtx("provenance-source");
  const itx = openItx(projectId).cd("/signed");
  const idempotencyKey = "same-fact";
  const first = {
    type: "note",
    source: { processor: { slug: "first", version: "1" } },
    idempotencyKey,
  };
  const firstMessage = `{"event":{"idempotencyKey":"${idempotencyKey}","source":{"processor":{"slug":"first","version":"1"}},"type":"note"},"path":"/signed","projectId":"${projectId}","v":1}`;
  await append(itx, { ...first, provenance: { signatures: [await evidence(firstMessage)] } });
  const recordsAfterFirst = await readAll(itx);

  const replacement = {
    ...first,
    source: { processor: { slug: "replacement", version: "1" } },
  };
  const replacementMessage = `{"event":{"idempotencyKey":"${idempotencyKey}","source":{"processor":{"slug":"replacement","version":"1"}},"type":"note"},"path":"/signed","projectId":"${projectId}","v":1}`;
  const error = await rejection(
    append(itx, {
      ...replacement,
      provenance: { signatures: [await evidence(replacementMessage)] },
    }),
  );

  expect(error.code).toBe("IDEMPOTENCY_CONFLICT");
  expect(await readAll(itx)).toEqual(recordsAfterFirst);
});

test("a caller cannot claim a server verification receipt", async () => {
  const projectId = freshCtx("provenance-receipt");
  const itx = openItx(projectId).cd("/signed");
  const before = await readAll(itx);

  const error = await rejection(
    append(itx, {
      type: "note",
      idempotencyKey: "forged-receipt",
      verification: { signerKeyIds: ["ed25519:not-a-verified-key"] },
    }),
  );

  expect(error.code).toBe("PROVENANCE_INVALID");
  expect(await readAll(itx)).toEqual(before);
});

test("signed evidence cannot be attached to an ephemeral event", async () => {
  const projectId = freshCtx("provenance-ephemeral");
  const itx = openItx(projectId).cd("/signed");
  const event = { type: "note", ephemeral: true };
  const message = `{"event":{"type":"note"},"path":"/signed","projectId":"${projectId}","v":1}`;
  const before = await readAll(itx);

  const error = await rejection(
    append(itx, { ...event, provenance: { signatures: [await evidence(message)] } }),
  );

  expect(error.code).toBe("PROVENANCE_INVALID");
  expect(await readAll(itx)).toEqual(before);
});

test("base64url aliases are not accepted as signer identities", async () => {
  const projectId = freshCtx("provenance-base64url");
  const itx = openItx(projectId).cd("/signed");
  const event = { type: "note", idempotencyKey: "canonical-key" };
  const message = `{"event":{"idempotencyKey":"canonical-key","type":"note"},"path":"/signed","projectId":"${projectId}","v":1}`;
  const signature = await evidence(message);
  const before = await readAll(itx);

  const error = await rejection(
    append(itx, {
      ...event,
      provenance: { signatures: [{ ...signature, publicKey: `${signature.publicKey}=` }] },
    }),
  );

  expect(error.code).toBe("PROVENANCE_INVALID");
  expect(await readAll(itx)).toEqual(before);
});

test("one key cannot count twice as plural provenance", async () => {
  const projectId = freshCtx("provenance-duplicate");
  const itx = openItx(projectId).cd("/signed");
  const event = { type: "note", idempotencyKey: "one-key-twice" };
  const message = `{"event":{"idempotencyKey":"one-key-twice","type":"note"},"path":"/signed","projectId":"${projectId}","v":1}`;
  const signature = await evidence(message);
  const before = await readAll(itx);

  const error = await rejection(
    append(itx, { ...event, provenance: { signatures: [signature, signature] } }),
  );

  expect(error.code).toBe("PROVENANCE_INVALID");
  expect(await readAll(itx)).toEqual(before);
});

test("optional trust progresses from unsigned bootstrap through atomic signed key rotation", async () => {
  const projectId = freshCtx("provenance-trust");
  const path = "/signed";
  const itx = openItx(projectId).cd(path);
  const alice = await signingKey();
  const bob = await signingKey();
  const bootstrap = {
    type: "events.iterate.com/provenance/trust-configured",
    payload: { keys: [alice.keyId], minimumLevel: 2, minimumSigners: 1 },
    idempotencyKey: "trust-alice",
  };

  const [installed] = await append(itx, bootstrap);
  expect(installed.verification).toEqual({
    signerKeyIds: [],
    signers: [],
    level: 0,
    policyOffset: 0,
  });
  const unsigned = await rejection(append(itx, { type: "note", idempotencyKey: "unsigned" }));
  expect(unsigned.code).toBe("PROVENANCE_REQUIRED");

  const rotation = await signed(
    projectId,
    path,
    {
      type: "events.iterate.com/provenance/trust-configured",
      payload: { keys: [bob.keyId], minimumLevel: 2, minimumSigners: 1 },
      idempotencyKey: "trust-bob",
    },
    alice,
  );
  const staleAlice = await signed(
    projectId,
    path,
    {
      type: "note",
      payload: { text: "Alice used to be trusted" },
      idempotencyKey: "stale-alice",
    },
    alice,
  );
  const beforeFailedBatch = await readAll(itx);
  const denied = await rejection(append(itx, rotation, staleAlice));
  expect(denied.code).toBe("PROVENANCE_REQUIRED");
  expect(await readAll(itx)).toEqual(beforeFailedBatch);

  const bobNote = await signed(
    projectId,
    path,
    {
      type: "note",
      payload: { text: "Bob holds the pen" },
      idempotencyKey: "bob-note",
    },
    bob,
  );
  const [rotated, committed] = await append(itx, rotation, bobNote);
  expect(rotated.verification).toMatchObject({ level: 2, policyOffset: installed.offset });
  expect(committed.verification).toMatchObject({
    signerKeyIds: [bob.keyId],
    level: 2,
    policyOffset: rotated.offset,
  });

  const staleAfterRotation = await rejection(append(itx, staleAlice));
  expect(staleAfterRotation.code).toBe("PROVENANCE_REQUIRED");
  expect(await append(itx, rotation)).toEqual([rotated]);
});
