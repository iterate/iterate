// These tests run the REAL tswasm compiler (the same wasm the typechecker
// sidecar ships) against the assembled virtual project, so "the platform
// surface compiles clean under the sidecar's lib + shims" is a tested
// invariant, not a hope. Network is stubbed: acquisitions serve from an
// in-memory fake registry. The published surface deliberately imports the
// exact Octokit type, while the resource-bounded Worker sidecar substitutes
// its structural RPC-safe entry points so unrelated scripts do not eagerly
// load that large package graph. Explicit user imports still acquire the
// pinned package; names that appear only in comments still must not fetch.
import { createCompiler } from "tswasm";
import { beforeAll, expect, test } from "vitest";
import type { CapabilityDescription } from "../itx/describe.ts";
import { openApiCapabilityTypeReference } from "../itx/capability-type-declarations.ts";
import { assemblePreamble } from "../capability-host/capability-host-preamble.ts";
import type { CompileFn } from "./run-typecheck.ts";
import { runTypecheck, npmPackagesMentioned } from "./run-typecheck.ts";
import {
  checkCapabilityTypes,
  checkItxScript,
  checkItxScriptForExecution,
  checkPreamble,
  mountModuleText,
  type Typechecker,
} from "./virtual-project.ts";

let typechecker: Typechecker;
let fetchedUrls: string[] = [];

beforeAll(async () => {
  const compiler = await createCompiler();
  typechecker = {
    check: (input) =>
      runTypecheck({
        compiler: compiler as CompileFn,
        fetchImpl: fakeRegistryFetch,
        files: input.files,
        entrypoint: input.entrypoint,
      }),
  };
});

/** A tiny in-memory jsdelivr: the platform's Octokit declaration plus the
 * `fake-pets` fixture used by npm-backed mount tests. */
async function fakeRegistryFetch(url: string): Promise<Response> {
  fetchedUrls.push(url);
  if (url.includes("/package/resolve/npm/@types/node")) {
    return Response.json({ version: "22.19.13" });
  }
  if (url.includes("/package/npm/@types/node@22.19.13/flat")) {
    return Response.json({
      default: "/index.d.ts",
      files: [
        { name: "/package.json", size: 1 },
        { name: "/index.d.ts", size: 1 },
      ],
    });
  }
  if (url.endsWith("@types/node@22.19.13/package.json")) {
    return new Response(JSON.stringify({ name: "@types/node", types: "index.d.ts" }));
  }
  if (url.endsWith("@types/node@22.19.13/index.d.ts")) {
    return new Response('declare module "node:stream" { export class Readable {} }');
  }
  if (url.includes("/package/resolve/npm/octokit")) {
    return Response.json({ version: "5.0.5" });
  }
  if (url.includes("/package/npm/octokit@5.0.5/flat")) {
    return Response.json({
      default: "/index.d.ts",
      files: [
        { name: "/package.json", size: 1 },
        { name: "/index.d.ts", size: 1 },
      ],
    });
  }
  if (url.endsWith("octokit@5.0.5/package.json")) {
    return new Response(JSON.stringify({ name: "octokit", types: "index.d.ts" }));
  }
  if (url.endsWith("octokit@5.0.5/index.d.ts")) {
    return new Response(
      [
        "export declare class Octokit {",
        "  rest: Record<string, Record<string, (...args: any[]) => Promise<any>>>;",
        "  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;",
        "  request(route: string, parameters?: Record<string, unknown>): Promise<any>;",
        "  paginate(route: string, parameters?: Record<string, unknown>): Promise<any[]>;",
        "}",
      ].join("\n"),
    );
  }
  if (url.includes("/package/resolve/npm/fake-pets")) {
    return Response.json({ version: "1.0.0" });
  }
  if (url.includes("/package/npm/fake-pets@1.0.0/flat")) {
    return Response.json({
      default: "/index.d.ts",
      files: [
        { name: "/package.json", size: 1 },
        { name: "/index.d.ts", size: 1 },
      ],
    });
  }
  if (url.endsWith("fake-pets@1.0.0/package.json")) {
    return new Response(JSON.stringify({ name: "fake-pets", types: "index.d.ts" }));
  }
  if (url.endsWith("fake-pets@1.0.0/index.d.ts")) {
    return new Response("export type PetsClient = { listPets(): Promise<string[]> };");
  }
  if (url === "https://specs.example.com/store.json") {
    return Response.json({
      openapi: "3.0.0",
      paths: {
        "/pets/{petId}": {
          get: {
            operationId: "getPet",
            parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
          },
        },
      },
    });
  }
  return new Response("not found", { status: 404 });
}

