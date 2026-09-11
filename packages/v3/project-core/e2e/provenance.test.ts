import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EventRecord } from "../src/types.ts";
import type { PublicEvent } from "./support.ts";
import {
  api,
  base,
  call,
  crypto,
  keyId,
  keyPair,
  project,
  setting,
  sign,
  timeout,
  type Jwk,
} from "./support.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Input = PublicEvent<Json>;

function event(
  id: string,
  data: Json,
  provenance?: Omit<NonNullable<Input["provenance"]>, "signatures">,
): Input {
  return {
    id,
    type: "note",
    data,
    ...(provenance && { provenance: { ...provenance, signatures: [] } }),
  };
}

async function append(
  projectId: string,
  path: string,
  input: Input | Input[],
  expectedStatus = 200,
) {
  return (await call(projectId, ["append"], [input], expectedStatus, path)) as EventRecord[];
}

async function trust(projectId: string, keys: Jwk[], minLevel: 0 | 1 | 2, minSigners = 1) {
  return await append(
    projectId,
    "/",
    setting("trust", "trust", { keys: await Promise.all(keys.map(keyId)), minLevel, minSigners }),
  );
}

async function assertDenied(projectId: string, path: string, input: Input) {
  const response = await api(projectId, ["append"], [input], path);
  assert.notEqual(response.status, 200, response.text);
  assert.ok((response.body as { error?: unknown }).error, response.text);
}

