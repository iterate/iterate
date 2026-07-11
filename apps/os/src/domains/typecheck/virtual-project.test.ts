// These tests run the REAL tswasm compiler (the same wasm the typechecker
// sidecar ships) against the assembled virtual project, so "the platform
// surface compiles clean under the sidecar's lib + shims" is a tested
// invariant, not a hope. Network is stubbed: acquisitions serve from an
// in-memory fake registry, and checks that mention no npm package must not
// fetch at all (the platform surface's own docstrings mention npm imports —
// only CODE may trigger acquisition).
import { createCompiler } from "tswasm";
import { beforeAll, expect, test } from "vitest";
import type { CapabilityDescription } from "../itx/describe.ts";
import { openApiCapabilityTypeReference } from "../itx/capability-type-declarations.ts";
import type { CompileFn } from "./run-typecheck.ts";
import { runTypecheck, npmPackagesMentioned } from "./run-typecheck.ts";
import {
  checkCapabilityTypes,
  checkItxScript,
  checkItxScriptForExecution,
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
      }),
  };
});

/** A tiny in-memory jsdelivr: exactly one package, `fake-pets`, with one
 * exported type — enough to prove acquisition end to end without network. */
async function fakeRegistryFetch(url: string): Promise<Response> {
  fetchedUrls.push(url);
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
  type: "itx-expression",
  instructions: "Three-day forecasts.",
  types: "export type Forecast = { forecast(input: { city: string }): Promise<string> };",
};