const WEATHER_MOUNT: CapabilityDescription = {
  path: ["tools", "weather"],
  type: "itx-call",
  instructions: "Three-day forecasts.",
  types: "export type Forecast = { forecast(input: { city: string }): Promise<string> };",
};

test("the platform surface compiles clean without eagerly loading Octokit's package graph", async () => {
  fetchedUrls = [];
  const problems = await checkItxScript({
    capabilities: [],
    code: `async (itx) => {
      const octokit = itx.integrations.github.get().octokit;
      const [pr, viewer] = await Promise.all([
        octokit.rest.pulls.get({ owner: "acme", repo: "widgets", pull_number: 7 }),
        octokit.graphql<{ viewer: { login: string } }>("query { viewer { login } }")
      ]);
      return { pr, viewer };
    }`,
    typechecker,
  });
  expect(problems).toEqual([]);
  expect(fetchedUrls.some((url) => url.includes("octokit"))).toBe(false);
  expect(fetchedUrls.some((url) => url.includes("@slack/web-api"))).toBe(false);
});

test("an explicit Octokit import still acquires the pinned upstream package", async () => {
  fetchedUrls = [];
  const problems = await checkCapabilityTypes({
    typechecker,
    types: 'export type GithubClient = import("octokit").Octokit;',
  });
  expect(problems).toEqual([]);
  expect(fetchedUrls.some((url) => url.includes("octokit"))).toBe(true);
});

test("a wrong call into the typed surface is a compiler error with a did-you-mean", async () => {
  const problems = await checkItxScript({
    capabilities: [],
    code: `async (itx) => {\n  return await itx.streams.gett("/");\n}`,
    typechecker,
  });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("script:2");
  expect(problems[0]).toContain("gett");
  expect(problems[0]).toContain("Did you mean 'get'");
});

test("typed mounts join the itx type; untyped mounts stay permissive", async () => {
  const capabilities: CapabilityDescription[] = [
    WEATHER_MOUNT,
    { path: ["legacy"], type: "live" }, // no types recorded → any
  ];
  const ok = await checkItxScript({
    capabilities,
    code: `async (itx) => {\n  await itx.legacy.anything(1, 2);\n  return await itx.tools.weather.forecast({ city: "Berlin" });\n}`,
    typechecker,
  });
  expect(ok).toEqual([]);

  const typo = await checkItxScript({
    capabilities,
    code: `async (itx) => itx.tools.weather.forecast({ city: 42 })`,
    typechecker,
  });
  expect(typo).toHaveLength(1);
  expect(typo[0]).toContain("number");
});

test("a mount whose path prefixes another mount keeps both types (intersection, not a tree)", async () => {
  const capabilities: CapabilityDescription[] = [
    { path: ["tools"], type: "live", types: "export type Tools = { ping(): Promise<void> };" },
    WEATHER_MOUNT, // tools.weather — nested under the mount above
  ];
  const problems = await checkItxScript({
    capabilities,
    code: `async (itx) => {\n  await itx.tools.ping();\n  return await itx.tools.weather.forecast({ city: "Berlin" });\n}`,
    typechecker,
  });
  expect(problems).toEqual([]);
});

test("mount types referencing platform declarations resolve bare", async () => {
  const problems = await checkCapabilityTypes({
    types: "export type Root = { tail(): Promise<StreamEvent[]> };",
    typechecker,
  });
  expect(problems).toEqual([]);
  expect(mountModuleText("export type Root = Stream;")).toContain(
    'import type { Stream } from "../itx-types";',
  );
  // Comments never count: a comment naming a platform type must not inject
  // an import, and one naming the declared type must not suppress it.
  expect(mountModuleText("// not really Stream\nexport type X = { n: number };")).not.toContain(
    "import",
  );
});

test("a typo'd capability types string is rejected with a compiler error", async () => {
  const problems = await checkCapabilityTypes({
    types: "export type Broken = { list(): Promise<Streem[]> };",
    typechecker,
  });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("Streem");
  expect(problems[0]).toContain("types:1"); // no injected import, no offset

  // With an injected platform import the offset is undone: the error on the
  // author's line 2 reports as line 2, not module line 3.
  const withImport = await checkCapabilityTypes({
    types: "export type Root = Stream;\nexport type Broken = Streem;",
    typechecker,
  });
  expect(withImport).toHaveLength(1);
  expect(withImport[0]).toContain("types:2");
});

test("a broken mount module surfaces in script checks instead of hiding", async () => {
  // Pre-validation-era journals can hold types that no longer compile; the
  // check must say so, labeled by the mount, not report ok.
  const problems = await checkItxScript({
    capabilities: [{ path: ["stale"], type: "live", types: "export type Stale = Goone;" }],
    code: "async (itx) => {}",
    typechecker,
  });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("mount stale");
  expect(problems[0]).toContain("Goone");
});

