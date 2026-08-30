// wave2-sweep.failing.test.ts — BUG-HUNT WAVE 2, unit lane: the wave-1 DEFECT SHAPES hunted in
// the files wave 1 didn't reach (worker-loader cacheKey composition, the capability table's
// ARRAY-path door, ProcessorFacet identity durability, shared egress).
//
// Every test asserts CORRECT behavior. `test.fails(...)` marks a case VERIFIED failing by
// running this file (each body opens with BUG/EXPECTED/ACTUAL/WHY IT MATTERS + its SHAPE).
// Plain `test(...)` cases pass and pin behavior that is already correct. `test.todo` names
// suspected defects this lane cannot verify (and why). No production code is touched.
//
// Shapes (wave-1 taxonomy): S1 success-returned-but-state-silently-dropped · S2 silent-catch
// amplifiers · S3 CAS/delete + composition races · S4 error-signal conflation · S5 divergent
// duplicated logic · S6 unguarded destructures · S7 fabricated proofs.

import { expect, test, vi } from "vitest";

// ProcessorFacet extends DurableObject from "cloudflare:workers", which node cannot resolve —
// mock JUST the base class (a ctx/env-stashing shell, exactly what the real base provides to
// this subclass) so the facet's OWN logic runs unmodified.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { substituteHeaderSecrets } from "@v3/shared/egress";
import { confinedWorker, facetLoaderOwner } from "./core/worker-loader.ts";
import { DurableObjectNameCodec } from "./core/durable-object-names.ts";
import { type Expression } from "./core/expression.ts";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
} from "./core/events.ts";
import { CapabilityTableProcessor } from "./capability-table-processor.ts";
import { ProcessorFacet } from "./processor-facet.ts";
import type { ProcessorStream } from "./core/processor.ts";

// ═══════════════ 1. confinedWorker cacheKey — ":"-joined owner composition (S3) ═══════════════

test("two DIFFERENT facet identities never share one Worker Loader cacheKey (facetLoaderOwner)", () => {
  // FIXED (was S3, composition collision): confinedWorker mints
  // `${kind}:${deploy}:${owner}:${contentHash}`, and the owner used to be `${contextName}:${disc}`
  // with NO escaping — a context PATH may contain ":" (the edge accepts any `?ctx=`;
  // DurableObjectNameCodec never rejects ":") and a className is arbitrary (ES2022 allows
  // `export { X as "y:Door" }`). So context "/x:y"+class "Door" and context "/x"+class "y:Door"
  // composed the IDENTICAL owner "prj_u.iterate/x:y:Door" → the SAME loader cacheKey → the second
  // caller REUSES the first's isolate (its env.ITX/globalOutbound), i.e. silent cross-context
  // authority transfer (the loader cacheKey IS an authority boundary — the isolate's whole world
  // is the host stub baked in at first materialization).
  // FIX: `facetLoaderOwner` LENGTH-PREFIXES the context so the (context, discriminator) split is
  // unambiguous regardless of ":" in either half. The two identities below now mint DISTINCT keys.
  const keys: string[] = [];
  const env = {
    LOADER: { get: (key: string) => (keys.push(key), {}) },
    CF_VERSION_METADATA: { id: "deploy-1" },
  } as unknown as Parameters<typeof confinedWorker>[0];
  const host = {} as Parameters<typeof confinedWorker>[4];
  const modules = { "cap.js": "export default class Door {}" };
  // The same shared source (a template both contexts load) — identical contentHash, as in prod.
  const contentHash = "1abc2d";

  const contextA = DurableObjectNameCodec.stringify({ projectId: "prj_u", path: "/x:y" });
  confinedWorker(
    env,
    { kind: "facet", owner: facetLoaderOwner(contextA, "Door"), contentHash },
    "cap.js",
    modules,
    host,
  );
  const contextB = DurableObjectNameCodec.stringify({ projectId: "prj_u", path: "/x" });
  confinedWorker(
    env,
    { kind: "facet", owner: facetLoaderOwner(contextB, "y:Door"), contentHash },
    "cap.js",
    modules,
    host,
  );
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(2); // distinct — the length-prefix makes the split unambiguous
});

// ═══════════════ 2. provide() ARRAY-path door — success returned, mount dropped (S1) ═══════════════

// memoryStream + wiring copied from capability-table-processor.failing.test.ts (per the brief:
// helpers are copied, not imported).
function memoryStream(path = "/") {
  const events: StreamEvent[] = [];
  const byKey = new Map<string, StreamEvent>();
  const stream: ProcessorStream = {
    append: (...inputs: StreamEventInput[]) =>
      inputs.map((input) => {
        if (input.idempotencyKey) {
          const existing = byKey.get(input.idempotencyKey);
          if (existing) {
            if (sameIdempotentEvent(existing, input)) return existing;
            throw new Error(idempotencyConflictMessage(input.idempotencyKey, existing.offset));
          }
        }
        const event: StreamEvent = {
          ...input,
          offset: events.length + 1,
          createdAt: new Date(0).toISOString(),
          path,
        };
        events.push(event);
        if (input.idempotencyKey) byKey.set(input.idempotencyKey, event);
        return event;
      }),
    read: (afterOffset = 0, limit = 500) => {
      const page = events.filter((e) => e.offset > afterOffset).slice(0, limit);
      return Promise.resolve({
        events: page,
        scannedThroughOffset:
          page.length === limit
            ? page[page.length - 1].offset
            : Math.max(afterOffset, events.length),
      });
    },
  };
  return { stream, events };
}