test("the platform surface compiles clean under the sidecar's lib and shims, fetching nothing", async () => {
  fetchedUrls = [];
  const problems = await checkItxScript({
    capabilities: [],
    code: "async (itx) => {}",
    typechecker,
  });
  expect(problems).toEqual([]);
  // The surface's own docstrings mention import("@slack/web-api") as an
  // example; a fetch here would mean the npm scan reads comments.
  expect(fetchedUrls).toEqual([]);
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
      type: "itx-expression",
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

test("a compiler crash comes back as a clean problem, not an infra throw", async () => {
  // A type-compute bomb can OOM the wasm isolate; the raw throw used to leak
  // "Worker exceeded memory limit." / non-JSON output to the provide caller.
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
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("type checking crashed");
  expect(problems[0]).toContain("too complex");
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
      { path: ["gone"], type: "itx-expression", types: 'export type G = import("fake-gone").X;' },
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
    { path: ["store"], type: "itx-expression", types: reference },
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
        type: "itx-expression",
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

test("execution gate: a wrong call into the typed surface blocks with the caller's line numbers", async () => {
  const checked = await gate(`async (itx) => {\n  return await itx.streams.gett("/");\n}`);
  expect(checked.verdict).toBe("problems");
  const problems = (checked as { problems: string[] }).problems;
  expect(problems[0]).toContain("script:2");
  expect(problems[0]).toContain("Did you mean 'get'");
});

test("execution gate: a near-miss typo on a typed mount blocks; anything else on mounts runs", async () => {
  const typo = await gate("async (itx) => itx.tools.weather.forecastt({ city: 'Berlin' })", [
    WEATHER_MOUNT,
  ]);
  expect(typo.verdict).toBe("problems");
  expect((typo as { problems: string[] }).problems[0]).toContain("Did you mean 'forecast'");

  const untyped = await gate("async (itx) => itx.legacy.whatever(1, { deep: true })", [
    { path: ["legacy"], type: "live" },
  ]);
  expect(untyped).toEqual({ verdict: "clean" });
});

test("execution gate: only NEAR-MISS proof blocks — bare mismatches are unprovable and run", async () => {
  // The declared surface lags the runtime in places (preview e2e:
  // CloudflareSandbox.exec exists at runtime but not in types, handle results
  // declared {}), so property/argument mismatches without a did-you-mean must
  // never block. These all failed loudly in preview until this policy.
  for (const code of [
    // A capability nobody declared — journal-legal via dynamic provides.
    "async (itx) => itx.nonexistent.doThing()",
    // Wrong argument type into the platform surface — types may lag runtime.
    "async (itx) => itx.docs.search(42)",
    // Wrong argument shape into a typed mount.
    "async (itx) => itx.tools.weather.forecast({ city: 42 })",
  ]) {
    const checked = await gate(code, [WEATHER_MOUNT]);
    expect(checked, code).toEqual({ verdict: "clean" });
  }
});

test("execution gate: provide-then-use in one script stays green (dynamic mounts are invisible to a static check)", async () => {
  // The canonical catalogue example shape that preview e2e runs: mount a
  // capability, then call it through the itx proxy two lines later.
  const checked = await gate(
    `async (itx) => {
      await itx.capabilityHost.provideCapability({
        type: "itx-expression",
        path: ["demoStream"],
        expression: ["streams", ["get", "/"]],
      });
      return await itx.demoStream.getEvents({ afterOffset: 0, limit: 10 });
    }`,
  );
  expect(checked).toEqual({ verdict: "clean" });
});

test("execution gate: a stale BROKEN mount never vetoes a script that doesn't deserve it", async () => {
  const staleMount: CapabilityDescription[] = [
    { path: ["stale"], type: "live", types: "export type Stale = Goone;" },
  ];
  // A clean script in a scope with a rotten journaled declaration runs.
  expect(await gate("async (itx) => itx.stale.anything()", staleMount)).toEqual({
    verdict: "clean",
  });
  // …but the script's OWN provable errors still block in the same scope.
  const ownTypo = await gate("async (itx) => itx.streams.gett('/')", staleMount);
  expect(ownTypo.verdict).toBe("problems");
});

test("execution gate: unresolved modules never block (acquisition failure ≠ proof)", async () => {
  // fake-gone 404s in the fake registry — the mount module errors AND the
  // script's own import errors are both unresolved-module class, so it runs.
  const checked = await gate('async (itx) => { const m = await import("fake-gone"); return m; }', [
    { path: ["gone"], type: "itx-expression", types: 'export type G = import("fake-gone").X;' },
  ]);
  expect(checked).toEqual({ verdict: "clean" });
});

test("execution gate: shapes the checker doesn't model run unchecked (raw runScript callers)", async () => {
  for (const code of [
    "(itx) => itx.streams.gett('/')", // plain arrow — runtime accepts it
    "(async function (itx) { return 1; })",
    "function f(itx) { return 1; }",
  ]) {
    const checked = await gate(code);
    expect(checked.verdict, code).toBe("unchecked");
  }
});

test("execution gate: oversized scripts and non-string code run unchecked", async () => {
  const huge = await gate(`async (itx) => { ${"x;".repeat(150_000)} }`);
  expect(huge.verdict).toBe("unchecked");
  const notString = await checkItxScriptForExecution({
    capabilities: [],
    code: ["async (itx) => {}"] as unknown as string,
    typechecker,
  });
  expect(notString.verdict).toBe("unchecked");
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

test("execution gate: runtime idioms that execute fine stay green", async () => {
  const scripts = [
    // Extra declared params — the runtime calls fn(itx), extras are undefined.
    "async (itx, extra, more) => itx.docs.search({ q: 'x' })",
    // Destructured itx parameter.
    "async ({ streams, docs }) => { await streams.get('/'); await docs.search({ q: 'x' }); }",
    // Runtime globals: web platform + nodejs_compat.
    `async (itx) => {
      const res = await fetch(new URL("https://example.com/?q=" + crypto.randomUUID()));
      const body = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
      await new Promise((resolve) => setTimeout(resolve, 10));
      console.log(structuredClone({ body: atob(btoa(body)) }), performance.now());
      return Buffer.from(process?.env?.HOME ?? "x").toString("base64");
    }`,
    // using-declarations: the runtime's own wrapper uses \`using\`, so the
    // shimmed Symbol.dispose/Disposable must keep scripts with them green.
    `async (itx) => {
      const handle = { [Symbol.dispose]: () => {} };
      { using h = handle; void h; }
      return null;
    }`,
    // Async generators, for-await, Map/Set, regex, template literals, classes.
    `async (itx) => {
      class Acc { total = 0; add(n) { this.total += n; return this; } }
      async function* numbers() { yield 1; yield 2; }
      const acc = new Acc();
      for await (const n of numbers()) acc.add(n);
      const seen = new Map([["k", new Set([1])]]);
      return \`total=\${acc.total} \${/\\d+/.test("42")} \${seen.size}\`;
    }`,
    // try/catch with unknown error narrowing and rethrow.
    `async (itx) => {
      try {
        return await itx.streams.get("/");
      } catch (error) {
        throw new Error("wrapped: " + (error instanceof Error ? error.message : String(error)));
      }
    }`,
  ];
  for (const code of scripts) {
    const checked = await gate(code);
    expect(checked, code.slice(0, 60)).toEqual({ verdict: "clean" });
  }
});

test("execution gate: provable script bugs the run would only surface at runtime DO block", async () => {
  const buggy = [
    // Misspelled local with a near-miss — TS2552 names the fix.
    "async (itx) => { const count = 1; return cuont + 1; }",
    // Misspelled platform member with a near-miss — TS2551 names the fix.
    "async (itx) => itx.streams.gett('/')",
    // Syntax errors — the runtime's loader would reject these anyway.
    "async (itx) => { const = 1; }",
    "async (itx) => { return JSON.parse('{'; }",
  ];
  for (const code of buggy) {
    const checked = await gate(code);
    expect(checked.verdict, code).toBe("problems");
  }
});

// ─── Regression: prd break-test findings (follow-up to #1882) ────────────────
// Four false-positive / robustness holes the production break-test surfaced.
// Each asserts the RUNTIME-legal behavior the gate must now preserve.

test("execution gate regression: ES2024+ runtime features are not blocked as syntax errors (TS1501)", async () => {
  // The regex `v` flag runs in workerd; pinning target es2022 reported TS1501
  // ("only available when targeting es2024 or later") — a 1xxx code the gate
  // blocked as if it were a parse error. matching the runtime target fixes it.
  const vFlag = await gate("async (itx) => { const re = /[\\p{L}]/v; return re.test('x'); }");
  expect(vFlag).toEqual({ verdict: "clean" });
  // A sibling target-availability feature: top-level-style await already inside
  // the async body is fine; `using` (ES2026 explicit resource management) too.
  const using = await gate("async (itx) => { using d = { [Symbol.dispose]() {} }; void d; }");
  expect(using).toEqual({ verdict: "clean" });
});

test("execution gate regression: near-miss on the runtime-extensible itx root does NOT block", async () => {
  // provide-then-use in one script: the mount does not exist statically, and
  // its near-miss to `agent` used to bounce it (TS2551 → blocked). The root is
  // runtime-extensible, so this must run.
  const provideThenUse = await gate(`async (itx) => {
    await itx.capabilityHost.provideCapability({ type: "itx-expression", path: ["agentz"], expression: ["streams", ["get", "/"]] });
    return typeof itx.agentz;
  }`);
  expect(provideThenUse).toEqual({ verdict: "clean" });

  // A bare root-member typo (`itx.strems`) reads identically to a dynamic
  // provide — indistinguishable statically — so it too must run (the price of
  // a runtime-extensible root; sub-member typos below stay caught).
  const rootTypo = await gate("async (itx) => itx.strems.get('/')");
  expect(rootTypo).toEqual({ verdict: "clean" });

  // The refinement must NOT weaken the flagship catches: near-miss on a
  // CONCRETE sub-surface is still provable and still blocks.
  const subMemberTypo = await gate("async (itx) => itx.streams.gett('/')");
  expect(subMemberTypo.verdict).toBe("problems");
  const mountTypo = await gate("async (itx) => itx.tools.weather.forecastt({ city: 'x' })", [
    WEATHER_MOUNT,
  ]);
  expect(mountTypo.verdict).toBe("problems");
  // A misspelled LOCAL (TS2552, not a root property) still blocks.
  const localTypo = await gate("async (itx) => { const count = 1; return cuont + 1; }");
  expect(localTypo.verdict).toBe("problems");
});

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

test("execution gate regression: diagnostic columns are 1-based (match the line and editors)", async () => {
  // `gett` sits at 1-based column 28 in `itx.streams.gett`; the message must
  // read :28, not the tswasm-native 0-based :27.
  const checked = await gate("async (itx) => itx.streams.gett('/')");
  expect(checked.verdict).toBe("problems");
  expect((checked as { problems: string[] }).problems[0]).toContain("script:1:28");
});