test("npm-backed mount types acquire real .d.ts and typecheck against them", async () => {
  const capabilities: CapabilityDescription[] = [
    {
      path: ["pets"],
      type: "itx-call",
      types: 'export type Pets = import("fake-pets").PetsClient;',
    },
  ];
  const ok = await checkItxScript({
    capabilities,
    code: "async (itx) => itx.pets.listPets()",
    typechecker,
  });
  expect(ok).toEqual([]);

  const typo = await checkItxScript({
    capabilities,
    code: "async (itx) => itx.pets.listPetz()",
    typechecker,
  });
  expect(typo).toHaveLength(1);
  expect(typo[0]).toContain("Did you mean 'listPets'");
});

test("npm specifier scan finds bare packages in code and ignores prose", () => {
  const files = {
    "mounts/slack.ts": 'export type Slack = import("@slack/web-api").WebClient;',
    "script.ts": 'import { z } from "zod/v4";\nimport "./local";\nimport fs from "node:fs";',
    "commented.ts": '/** example: import("left-pad") */\n// import "right-pad"',
    // The keywords inside ordinary string literals are prose, not imports.
    "prose.ts": `const q = "messages from 'bob' unread"; const t = \`import\`;`,
    "/node_modules/zod/index.d.ts": 'import "left-pad";', // acquired files never re-scan
  };
  expect(npmPackagesMentioned(files).sort()).toEqual(["@slack/web-api", "zod"]);
});

test("a compiler crash at provide time ALLOWS the mount — a crash is not proof the types are wrong", async () => {
  // A type-compute bomb can OOM the wasm isolate. The raw throw used to leak
  // to the provide caller; then it was surfaced as a problem — which
  // hard-rejected a mount the compiler merely failed to check. A crash is
  // "the check didn't happen", not a verdict: allow the mount (same stance as
  // the execution gate's `unchecked`). Real type errors still reject (see the
  // typo test above), so this loses nothing but the false reject.
  const crashing: Typechecker = {
    check: (input) =>
      runTypecheck({
        compiler: {
          compile: () => {
            throw new SyntaxError('"undefined" is not valid JSON');
          },
        },
        fetchImpl: () => Promise.reject(new Error("no network")),
        files: input.files,
      }),
  };
  const problems = await checkCapabilityTypes({
    types: "export type T = 1;",
    typechecker: crashing,
  });
  expect(problems).toEqual([]);
});

test("an unreachable / hung sidecar at provide time allows the mount (deadline, no hard reject)", async () => {
  const unreachable: Typechecker = {
    check: () => Promise.reject(new Error("sidecar dial failed")),
  };
  expect(
    await checkCapabilityTypes({
      types: "export type T = { x(): void };",
      typechecker: unreachable,
    }),
  ).toEqual([]);

  const hanging: Typechecker = { check: () => new Promise(() => {}) };
  expect(
    await checkCapabilityTypes({
      types: "export type T = { x(): void };",
      typechecker: hanging,
      deadlineMs: 25,
    }),
  ).toEqual([]);

  // The export-less rule is LOCAL (no compiler) — a permissive checker failure
  // must NOT let an export-less declaration slip into the journal as `any`.
  const exportLess = await checkCapabilityTypes({
    types: "export const x = 1;",
    typechecker: unreachable,
  });
  expect(exportLess).toHaveLength(1);
  expect(exportLess[0]).toContain("exports no top-level type");
});

test("a pathologically nested type is REJECTED at provide time (durable — must not wedge future checks)", async () => {
  // Unlike an ephemeral script (which the gate runs unchecked), a `types`
  // string is journaled and re-compiled by every later script check, so a
  // parser-wedging nesting must be kept out of the journal. A poisoned checker
  // proves the guard bails before tsc is ever dialed.
  const exploding: Typechecker = {
    check: () => Promise.reject(new Error("typechecker must not be dialed for deep types")),
  };
  const deep = `export type T = ${"[".repeat(1200)}number${"]".repeat(1200)};`;
  const problems = await checkCapabilityTypes({ types: deep, typechecker: exploding });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("nesting");

  // A normal declaration still reaches the real checker and compiles clean.
  expect(
    await checkCapabilityTypes({ types: "export type T = { x(): Promise<void> };", typechecker }),
  ).toEqual([]);
});

test("compiling-but-export-less types are rejected as an authoring mistake", async () => {
  for (const types of [
    "console.log(1);",
    "export const x = 1;",
    "export namespace NS { export interface Inner { x: 1 } }",
  ]) {
    const problems = await checkCapabilityTypes({ types, typechecker });
    expect(
      problems.some((p) => p.includes("exports no top-level type")),
      types,
    ).toBe(true);
  }
});

