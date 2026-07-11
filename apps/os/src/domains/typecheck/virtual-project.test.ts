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
