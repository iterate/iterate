// wave2-sweep.failing.test.ts — BUG-HUNT WAVE 2, unit lane: the wave-1 DEFECT SHAPES hunted in
// the files wave 1 didn't reach (worker-loader cacheKey composition, the capability table's
// ARRAY-path door, shared egress).
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

// (the DurableObject base from "cloudflare:workers" cannot be resolved by node —
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
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
} from "../stream/events.ts";
import type { ProcessorStream } from "../stream/processor.ts";
import { confinedWorker, facetLoaderOwner } from "./worker-loader.ts";
import { DurableObjectNameCodec } from "./durable-object-names.ts";
import { type Expression } from "./expression.ts";
import { CapabilityTableProcessor } from "./capability-table.ts";

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
    LOADER: {
      get: (key: string) => {
        keys.push(key);
        return {};
      },
    },
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