test("the checker enforces the runtime's block shape and size cap up front", async () => {
  const comment = await checkItxScript({
    capabilities: [],
    code: "// preamble\nasync (itx) => {}",
    typechecker,
  });
  expect(comment).toHaveLength(1);
  expect(comment[0]).toContain("starts with `async (`");

  // The extractor's parenthesized arrow form is accepted; its parenthesized
  // FUNCTION form is not — mirror exactly, or green pre-flights bounce.
  const wrapped = await checkItxScript({
    capabilities: [],
    code: "(async (itx) => {})",
    typechecker,
  });
  expect(wrapped).toEqual([]);
  const wrappedFunction = await checkItxScript({
    capabilities: [],
    code: "(async function (itx) {})",
    typechecker,
  });
  expect(wrappedFunction).toHaveLength(1);
  expect(wrappedFunction[0]).toContain("starts with");

  const huge = await checkItxScript({
    capabilities: [],
    code: `async (itx) => { ${"x;".repeat(150_000)} }`,
    typechecker,
  });
  expect(huge).toHaveLength(1);
  expect(huge[0]).toContain("check limit");

  const notString = await checkItxScript({
    capabilities: [],
    code: ["async (itx) => {}"] as unknown as string,
    typechecker,
  });
  expect(notString).toHaveLength(1);
  expect(notString[0]).toContain("must be a string");
});

test("npm acquisition failures surface as notes alongside the module error", async () => {
  const problems = await checkItxScript({
    capabilities: [
      { path: ["gone"], type: "itx-call", types: 'export type G = import("fake-gone").X;' },
    ],
    code: "async (itx) => itx.gone",
    typechecker, // fake registry 404s anything but fake-pets
  });
  expect(problems.some((p) => p.includes("Cannot find module"))).toBe(true);
});

test("openapi: references materialize at check time — schemas never ride the journal", async () => {
  const reference = openApiCapabilityTypeReference("https://specs.example.com/store.json");
  expect(reference.length).toBeLessThan(300); // what the journal carries

  const capabilities: CapabilityDescription[] = [
    { path: ["store"], type: "itx-call", types: reference },
  ];
  const ok = await checkItxScript({
    capabilities,
    code: "async (itx) => itx.store.getPet({ petId: 'p1' })",
    typechecker,
  });
  expect(ok).toEqual([]);

  const typo = await checkItxScript({
    capabilities,
    code: "async (itx) => itx.store.getPett({ petId: 'p1' })",
    typechecker,
  });
  expect(typo).toHaveLength(1);
  expect(typo[0]).toContain("Did you mean 'getPet'");

  // An unreachable spec degrades with a note, never a throw.
  const broken = await checkItxScript({
    capabilities: [
      {
        path: ["gone"],
        type: "itx-call",
        types: openApiCapabilityTypeReference("https://specs.example.com/missing.json"),
      },
    ],
    code: "async (itx) => itx.gone",
    typechecker,
  });
  expect(broken.some((p) => p.includes("type generation failed"))).toBe(true);
});

// ─── The execution gate: checkItxScriptForExecution ─────────────────────────
// Same compiler, different policy: only PROVABLE errors in the script's own
// code block a run. The suite below is half true-positives, half attempts to
// break the gate with scripts that run fine at runtime and must not bounce.

async function gate(code: string, capabilities: CapabilityDescription[] = []) {
  return await checkItxScriptForExecution({ capabilities, code, typechecker });
}

