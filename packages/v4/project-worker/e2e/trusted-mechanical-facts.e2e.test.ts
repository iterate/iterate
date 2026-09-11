// Internal delivery and pager-lifecycle facts remain durable when a project opts into provenance.
// The proof stays at the public ITX/RPC seam: it installs ordinary facts, then observes the row/log.

import { Buffer } from "node:buffer";
import { expect, test } from "vitest";
import { provenanceMessage } from "../src/provenance.ts";
import {
  append,
  codeOf,
  collector,
  freshCtx,
  openItx,
  presence,
  rejection,
  readAll,
  rpcStubRewriteRuleMatches,
  session,
  sleep,
  subscriptions,
  until,
} from "./support/client.ts";
import { SOURCES } from "./support/sources.ts";
import { Tools } from "./support/targets.ts";

const TRUST_CONFIGURED = "events.iterate.com/provenance/trust-configured";
const HALTED = "events.iterate.com/stream/subscription-delivery-halted";

async function signer() {
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

test("a locked context records one terminal cursor-delivery halt and does not redeliver", async () => {
  const projectId = freshCtx("trusted-halt");
  const itx = openItx(projectId);
  const alice = await signer();

  // One ordinary batch establishes both the cursor target and the trust boundary before any
  // delivery can run. The public key is intentionally generated; no signing material is retained.
  await append(
    itx,
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: {
        match: "itx.digest",
        target: `itx.workers.get({ source: ${JSON.stringify(SOURCES.digest)} })`,
      },
      idempotencyKey: "digest-target",
    },
    {
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        name: "digest",
        target: "itx.digest.processEventBatch",
        consumes: ["mark"],
      },
      idempotencyKey: "digest-subscription",
    },
    {
      type: TRUST_CONFIGURED,
      payload: { keys: [alice.keyId], minimumLevel: 1 },
      idempotencyKey: "lock-trust",
    },
  );

  const poison = {
    type: "mark",
    payload: { poison: true },
    idempotencyKey: "poison",
  };
  await append(itx, { ...poison, provenance: await alice.sign(projectId, poison) });

  const halted = await until("locked delivery halt", async () => {
    const row = await itx.subscriptions.get("digest");
    return row?.halted ? row : undefined;
  });
  expect(halted.halted).toMatchObject({ attempts: 1 });
  expect(
    (await readAll(itx)).filter(
      (event) => event.type === HALTED && event.payload?.name === "digest",
    ),
  ).toHaveLength(1);

  const later = { type: "mark", payload: { after: "halt" }, idempotencyKey: "after-halt" };
  await append(itx, { ...later, provenance: await alice.sign(projectId, later) });
  await sleep(1_200);
  expect((await itx.subscriptions.get("digest")).halted).toMatchObject({ attempts: 1 });
  expect(
    (await readAll(itx)).filter(
      (event) => event.type === HALTED && event.payload?.name === "digest",
    ),
  ).toHaveLength(1);
});

test("a locked context removes the rows named by its last closed live pager", async () => {
  const projectId = freshCtx("trusted-pager-cleanup");
  const observer = openItx(projectId);
  const provider = session();
  const provided = provider.authenticate().projects.get(projectId);
  const delivered = collector();
  const alice = await signer();

  await provided.provide("itx.live", new Tools("locked"));
  await provided.subscribe({ name: "live", target: delivered.fn, consumes: ["mark"] });
  await until("both live pagers present", async () =>
    (await presence(observer)).includes("itx.live") &&
    (await presence(observer)).includes("subscription:live")
      ? true
      : undefined,
  );

  await append(observer, {
    type: TRUST_CONFIGURED,
    payload: { keys: [alice.keyId], minimumLevel: 1 },
    idempotencyKey: "lock-trust",
  });
  provider[Symbol.dispose]();

  await until("closed pagers leave physical presence", async () =>
    !(await presence(observer)).includes("itx.live") &&
    !(await presence(observer)).includes("subscription:live")
      ? true
      : undefined,
  );
  await until("dead pager rows removed", async () =>
    !(await rpcStubRewriteRuleMatches(observer)).includes("itx.live") &&
    !(await subscriptions(observer)).some((row: { name: string }) => row.name === "live")
      ? true
      : undefined,
  );
});

test("resuming leaves a raw offline rpc-stub rule durable when no pager detached", async () => {
  const itx = openItx(freshCtx("resume-raw-offline-rule"));

  // This is an ordinary durable configuration fact, not `provide(stub)`: no pager has ever named
  // `never`, so a pause/resume lifecycle cannot infer that its offline state means a disconnect.
  await append(itx, {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.offline",
      target: "itx.builtins.rpcStubs.get('never')",
    },
  });
  expect(await rpcStubRewriteRuleMatches(itx)).toContain("itx.offline");

  await append(itx, { type: "events.iterate.com/stream/paused", payload: { reason: "test" } });
  await append(itx, { type: "events.iterate.com/stream/resumed" });

  // Give resume's post-commit work a turn. The public rule table, not a storage probe, is the
  // durable contract: this remains a deliberately offline `RPC_STUB_OFFLINE` route.
  await sleep(25);
  expect(await rpcStubRewriteRuleMatches(itx)).toContain("itx.offline");
});

test("a locked context also retains its signed raw offline rpc-stub rule across resume", async () => {
  const projectId = freshCtx("resume-signed-offline-rule");
  const itx = openItx(projectId);
  const alice = await signer();
  await append(itx, {
    type: TRUST_CONFIGURED,
    payload: { keys: [alice.keyId], minimumLevel: 1 },
  });

  const offline = {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.signedOffline",
      target: "itx.builtins.rpcStubs.get('never-signed')",
    },
  };
  await append(itx, { ...offline, provenance: await alice.sign(projectId, offline) });
  const paused = { type: "events.iterate.com/stream/paused", payload: { reason: "test" } };
  await append(itx, { ...paused, provenance: await alice.sign(projectId, paused) });
  const resumed = { type: "events.iterate.com/stream/resumed" };
  await append(itx, { ...resumed, provenance: await alice.sign(projectId, resumed) });

  await sleep(25);
  expect(await rpcStubRewriteRuleMatches(itx)).toContain("itx.signedOffline");
});

test("a paused stream cannot combine resume with a newer raw rule for a detached key", async () => {
  const projectId = freshCtx("resume-newer-raw-rule");
  const observer = openItx(projectId);
  const provider = session();
  const provided = provider.authenticate().projects.get(projectId);
  await provided.provide("itx.keyA", new Tools("a"));
  await until("key A pager attached", async () =>
    (await presence(observer)).includes("itx.keyA") ? true : undefined,
  );

  await append(observer, { type: "events.iterate.com/stream/paused", payload: { reason: "test" } });
  provider[Symbol.dispose]();
  await until("key A pager detached", async () =>
    !(await presence(observer)).includes("itx.keyA") ? true : undefined,
  );

  // Stream's public pause contract is wholesale: this otherwise tempting one-batch future fact
  // cannot land after the close and before the resume effect gets its turn.
  const error = await rejection(
    append(
      observer,
      { type: "events.iterate.com/stream/resumed" },
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: {
          match: "itx.reborn",
          target: "itx.builtins.rpcStubs.get('itx.keyA')",
        },
      },
    ),
  );
  expect(codeOf(error)).toBe("STREAM_PAUSED");
  expect(await rpcStubRewriteRuleMatches(observer)).not.toContain("itx.reborn");
});