const setupTable = () => {
  const { stream, events } = memoryStream();
  // whoami is a KEY in builtIns → `itx.whoami` resolves DIRECTLY (built-ins first); no config.
  const builtIns = { whoami: () => ({ projectId: "prj_t", path: "/" }) };
  const reduceAll = () =>
    events.reduce(
      (st, e) => host.reduce({ event: e, state: st }) ?? st,
      host.contract.initialState(),
    );
  const host: CapabilityTableProcessor = new CapabilityTableProcessor({
    stream,
    builtIns: builtIns as unknown as Record<string, unknown>,
    resolveCurrent: (call: Expression, depth = 0) =>
      host.resolve(reduceAll(), call, undefined, depth),
  });
  return { host };
};

test("a mount provided with a mis-segmented ARRAY path is REJECTED at the door (never success + silent drop)", async () => {
  // FIXED (was S1, the path-side twin of wave-1 defect 5): provide() took the ARRAY path half
  //   VERBATIM, stored `path.join(".")`, and reduce re-parsed it — a segment like "a b" made the
  //   stored string unparseable, so reduce SKIPPED the mount (warn only) while the caller held a
  //   providedAtOffset receipt for nothing. provide() now round-trips the stored path element-wise
  //   at the door (parseCapabilityPath length + segments), so a mis-segmented array THROWS instead
  //   of returning a success for a capability that never enters the table.
  const { host } = setupTable();
  // "a b" (a space) makes "itx.a b" unparseable; ["itx.kv"] re-splits to two — both fail the gate.
  await expect(host.provide({ path: ["itx", "a b"], target: "itx.whoami" })).rejects.toThrow(
    /round-trip/,
  );
  await expect(host.provide({ path: ["itx.kv"], target: "itx.whoami" })).rejects.toThrow(
    /round-trip/,
  );
});

// ═══════════════ 3. ProcessorFacet — configure() while warm serves the STALE identity (S1) ═══════════════

const makeFacetHarness = () => {
  const kv = new Map<string, unknown>();
  const parent = {
    append: (...evts: unknown[]) =>
      evts.map((e, i) => ({ ...(e as object), offset: i + 1, createdAt: "", path: "/" })),
    read: (after = 0, _limit = 500) => Promise.resolve({ events: [], scannedThroughOffset: after }),
    deliverToSubscriptionMount: () => Promise.resolve(undefined),
    armSubscriptionRetry: () => Promise.resolve({ ok: true as const }),
  };
  const ctx = {
    storage: {
      kv: {
        get: (k: string) => kv.get(k),
        put: (k: string, v: unknown) => void kv.set(k, v),
        delete: (k: string) => void kv.delete(k),
      },
    },
  };
  const env = { CONTEXT: { getByName: () => parent } };
  // The mocked DurableObject base stashes (ctx, env) exactly like the real one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { facet: new (ProcessorFacet as any)(ctx, env), kv };
};

test("FIXED (defect 45): re-configure of a WARM facet takes effect — the next call serves the NEW identity/props", async () => {
  // BUG: ProcessorFacet.configure() writes the identity durably (kv "identity") but never
  //      clears the memoized `#processor` — #p() returns the instance built from the OLD
  //      identity for as long as the facet stays warm (processor-facet.ts configure()/#p()).
  // EXPECTED: configure() is the ONE identity door ("re-enabling with different props SHADOWS
  //      the old configuration" — the contract on FacetIdentity.props and ProcessorPolicy.props);
  //      after it returns ok, the facet serves the new identity.
  // ACTUAL: the warm instance keeps serving the OLD slug/props until the facet is aborted
  //      (quiesce ≥60s away — and NEVER under continuous traffic, which keeps refreshing the
  //      quiet period). Observable here by slug: configured tally → snapshot warms the instance
  //      → re-configured subscription-forwarder → pumpSubscriptionDeliveries still finds tally:
  //      `processor "tally" has no pumpSubscriptionDeliveries()`.
  // WHY IT MATTERS (SHAPE S1, with the enableProcessor door as the amplifier): the parent's
  //      enableProcessor(slug, ref, props) → provide + configure returns {ok: true} while the
  //      running processor keeps the STALE props (the identical memoization lives in the
  //      userspace runner too, and versionedFacet only restarts on CONTENT change — a props-only
  //      re-enable restarts nothing). The event log says the new config is enabled; the facet
  //      disagrees, silently, indefinitely under load.
  const { facet } = makeFacetHarness();
  const base = { parentName: "prj_u.iterate/", projectId: "prj_u", path: "/" };
  expect(facet.configure({ ...base, slug: "tally" })).toEqual({ ok: true });
  await facet.snapshot(); // warms #processor under the tally identity
  expect(
    facet.configure({ ...base, slug: "subscription-forwarder", props: { hint: "new" } }),
  ).toEqual({ ok: true });
  const pumped = await facet.pumpSubscriptionDeliveries();
  expect(pumped).toEqual({ ok: true }); // ← throws: processor "tally" has no pumpSubscriptionDeliveries()
});