const GATE_ROWS: Array<{
  name: string;
  code: string;
  capabilities?: CapabilityDescription[];
  expected: "clean" | "problems" | "unchecked";
  /** Asserted against the FIRST problem — the one the runner surfaces. */
  problemContains?: string[];
}> = [
  {
    name: "a wrong call into the typed surface blocks with the caller's line numbers",
    code: `async (itx) => {\n  return await itx.streams.gett("/");\n}`,
    expected: "problems",
    problemContains: ["script:2", "Did you mean 'get'"],
  },
  {
    name: "a near-miss typo on a typed mount blocks",
    code: "async (itx) => itx.tools.weather.forecastt({ city: 'Berlin' })",
    capabilities: [WEATHER_MOUNT],
    expected: "problems",
    problemContains: ["Did you mean 'forecast'"],
  },
  {
    name: "anything else on an untyped mount runs",
    code: "async (itx) => itx.legacy.whatever(1, { deep: true })",
    capabilities: [{ path: ["legacy"], type: "live" }],
    expected: "clean",
  },
  // Only NEAR-MISS proof blocks — bare mismatches are unprovable and run.
  // The declared surface lags the runtime in places (preview e2e:
  // CloudflareSandbox.exec exists at runtime but not in types, handle results
  // declared {}), so property/argument mismatches without a did-you-mean must
  // never block. These all failed loudly in preview until this policy.
  {
    // A capability nobody declared — journal-legal via dynamic provides.
    name: "a capability nobody declared runs",
    code: "async (itx) => itx.nonexistent.doThing()",
    capabilities: [WEATHER_MOUNT],
    expected: "clean",
  },
  {
    // Types may lag runtime.
    name: "a wrong argument type into the platform surface runs",
    code: "async (itx) => itx.docs.search(42)",
    capabilities: [WEATHER_MOUNT],
    expected: "clean",
  },
  {
    name: "a wrong argument shape into a typed mount runs",
    code: "async (itx) => itx.tools.weather.forecast({ city: 42 })",
    capabilities: [WEATHER_MOUNT],
    expected: "clean",
  },
  {
    // The canonical catalogue example shape that preview e2e runs: mount a
    // capability, then call it through the itx proxy two lines later —
    // dynamic mounts are invisible to a static check.
    name: "provide-then-use in one script stays green",
    code: `async (itx) => {
      await itx.capabilityHost.provideCapability({
        type: "itx-call",
        path: ["demoStream"],
        expression: ["streams", ["get", "/"]],
      });
      return await itx.demoStream.getEvents({ afterOffset: 0, limit: 10 });
    }`,
    expected: "clean",
  },
  {
    name: "a stale BROKEN mount never vetoes a clean script",
    code: "async (itx) => itx.stale.anything()",
    capabilities: [{ path: ["stale"], type: "live", types: "export type Stale = Goone;" }],
    expected: "clean",
  },
  {
    name: "a script's OWN provable errors still block beside a stale broken mount",
    code: "async (itx) => itx.streams.gett('/')",
    capabilities: [{ path: ["stale"], type: "live", types: "export type Stale = Goone;" }],
    expected: "problems",
  },
  {
    // fake-gone 404s in the fake registry — the mount module errors AND the
    // script's own import errors are both unresolved-module class, so it
    // runs (acquisition failure ≠ proof).
    name: "unresolved modules never block",
    code: 'async (itx) => { const m = await import("fake-gone"); return m; }',
    capabilities: [
      { path: ["gone"], type: "itx-call", types: 'export type G = import("fake-gone").X;' },
    ],
    expected: "clean",
  },
  // Shapes the checker doesn't model run unchecked (raw runScript callers).
  {
    name: "a plain arrow runs unchecked — the runtime accepts it",
    code: "(itx) => itx.streams.gett('/')",
    expected: "unchecked",
  },
  {
    name: "a parenthesized async function runs unchecked",
    code: "(async function (itx) { return 1; })",
    expected: "unchecked",
  },
  {
    name: "a function declaration runs unchecked",
    code: "function f(itx) { return 1; }",
    expected: "unchecked",
  },
  {
    name: "oversized scripts run unchecked",
    code: `async (itx) => { ${"x;".repeat(150_000)} }`,
    expected: "unchecked",
  },
  {
    name: "non-string code runs unchecked",
    code: ["async (itx) => {}"] as unknown as string,
    expected: "unchecked",
  },
  // Runtime idioms that execute fine stay green.
  {
    // The runtime calls fn(itx); extras are undefined.
    name: "extra declared params stay green",
    code: "async (itx, extra, more) => itx.docs.search({ q: 'x' })",
    expected: "clean",
  },
  {
    name: "a destructured itx parameter stays green",
    code: "async ({ streams, docs }) => { await streams.get('/'); await docs.search({ q: 'x' }); }",
    expected: "clean",
  },
  {
    name: "web platform + nodejs_compat runtime globals stay green",
    code: `async (itx) => {
      const res = await fetch(new URL("https://example.com/?q=" + crypto.randomUUID()));
      const body = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
      await new Promise((resolve) => setTimeout(resolve, 10));
      console.log(structuredClone({ body: atob(btoa(body)) }), performance.now());
      return Buffer.from(process?.env?.HOME ?? "x").toString("base64");
    }`,
    expected: "clean",
  },
  {
    // The runtime's own wrapper uses `using`, so the shimmed
    // Symbol.dispose/Disposable must keep scripts with them green.
    name: "using-declarations stay green",
    code: `async (itx) => {
      const handle = { [Symbol.dispose]: () => {} };
      { using h = handle; void h; }
      return null;
    }`,
    expected: "clean",
  },
  {
    name: "async generators, for-await, Map/Set, regex, and classes stay green",
    code: `async (itx) => {
      class Acc { total = 0; add(n) { this.total += n; return this; } }
      async function* numbers() { yield 1; yield 2; }
      const acc = new Acc();
      for await (const n of numbers()) acc.add(n);
      const seen = new Map([["k", new Set([1])]]);
      return \`total=\${acc.total} \${/\\d+/.test("42")} \${seen.size}\`;
    }`,
    expected: "clean",
  },
  {
    name: "try/catch with unknown error narrowing and rethrow stays green",
    code: `async (itx) => {
      try {
        return await itx.streams.get("/");
      } catch (error) {
        throw new Error("wrapped: " + (error instanceof Error ? error.message : String(error)));
      }
    }`,
    expected: "clean",
  },
  // Provable script bugs the run would only surface at runtime DO block.
  {
    // Misspelled local with a near-miss — TS2552 names the fix.
    name: "a misspelled local with a near-miss blocks",
    code: "async (itx) => { const count = 1; return cuont + 1; }",
    expected: "problems",
  },
  {
    // Misspelled platform member with a near-miss — TS2551 names the fix.
    name: "a misspelled platform member with a near-miss blocks",
    code: "async (itx) => itx.streams.gett('/')",
    expected: "problems",
  },
  {
    // Syntax errors — the runtime's loader would reject these anyway.
    name: "a declaration syntax error blocks",
    code: "async (itx) => { const = 1; }",
    expected: "problems",
  },
  {
    name: "an unbalanced-parens syntax error blocks",
    code: "async (itx) => { return JSON.parse('{'; }",
    expected: "problems",
  },
  // Regression (#1882 follow-up): ES2024+ runtime features are not blocked
  // as syntax errors. The regex `v` flag runs in workerd; pinning target
  // es2022 reported TS1501 ("only available when targeting es2024 or
  // later") — a 1xxx code the gate blocked as if it were a parse error.
  // Matching the runtime target fixes it.
  {
    name: "regression: the regex v flag is not blocked as TS1501",
    code: "async (itx) => { const re = /[\\p{L}]/v; return re.test('x'); }",
    expected: "clean",
  },
  {
    // A sibling target-availability feature: `using` (ES2026 explicit
    // resource management) inside the async body.
    name: "regression: using-declarations are not blocked as target errors",
    code: "async (itx) => { using d = { [Symbol.dispose]() {} }; void d; }",
    expected: "clean",
  },
  // Regression: near-miss on the runtime-extensible itx root does NOT block.
  {
    // provide-then-use in one script: the mount does not exist statically,
    // and its near-miss to `agent` used to bounce it (TS2551 → blocked). The
    // root is runtime-extensible, so this must run.
    name: "regression: a provided root mount near-missing a real member runs",
    code: `async (itx) => {
    await itx.capabilityHost.provideCapability({ type: "itx-call", path: ["agentz"], expression: ["streams", ["get", "/"]] });
    return typeof itx.agentz;
  }`,
    expected: "clean",
  },
  {
    // A bare root-member typo reads identically to a dynamic provide —
    // indistinguishable statically — so it too must run (the price of a
    // runtime-extensible root; sub-member typos below stay caught).
    name: "regression: a bare root-member typo runs",
    code: "async (itx) => itx.strems.get('/')",
    expected: "clean",
  },
  // The refinement must NOT weaken the flagship catches:
  {
    name: "regression guard: a near-miss on a concrete sub-surface still blocks",
    code: "async (itx) => itx.streams.gett('/')",
    expected: "problems",
  },
  {
    name: "regression guard: a near-miss on a typed mount still blocks",
    code: "async (itx) => itx.tools.weather.forecastt({ city: 'x' })",
    capabilities: [WEATHER_MOUNT],
    expected: "problems",
  },
  {
    // TS2552, not a root property.
    name: "regression guard: a misspelled LOCAL still blocks",
    code: "async (itx) => { const count = 1; return cuont + 1; }",
    expected: "problems",
  },
  {
    // `gett` sits at 1-based column 28 in `itx.streams.gett`; the message
    // must read :28, not the tswasm-native 0-based :27 (matches editors).
    name: "regression: diagnostic columns are 1-based",
    code: "async (itx) => itx.streams.gett('/')",
    expected: "problems",
    problemContains: ["script:1:28"],
  },
];