describe(
  "project core provenance envelope",
  { concurrency: false, skip: !base && "set WORKER_BASE_URL to a deployed Worker" },
  () => {
    test("records unsigned events at verification level 0", { timeout }, async () => {
      const records = await append(project(), "/", event("unsigned", { message: "bootstrap" }));
      assert.deepEqual(records[0]?.verification, { level: 0, policyOffset: 0, signers: [] });
    });

    test("records a valid unknown signer at verification level 1", { timeout }, async () => {
      const id = project();
      const pair = await keyPair();
      const input = event("untrusted", { message: "signed" });
      input.provenance = { parents: [], signatures: [await sign(`${id}/`, input, pair)] };
      const [record] = await append(id, "/", input);
      assert.equal(record?.verification.level, 1);
      assert.deepEqual(
        record?.verification.signers.map((signer) => signer.trusted),
        [false],
      );
    });

    test("records a configured signer at verification level 2", { timeout }, async () => {
      const id = project();
      const pair = await keyPair();
      const key = await crypto.subtle.exportKey("jwk", pair.publicKey);
      await trust(id, [key], 0);
      const input = event("trusted", { message: "signed" });
      input.provenance = { parents: [], signatures: [await sign(`${id}/`, input, pair)] };
      const [record] = await append(id, "/", input);
      assert.equal(record?.verification.level, 2);
      assert.deepEqual(
        record?.verification.signers.map((signer) => signer.trusted),
        [true],
      );
      assert.equal(record?.verification.policyOffset, 1);
    });

    test("requires two distinct trusted keys when policy requires two", { timeout }, async () => {
      const id = project();
      const alice = await keyPair();
      const bob = await keyPair();
      const aliceKey = await crypto.subtle.exportKey("jwk", alice.publicKey);
      const bobKey = await crypto.subtle.exportKey("jwk", bob.publicKey);
      await trust(id, [aliceKey, bobKey], 2, 2);
      const input = event(
        "two-keys",
        { amount: 25_000 },
        { parents: ["request-91"], producer: "payroll" },
      );
      input.provenance = {
        ...input.provenance!,
        signatures: [await sign(`${id}/`, input, alice)],
      };
      await assertDenied(id, "/", input);
      input.provenance = {
        ...input.provenance,
        signatures: [await sign(`${id}/`, input, alice), await sign(`${id}/`, input, bob)],
      };
      const [record] = await append(id, "/", input);
      assert.equal(record?.verification.level, 2);
      assert.equal(record?.verification.signers.filter((signer) => signer.trusted).length, 2);
    });

    test("rejects duplicate signer keys", { timeout }, async () => {
      const id = project();
      const pair = await keyPair();
      const input = event("duplicate", { message: "one key twice" });
      const signature = await sign(`${id}/`, input, pair);
      input.provenance = { parents: [], signatures: [signature, signature] };
      await assertDenied(id, "/", input);
    });

    test(
      "rotates trust within a batch without rewriting history or partially committing",
      { timeout },
      async () => {
        const id = project();
        const alice = await keyPair();
        const bob = await keyPair();
        const aliceKey = await crypto.subtle.exportKey("jwk", alice.publicKey);
        const bobKey = await crypto.subtle.exportKey("jwk", bob.publicKey);
        const [bootstrap] = await trust(id, [aliceKey], 2);
        const rotation: Input = setting("rotation", "trust", {
          keys: [await keyId(bobKey)],
          minLevel: 2,
        });
        rotation.provenance = { parents: [], signatures: [await sign(`${id}/`, rotation, alice)] };
        const note = event("after-rotation", { message: "Bob now holds the pen" });
        note.provenance = { parents: [], signatures: [await sign(`${id}/`, note, alice)] };
        const rejected = (await call(id, ["append"], [[rotation, note]], 403)) as { code: string };
        assert.equal(rejected.code, "SIGNATURE_REQUIRED");
        const unchanged = (await call(id, ["readEvents"], [{}])) as { events: EventRecord[] };
        assert.deepEqual(unchanged.events, [bootstrap]);
        note.provenance.signatures = [await sign(`${id}/`, note, bob)];
        const accepted = await append(id, "/", [rotation, note]);
        assert.equal(accepted[0]?.offset, 2);
        assert.equal(accepted[1]?.offset, 3);
        assert.equal(accepted[0]?.verification.level, 2);
        assert.equal(accepted[1]?.verification.level, 2);
        assert.equal(accepted[0]?.verification.policyOffset, 1);
        assert.equal(accepted[1]?.verification.policyOffset, 2);
        assert.deepEqual(
          await append(id, "/", rotation),
          [accepted[0]],
          "retry must preserve old policy evidence",
        );
        await trust(id, [aliceKey], 2); // retrying bootstrap must not restore Alice's authority
        const stale = event("stale-authority", null);
        stale.provenance = { parents: [], signatures: [await sign(`${id}/`, stale, alice)] };
        await append(id, "/", stale, 403);
        await append(
          id,
          "/",
          { ...rotation, id: "unsigned-downgrade", provenance: undefined },
          403,
        );
        const replay = (await call(id, ["readEvents"], [{}])) as { events: EventRecord[] };
        assert.deepEqual(replay.events, [bootstrap, ...accepted]);
      },
    );

    test(
      "rejects a signature whose signed data, parents, producer, or bytes change",
      { timeout },
      async () => {
        const id = project();
        const pair = await keyPair();
        const original = event(
          "bound",
          { value: "original" },
          { parents: ["parent-a"], producer: "agent-a" },
        );
        const signature = await sign(`${id}/`, original, pair);
        for (const altered of [
          { ...original, data: { value: "tampered" } },
          event("bound", original.data, { parents: ["parent-b"], producer: "agent-a" }),
          event("bound", original.data, { parents: ["parent-a"], producer: "agent-b" }),
        ]) {
          altered.provenance = { ...altered.provenance!, signatures: [signature] };
          await assertDenied(id, "/", altered);
        }
        const signatureChanged = { ...original };
        signatureChanged.provenance = {
          ...signatureChanged.provenance!,
          signatures: [
            {
              ...signature,
              value: `${signature.value[0] === "A" ? "B" : "A"}${signature.value.slice(1)}`,
            },
          ],
        };
        await assertDenied(id, "/", signatureChanged);
      },
    );

    test("denies cross-context signature replay", { timeout }, async () => {
      const id = project();
      const pair = await keyPair();
      const input = event("context-bound", { message: "only source" });
      input.provenance = { parents: [], signatures: [await sign(`${id}/source`, input, pair)] };
      await append(id, "/source", input);
      await assertDenied(id, "/target", input);
    });

    test("does not treat a different signature as an idempotent retry", { timeout }, async () => {
      const id = project();
      const alice = await keyPair();
      const bob = await keyPair();
      const input = event("same-id", { message: "immutable envelope" });
      input.provenance = { parents: [], signatures: [await sign(`${id}/`, input, alice)] };
      await append(id, "/", input);
      input.provenance = { ...input.provenance, signatures: [await sign(`${id}/`, input, bob)] };
      const response = (await call(id, ["append"], [input], 409)) as { code: string };
      assert.equal(response.code, "ID_CONFLICT");
    });

    test("rejects caller-supplied platform metadata", { timeout }, async () => {
      const response = (await call(
        project(),
        ["append"],
        [
          {
            ...event("forged", { message: "no" }),
            context: "forged",
            offset: 999,
            time: 0,
            verification: { level: 2, policyOffset: 0, signers: [] },
          },
        ],
        400,
      )) as { code: string };
      assert.equal(response.code, "VALIDATION");
    });
  },
);
