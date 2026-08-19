// wave2-sweep.failing.test.ts — BUG-HUNT WAVE 2, unit lane: the wave-1 DEFECT SHAPES hunted in
// the files wave 1 didn't reach (agent-runtime cacheKey composition, config parsing, the
// capability table's ARRAY-path door, ProcessorFacet identity durability, shared egress).
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
import { confinedWorker } from "./core/agent-runtime.ts";
import { parseAppConfig } from "./core/config.ts";
import { DurableObjectNameCodec } from "./core/durable-object-names.ts";
import { parse, parseCapabilityPath, type Expression } from "./core/expression.ts";
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

test.fails("two DIFFERENT stateful-worker identities never share one Worker Loader cacheKey", () => {
  // BUG: confinedWorker mints `${kind}:${deploy}:${owner}:${contentHash}` and the stream DO
  //      composes the stateful owner as `${contextName}:${className}` (stream-durable-object.ts
  //      #statefulFacet) with NO escaping — but a context PATH may contain ":" (the edge accepts
  //      any `?ctx=`; DurableObjectNameCodec never rejects ":") and a className is an arbitrary
  //      string (ES2022 allows `export { X as "y:Door" }`, and nothing validates it before the
  //      lookup). So context "/x:y" + class "Door" and context "/x" + class "y:Door" compose the
  //      IDENTICAL owner string "prj_u.iterate/x:y:Door".
  // EXPECTED: distinct (context, className) identities mint distinct loader cacheKeys — the
  //      cacheKey doc block calls this "the one audit point" for identity.
  // ACTUAL: both calls pass the SAME key to LOADER.get. Whoever calls second REUSES the first
  //      caller's isolate — including its env.ITX/globalOutbound, which are minted for the FIRST
  //      context (itxEntrypointFor(ctx, contextNameA)). The second context's stateful worker then
  //      appends/reads/egresses AS THE OTHER CONTEXT.
  // WHY IT MATTERS (SHAPE S3, composition collision — same family as the prefixed-kv door): the
  //      loader cacheKey IS an authority boundary (the isolate's whole world is the host stub
  //      baked in at first materialization). A collision is silent cross-context authority
  //      transfer, not just a billing artifact. (kind "code"/"procfacet" decompose uniquely today
  //      because hash and slug are colon-free — the stateful lane is the open door; one
  //      delimiter-escape or length-prefix in the owner seam closes the family.)
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
    { kind: "stateful", owner: `${contextA}:Door`, contentHash },
    "cap.js",
    modules,
    host,
  );
  const contextB = DurableObjectNameCodec.stringify({ projectId: "prj_u", path: "/x" });
  confinedWorker(
    env,
    { kind: "stateful", owner: `${contextB}:y:Door`, contentHash },
    "cap.js",
    modules,
    host,
  );
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(2); // ← both are "stateful:deploy-1:prj_u.iterate/x:y:Door:1abc2d"
});

// ═══════════════ 2. parseAppConfig — the ARRAY path branch is a fabricated proof (S7) ═══════════════

test.fails("a config mount whose ARRAY path smuggles a dot fails loudly at boot", () => {
  // BUG: core/config.ts CapabilityPathInput pipes the array branch through
  //      `z.custom<CapabilityPath>(() => true)` — a validator that validates NOTHING. The string
  //      branch goes through parseCapabilityPath (segments are identifier-checked); the array
  //      branch accepts any string[] verbatim.
  // EXPECTED: parseAppConfig fail-louds on a mis-segmented path — its own docstring: "fail-loud
  //      on malformed config — a typo must not boot a mis-wired project". `["itx.kv"]` is the
  //      canonical typo: the author meant the 2-segment path "itx.kv" but produced ONE segment
  //      "itx.kv", which can never match any call (match() compares call[0]==="itx" against the
  //      segment "itx.kv") — the mount boots silently dead.
  // ACTUAL: parseAppConfig returns the config with the dead mount; the same spelling in the
  //      STRING half means something different (S5 inside S7: two input halves, two grammars).
  //      The empty array [] is worse — it matches EVERY call at rank 0, a stealth default route.
  // WHY IT MATTERS (SHAPE S7): the config is the project's whole topology; a "validated" config
  //      whose validation is `() => true` is a fabricated proof at the boot gate the docstring
  //      promises is loud.
  expect(() =>
    parseAppConfig(JSON.stringify({ configMounts: [{ path: ["itx.kv"], target: "kv" }] })),
  ).toThrow();
});

// ═══════════════ 3. provide() ARRAY-path door — success returned, mount dropped (S1) ═══════════════

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
  const builtIns = { whoami: () => ({ projectId: "prj_t", path: "/" }) };
  const host = new CapabilityTableProcessor({
    stream,
    builtIns: builtIns as unknown as Record<string, unknown>,
    configMounts: [{ path: parseCapabilityPath("itx.whoami"), target: parse("whoami") }],
  });
  const reduceAll = () =>
    events.reduce(
      (st, e) => host.reduce({ event: e, state: st }) ?? st,
      host.contract.initialState(),
    );
  host.resolveCurrent = async (call: Expression, depth = 0) =>
    host.resolve(reduceAll(), call, undefined, depth);
  return { host };
};

test.fails("a mount provided with an ARRAY path routes — or provide() must reject it (never both fail silently)", async () => {
  // BUG: provide() validates the STRING path half (parseCapabilityPath) but takes the ARRAY
  //      half VERBATIM (`typeof input.path === "string" ? parseCapabilityPath(...) : input.path`,
  //      capability-table-processor.ts provide()). The event stores `path.join(".")`; reduce
  //      re-parses that string with parseCapabilityPath — a segment like "a b" makes the stored
  //      string unparseable, reduce SKIPS the mount as malformed (warn only), and the
  //      providedAtOffset already handed back is a receipt for nothing.
  // EXPECTED: either the mount lands and routes (the call below is spellable — the dotted door's
  //      own split produces exactly these segments: invokeCapability("itx.a b") →
  //      ["itx", ["a b"]]), or provide() throws at the door. Never success + silent drop.
  // ACTUAL: providedAtOffset > 0 comes back; the resolve default-denies NO_CAPABILITY_MATCH.
  // WHY IT MATTERS (SHAPE S1 — the path-side twin of wave-1 defect 5, NOT fixed by its
  //      target-side round-trip fix): provideCapability({path: string[]}) is the public client
  //      surface (itx-surface.ts Itx.provide / DO.provideCapability both forward arrays). One
  //      exotic segment silently un-mounts the capability while the caller holds a success.
  const { host } = setupTable();
  const { providedAtOffset } = await host.provide({
    path: ["itx", "a b"],
    target: "itx.whoami",
  });
  expect(providedAtOffset).toBeGreaterThan(0); // the receipt (this passes — the lie half)
  expect(await host.resolveCurrent(["itx", ["a b"]] as Expression)).toEqual({
    projectId: "prj_t",
    path: "/",
  }); // ← rejects: NO_CAPABILITY_MATCH — the mount never entered the table
});

// ═══════════════ 4. ProcessorFacet — configure() while warm serves the STALE identity (S1) ═══════════════

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

// ═══════════════ 5. shared egress — substitution arithmetic pins (correct today) ═══════════════

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

// ═══════════════ 6. suspected, not verifiable in this lane ═══════════════

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
    "hash only (agent-runtime.ts), so re-enabling a loader-hosted processor with new props " +
    "restarts nothing and the runner's memoized instance keeps the old props (the built-in " +
    "twin is verified above). Needs the Worker Loader — DEFECTS.md defect 28.",
);