test.for(GATE_ROWS)(
  "execution gate: $name",
  async ({ capabilities, code, expected, problemContains }) => {
    const checked = await gate(code, capabilities ?? []);
    expect(checked.verdict).toBe(expected);
    for (const needle of problemContains ?? []) {
      expect((checked as { problems: string[] }).problems[0]).toContain(needle);
    }
  },
);

test("execution gate: clean TypeScript scripts come back with runnable emitted JavaScript", async () => {
  // The 2026-07-14 pirate-thread script: valid TypeScript that used to crash
  // the plain-JS runtime. The gate's compile now doubles as the emitter —
  // what runs is the compiler's own type-stripped output.
  const checked = await gate(
    `async (itx) => {\n  const hits = [1, 2].map((r: any, i: number) => ({ r, i }));\n  return hits as any;\n}`,
  );
  expect(checked.verdict).toBe("clean");
  const emitted = (checked as { emittedJs?: string }).emittedJs ?? "";
  expect(emitted).toContain("export default script");
  expect(emitted).not.toContain(": any");
  expect(emitted).not.toContain(": number");
  expect(emitted).not.toContain(" as any");

  // Emit is resilient to errors ELSEWHERE in the program: a broken mount
  // declaration still yields the script's own emitted module, so a rotten
  // journal entry can't push execution onto the raw-code fallback.
  const withBrokenMount = await gate("async (itx) => 1", [
    { path: ["stale"], type: "live", types: "export type Stale = Goone;" },
  ]);
  expect(withBrokenMount).toMatchObject({ verdict: "clean" });
  expect((withBrokenMount as { emittedJs?: string }).emittedJs).toContain("export default script");
});