test("a COLD facet (fresh incarnation) picks up the last-configured identity", async () => {
  // The durable half works: a facet rebuilt after abort reads the newest identity from kv. The
  // defect above is ONLY the warm-instance memo.
  const { facet, kv } = makeFacetHarness();
  const base = { parentName: "prj_u.iterate/", projectId: "prj_u", path: "/" };
  facet.configure({ ...base, slug: "subscription-forwarder" });
  expect(await facet.pumpSubscriptionDeliveries()).toEqual({ ok: true });
  expect((kv.get("identity") as { slug: string }).slug).toBe("subscription-forwarder");
});

// ═══════════════ 4. shared egress — substitution arithmetic pins (correct today) ═══════════════

test("egress: resolved, missing, and other-scope tokens in ONE header substitute exactly the resolvable one", async () => {
  // Pins the splice arithmetic: an unresolved token BETWEEN two resolved ones must survive with
  // the surrounding substitutions intact (the `last` cursor must not swallow or duplicate text).
  const request = new Request("https://api.example.com/", {
    headers: {
      authorization:
        "A={{secret:project:a}} M={{secret:project:missing}} B={{secret:project:b}} P={{secret:platform:infra}}",
    },
  });
  const out = await substituteHeaderSecrets(request, "project", (name) =>
    name === "a" ? "alpha" : name === "b" ? "bravo" : null,
  );
  expect(out.headers.get("authorization")).toBe(
    "A=alpha M={{secret:project:missing}} B=bravo P={{secret:platform:infra}}",
  );
  expect(out).not.toBe(request); // something changed → a NEW request
});

test("egress: a header with only foreign/unresolvable tokens returns the ORIGINAL request untouched", async () => {
  const request = new Request("https://api.example.com/", {
    headers: { "x-auth": "{{secret:platform:infra}} {{secret:project:absent}}" },
  });
  const out = await substituteHeaderSecrets(request, "project", () => null);
  expect(out).toBe(request); // unchanged → same object (no needless Request rebuild)
  expect(out.headers.get("x-auth")).toBe("{{secret:platform:infra}} {{secret:project:absent}}");
});

test("egress: substitution never rescans substituted VALUES (no token injection through a secret)", async () => {
  const request = new Request("https://api.example.com/", {
    headers: { "x-auth": "{{secret:project:outer}}" },
  });
  const out = await substituteHeaderSecrets(request, "project", (name) =>
    name === "outer" ? "{{secret:project:inner}}" : "INNER-LEAKED",
  );
  expect(out.headers.get("x-auth")).toBe("{{secret:project:inner}}"); // literal, not re-resolved
});

// ═══════════════ 5. suspected, not verifiable in this lane ═══════════════

test.todo(
  "S4 — egress terminal conflates 'not my scope' with 'missing secret': a {{secret:project:X}} " +
    "with NO stored X is left intact by design (@v3/shared/egress) and the DO's egress terminal " +
    "(stream-durable-object.ts fetch) forwards the literal placeholder to the external " +
    "destination — leaking the secret's name and sending a garbage credential instead of failing " +
    "loudly (no project-scope door exists below this one). Unverifiable here: the only harness " +
    "route into the egress terminal is /cap WITHOUT ?cap, which self-loops the worker via " +
    "DummyControlPlane's global fetch; the loaded-worker globalOutbound route is dead under " +
    "createTestHarness (DEFECTS.md defect 28).",
);

test.todo(
  "S3/S1 — the stateful cacheKey collision END-TO-END (context '/x:y' + class Door vs context " +
    "'/x' + class 'y:Door' sharing one isolate and therefore ONE env.ITX): needs the Worker " +
    "Loader, dead under createTestHarness (DEFECTS.md defect 28). The composition half is " +
    "verified pure-functionally above.",
);

test.todo(
  "S1 — USERSPACE processor props-refresh end-to-end: versionedFacet keys restart on CONTENT " +
    "hash only (worker-loader.ts), so re-enabling a loader-hosted processor with new props " +
    "restarts nothing and the runner's memoized instance keeps the old props (the built-in " +
    "twin is verified above). Needs the Worker Loader — DEFECTS.md defect 28.",
);