test("execution gate: a compiler crash and an unreachable checker both run unchecked", async () => {
  const crashing: Typechecker = {
    check: (input) =>
      runTypecheck({
        compiler: {
          compile: () => {
            throw new Error("Worker exceeded memory limit.");
          },
        },
        fetchImpl: () => Promise.reject(new Error("no network")),
        files: input.files,
      }),
  };
  const crashed = await checkItxScriptForExecution({
    capabilities: [],
    code: "async (itx) => {}",
    typechecker: crashing,
  });
  expect(crashed.verdict).toBe("unchecked");

  const unreachable: Typechecker = {
    check: () => Promise.reject(new Error("sidecar dial failed")),
  };
  const failed = await checkItxScriptForExecution({
    capabilities: [],
    code: "async (itx) => {}",
    typechecker: unreachable,
  });
  expect(failed.verdict).toBe("unchecked");
});

test("execution gate: a hanging checker hits the deadline and runs unchecked", async () => {
  const hanging: Typechecker = { check: () => new Promise(() => {}) };
  const checked = await checkItxScriptForExecution({
    capabilities: [],
    code: "async (itx) => {}",
    deadlineMs: 25,
    typechecker: hanging,
  });
  expect(checked.verdict).toBe("unchecked");
  expect((checked as { reason: string }).reason).toContain("exceeded 25ms");
});

// The remaining regression arms from the prd break-test findings (#1882
// follow-up) that resist tabling: each drives a poisoned/hanging checker or
// asserts the bail reason, not just a verdict.

test("execution gate regression: pathologically-nested scripts bail to unchecked, never reaching tsc", async () => {
  // ~1200-deep nesting wedged the host DO past its storage watchdog (tsc's
  // recursive descent is synchronous; the deadline fires too late). The cheap
  // depth guard bails to unchecked BEFORE the compiler is dialed — proven here
  // by a poisoned typechecker that throws if it is ever called.
  const exploding: Typechecker = {
    check: () => Promise.reject(new Error("typechecker must not be dialed for deep scripts")),
  };
  const deep = `async (itx) => { const x = ${"[".repeat(1200)}1${"]".repeat(1200)}; return x; }`;
  const checked = await checkItxScriptForExecution({
    capabilities: [],
    code: deep,
    typechecker: exploding,
  });
  expect(checked.verdict).toBe("unchecked");
  expect((checked as { reason: string }).reason).toContain("nesting");

  // A normal script with ordinary nesting still reaches the real checker.
  const shallow = await gate("async (itx) => itx.streams.gett('/')");
  expect(shallow.verdict).toBe("problems");
});

// ---------------------------------------------------------------------------
// The scope preamble: injected code above the script, its attribution
// boundary, and the gate's never-block-on-scope-code policy.

test("a script referencing preamble symbols compiles clean and the emitted module carries the preamble", async () => {
  const checked = await checkItxScriptForExecution({
    capabilities: [],
    code: "async (itx) => TECH_CHANNEL_ID.toUpperCase()",
    preamble: 'const TECH_CHANNEL_ID = "c1234";',
    typechecker,
  });
  expect(checked).toMatchObject({ verdict: "clean" });
  // The emitted module includes the preamble — the execution harness imports
  // it, so what runs is exactly what was checked.
  expect((checked as { emittedJs?: string }).emittedJs).toContain(
    'const TECH_CHANNEL_ID = "c1234"',
  );
});

test("the assembled results preamble typechecks end to end: literal data, typed loaders, error rows", async () => {
  const preamble = assemblePreamble({
    entries: [],
    results: [
      // state order: oldest first; the assembler renders newest first
      {
        kind: "error",
        executionId: "agent-output:33",
        settledAtOffset: 33,
        error: "TypeError: boom",
      },
      {
        kind: "large",
        executionId: "agent-output:42",
        settledAtOffset: 42,
        typeText: "{ items: { id: string }[] }",
      },
      {
        kind: "data",
        executionId: "agent-output:57",
        settledAtOffset: 57,
        resultJson: '{"users":["amy","bob"]}',
      },
    ],
  });
  const ok = await checkItxScript({
    capabilities: [],
    code: `async (itx) => {
      const name: string = results[0].data.users[0];
      const big = await results[1].load(itx);
      const id: string = big.items[0].id;
      const failed: string = results[2].error;
      return { name, id, failed };
    }`,
    preamble: preamble!.ts,
    typechecker,
  });
  expect(ok).toEqual([]);

  // A large result's .data is a typed trap (never): touching it is a compile
  // error steering the model to the loader.
  const trapped = await checkItxScript({
    capabilities: [],
    code: "async (itx) => results[1].data.items",
    preamble: preamble!.ts,
    typechecker,
  });
  expect(trapped.length).toBeGreaterThan(0);
  expect(trapped[0]).toContain("never");
});

test("a broken preamble never blocks a script: the gate downgrades to unchecked", async () => {
  const checked = await checkItxScriptForExecution({
    capabilities: [],
    code: "async (itx) => 1",
    preamble: "const broken: NoSuchType = 1;",
    typechecker,
  });
  expect(checked).toMatchObject({
    verdict: "unchecked",
    reason: "the scope's preamble does not compile",
  });
});

test("the advisory door labels preamble-line errors preamble:N while script errors keep script coordinates", async () => {
  const problems = await checkItxScript({
    capabilities: [],
    code: `async (itx) => {\n  return await itx.streams.gett("/");\n}`,
    preamble: "const one = 1;\nconst broken: Missing = one;",
    typechecker,
  });
  expect(problems.some((p) => p.includes("preamble:2") && p.includes("Missing"))).toBe(true);
  expect(problems.some((p) => p.includes("script:2") && p.includes("Did you mean 'get'"))).toBe(
    true,
  );
});

test("checkPreamble rejects a candidate that does not compile, attributed to preamble lines", async () => {
  const problems = await checkPreamble({
    capabilities: [],
    preamble: "const x: Missing = 1;",
    typechecker,
  });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("preamble:1");
  expect(problems[0]).toContain("Missing");
});

test("checkPreamble ignores problems outside the preamble — a broken mount must not veto a set", async () => {
  const problems = await checkPreamble({
    capabilities: [{ path: ["stale"], type: "live", types: "export type Stale = Goone;" }],
    preamble: "const ok = 1;",
    typechecker,
  });
  expect(problems).toEqual([]);
});

test("a preamble whose syntax errors cascade past its own lines still never blocks a script", async () => {
  // An unclosed brace reports NOTHING inside the preamble's range — every
  // diagnostic lands on later script lines or EOF. Blocking there would blame
  // an innocent script forever (including the one trying to removePreamble).
  const checked = await checkItxScriptForExecution({
    capabilities: [],
    code: "async (itx) => 1",
    preamble: "const broken = {",
    typechecker,
  });
  expect(checked.verdict).toBe("unchecked");
  expect((checked as { reason: string }).reason).toContain("preamble");
});

test("a script's OWN provable error still blocks when a valid preamble is present", async () => {
  const checked = await checkItxScriptForExecution({
    capabilities: [],
    code: `async (itx) => {\n  return await itx.streams.gett("/");\n}`,
    preamble: 'const TECH_CHANNEL_ID = "c1234";',
    typechecker,
  });
  expect(checked.verdict).toBe("problems");
  // The blame re-check runs without the preamble, so reported line numbers
  // match the code the model sent.
  expect((checked as { problems: string[] }).problems[0]).toContain("script:2");
  expect((checked as { problems: string[] }).problems[0]).toContain("Did you mean 'get'");
});

test("checkPreamble catches syntax errors that report outside the preamble's own lines", async () => {
  const problems = await checkPreamble({
    capabilities: [],
    preamble: "const broken = {",
    typechecker,
  });
  expect(problems.length).toBeGreaterThan(0);
});

test("a typo near-missing a preamble name still blocks with its did-you-mean", async () => {
  // The blame probe compiles the preamble ALONE: a clean probe proves the
  // blockers are the script's, and they report from the WITH-preamble check —
  // a bare re-check would demote this TS2552 to a non-blocking TS2304 and
  // run the script into a ReferenceError instead.
  const checked = await checkItxScriptForExecution({
    capabilities: [],
    code: "async (itx) => resultz[0]",
    preamble: "const results = [{ data: 1 }];",
    typechecker,
  });
  expect(checked.verdict).toBe("problems");
  expect((checked as { problems: string[] }).problems[0]).toContain("Did you mean 'results'");
});
