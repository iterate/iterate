// context/module-resolution.test.ts — authored source → loader modules, with no build step. The rows
// pin: TypeScript is stripped and every module name ends in `.js`; relative imports resolve with or
// without extensions and only what the entry reaches is loaded — the entry being package.json's
// `main` (else, while ENTRY_FILES lasts, worker.ts, worker.js, index.ts or index.js); `iterate/*` and zod link the
// deployment's own SDK modules (and only the chunks they reach), and a subpath of either the
// platform does not ship is refused;
// npm imports are crawled from esm.sh ONCE per dependency set and locked in the store (a second
// resolution fetches nothing), with esm.sh's own quirks (builtins as paths, cycles, the platform
// packages left external) handled; a pkg.pr.new dependency loads only at a full commit, and a branch
// or PR ref is refused naming the pin; an alias (`npm:<package>@<version>`, or a pkg.pr.new URL of
// another package) loads the package it names under the listed name; what cannot work in a loaded
// worker is refused by name; and
// the loader starts every worker from a generated main that evaluates the platform's module first.
// Like tsc, stripping elides an import whose bindings are never used as values.
import { parse } from "es-module-lexer/js";
import { expect, test, vi } from "vitest";
import {
  enteredThroughPlatform,
  resolveModules,
  type PlatformModules,
} from "./module-resolution.ts";

const platform: PlatformModules = {
  modules: {
    "node_modules/iterate/sdk.js": `import{z}from"../.platform/chunk-a.js";export const sdk="sdk";export{z};`,
    "node_modules/iterate/lib.js": `export const lib="lib";`,
    "node_modules/zod.js": `export*from"./.platform/chunk-a.js";`,
    "node_modules/.platform/chunk-a.js": `export const z="zod";`,
    "node_modules/.platform/chunk-unused.js": `export const nope=1;`,
    "node_modules/.platform/loaded-worker.js": `import"./chunk-a.js";`,
  },
  imports: {
    "node_modules/iterate/sdk.js": ["node_modules/.platform/chunk-a.js"],
    "node_modules/iterate/lib.js": [],
    "node_modules/zod.js": ["node_modules/.platform/chunk-a.js"],
    "node_modules/.platform/chunk-a.js": [],
    "node_modules/.platform/chunk-unused.js": [],
    "node_modules/.platform/loaded-worker.js": ["node_modules/.platform/chunk-a.js"],
  },
};

test("TypeScript is stripped, siblings resolve by any spelling, only what the entry reaches loads", async () => {
  const modules = await resolve({
    "package.json": '{"main":"worker.ts"}',
    "worker.ts": `import { a } from "./lib/a"; import b from "./lib/b.ts"; import { c } from "./lib/c.js";
        const n: number = a + b + c; export default { fetch: () => new Response(String(n)) };`,
    "lib/a.ts": `export const a: number = 1;`,
    "lib/b.ts": `interface B { x: number } const b: B = { x: 2 }; export default b.x;`,
    "lib/c.ts": `import type { Z } from "./z.ts"; export const c = 3 as number;`,
    "lib/unreached.ts": `import "some-package";`,
    "README.md": "# hi",
  });
  expect(Object.keys(modules).sort()).toEqual(["lib/a.js", "lib/b.js", "lib/c.js", "worker.js"]);
  expect(modules["worker.js"]).toContain(`from "./lib/a.js"`);
  expect(modules["worker.js"]).not.toContain(": number");
  expect(modules["lib/c.js"]).not.toContain("./z.ts"); // type-only import elided
  expectLinked(modules);
});

test.for([
  [
    "a missing sibling",
    { "package.json": '{"main":"worker.js"}', "worker.js": `import "./nope.js";` },
    /no such file/,
  ],
  [
    "a computed dynamic import",
    { "package.json": '{"main":"worker.js"}', "worker.js": "const m = 'x'; await import(m);" },
    /computed specifier/,
  ],
  [
    "a URL import",
    { "package.json": '{"main":"worker.js"}', "worker.js": `import "https://esm.sh/zod";` },
    /import packages by name/,
  ],
  [
    "an iterate subpath the platform does not ship",
    { "package.json": '{"main":"worker.js"}', "worker.js": `import "iterate/node";` },
    /iterate\/node is not a module loaded workers have \(the platform ships .*iterate\/sdk.*\)/,
  ],
  [
    "a zod subpath the platform does not ship (a second zod)",
    {
      "worker.js": `import "zod/v4";`,
      "package.json": JSON.stringify({ main: "worker.js", dependencies: { zod: "4" } }),
    },
    /zod\/v4 is not a module loaded workers have/,
  ],
  ["no entry", { "lib.js": "", "README.md": "# hi" }, /no entry/],
  [
    "a package not in package.json dependencies (never `latest`, never locked for everyone)",
    {
      "worker.js": `import "hono";`,
      "package.json": JSON.stringify({ main: "worker.js", devDependencies: { hono: "4" } }),
    },
    /imports hono; list hono in package\.json "dependencies"/,
  ],
  [
    "a Node.js builtin in the author's own module",
    {
      "package.json": '{"main":"worker.js"}',
      "worker.js": `import { Buffer } from "node:buffer"; export default Buffer;`,
    },
    /imports the Node\.js builtin node:buffer/,
  ],
  [
    "a package.json main that is not a file",
    { "package.json": JSON.stringify({ main: "./src/app.ts" }), "worker.ts": "" },
    /main "\.\/src\/app\.ts" is not a file/,
  ],
] as const)("refuses %s", async ([, source, message]) => {
  await expect(resolve(source)).rejects.toThrow(message);
});

test.for([
  [
    "package.json's main",
    { "package.json": '{ "main": "./src/app.ts" }', "src/app.ts": "", "worker.ts": "" },
    "src/app.js",
  ],
  // The temporary ENTRY_FILES fallback, pinned only while sources written without "main" remain.
  // The follow-up that deletes ENTRY_FILES turns these two rows into refusals.
  [
    "worker.ts before index.ts, by the temporary ENTRY_FILES fallback",
    { "index.ts": "", "worker.ts": "" },
    "worker.js",
  ],
  [
    "index.ts when there is no worker file, by the temporary ENTRY_FILES fallback",
    { "index.ts": "", "lib.ts": "" },
    "index.js",
  ],
] as const)("the entry is %s", async ([, source, mainModule]) => {
  const resolved = await resolveModules(source, {
    platform,
    store: memoryStore(),
    fetch: offline,
    where: "test",
  });
  expect(resolved).toMatchObject({ mainModule });
  expect(Object.keys(resolved.modules)).toEqual([mainModule]);
});

test("a main module named by the caller is the entry in place of package.json's main, its own graph alone; one that is not a file is refused", async () => {
  const source = {
    "package.json": '{"main":"worker.ts"}',
    "worker.ts": 'import "./site.ts"; export default 1;',
    "site.ts": "export const site = 1;",
    "agents.ts": 'export { helper } from "./lib/helper.ts";',
    "lib/helper.ts": "export const helper = 1;",
  };
  const options = { platform, store: memoryStore(), fetch: offline, where: "test" };
  const resolved = await resolveModules(source, { ...options, mainModule: "agents.ts" });
  expect(resolved).toMatchObject({ mainModule: "agents.js" });
  expect(Object.keys(resolved.modules).sort()).toEqual(["agents.js", "lib/helper.js"]);
  await expect(resolveModules(source, { ...options, mainModule: "nope.ts" })).rejects.toThrow(
    /no module "nope\.ts" to load as the main module/,
  );
});

test("iterate/* and zod link this deployment's modules, and only the chunks they reach", async () => {
  const modules = await resolve({
    "package.json": '{"main":"worker.js"}',
    "worker.js": `import { sdk } from "iterate/sdk"; import { z } from "zod"; import "./nested/x.ts"; export default [sdk, z];`,
    "nested/x.ts": `import { lib } from "iterate/lib"; export default lib;`,
  });
  expect(modules["worker.js"]).toContain(`from "./node_modules/iterate/sdk.js"`);
  expect(modules["nested/x.js"]).toContain(`from "../node_modules/iterate/lib.js"`);
  expect(Object.keys(modules)).not.toContain("node_modules/.platform/chunk-unused.js");
  expectLinked(modules);
});

test("the loader starts a worker from its own main module, which imports the platform's module first, on its first line", () => {
  const worker = `import { WorkerEntrypoint } from "cloudflare:workers";\nexport default class extends WorkerEntrypoint {}`;
  const entered = enteredThroughPlatform(
    { mainModule: "src/worker.js", modules: { "src/worker.js": worker } },
    platform,
  );
  expect(entered).toMatchObject({ mainModule: "src/worker.js" });
  expect(entered.modules["src/worker.js"]).toBe(
    `import "../node_modules/.platform/loaded-worker.js"; ${worker}`,
  );
  expect(Object.keys(entered.modules).sort()).toEqual([
    "node_modules/.platform/chunk-a.js",
    "node_modules/.platform/loaded-worker.js",
    "src/worker.js",
  ]);
  expectLinked(entered.modules);
});

const esmFiles = {
  // the entry stub esm.sh answers for a range
  "/lib-a@^1.0.0": `export * from "/lib-a@1.2.3/es2022/lib-a.mjs";`,
  // a cycle, a builtin mangled into a path, a platform package left external, a relative import
  "/lib-a@1.2.3/es2022/lib-a.mjs": `import "/lib-b@2.0.0/es2022/lib-b.mjs"; import { DurableObject } from "/cloudflare:workers?target=es2022"; import { z } from "zod"; import "./util.mjs"; export const a = 1;`,
  // a builtin esm.sh left external (named in `external`), as it answers a package's own entry
  "/lib-a@1.2.3/es2022/util.mjs": `import { RpcTarget } from "cloudflare:workers"; export const util = RpcTarget;`,
  "/lib-b@2.0.0/es2022/lib-b.mjs": `import "/lib-a@1.2.3/es2022/lib-a.mjs"; export const b = 2;`,
};

test("the graph is crawled once, rewritten to relative names, and locked in the store", async () => {
  const store = memoryStore();
  const first = fakeEsm(esmFiles);
  const source = {
    "worker.js": `import { a } from "lib-a"; export default { fetch: () => new Response(String(a)) };`,
    "package.json": JSON.stringify({ main: "worker.js", dependencies: { "lib-a": "^1.0.0" } }),
  };
  const modules = await resolve(source, { fetch: first.fetch, store });
  expect(first.fetched).toHaveLength(4);
  expect(first.fetched[0]).toBe(
    "/lib-a@^1.0.0?target=es2022&external=cloudflare%3Aemail%2Ccloudflare%3Asockets%2Ccloudflare%3Aworkers%2Citerate%2Czod",
  );
  expect(modules["worker.js"]).toContain(`from "./node_modules/lib-a.js"`);
  const libA = modules["node_modules/.esm/lib-a@1.2.3/es2022/lib-a.js"]!;
  expect(libA).toContain(`from "cloudflare:workers"`);
  expect(libA).toMatch(/from "(\.\.\/)+zod\.js"/);
  expect(Object.keys(modules)).toContain("node_modules/.platform/chunk-a.js");
  expectLinked(modules);
  expect(store.values).toMatchObject({ size: 1 });

  // Any project, any cold isolate, the same dependency set: the lock, and no network.
  const second = await resolve(source, { fetch: offline, store });
  expect(second).toEqual(modules);
});

test.for([
  [
    "a Node builtin",
    { "/needs-node@1": `import "node:fs";` },
    /needs the Node\.js builtin node:fs/,
  ],
] as const)("refuses %s, naming it", async ([, files, message]) => {
  const esm = fakeEsm(files);
  await expect(
    resolve(
      {
        "worker.js": `import "needs-node";`,
        "package.json": JSON.stringify({ main: "worker.js", dependencies: { "needs-node": "1" } }),
      },
      esm,
    ),
  ).rejects.toThrow(message);
});

test.for<{ name: string; answer: () => Promise<Response>; failure: object }>([
  {
    name: "esm.sh answering 503 is the platform's failure: UNAVAILABLE, disconnected",
    answer: async () => new Response("busy", { status: 503 }),
    failure: { code: "UNAVAILABLE", data: { kind: "disconnected" } },
  },
  {
    name: "esm.sh asking for a slower pace is the platform's failure: UNAVAILABLE, overloaded",
    answer: async () => new Response("slow down", { status: 429 }),
    failure: { code: "UNAVAILABLE", data: { kind: "overloaded" } },
  },
  {
    name: "esm.sh out of reach is the platform's failure: UNAVAILABLE, disconnected",
    answer: () => Promise.reject(new TypeError("fetch failed")),
    failure: { code: "UNAVAILABLE", data: { kind: "disconnected" } },
  },
  {
    name: "a package esm.sh does not have is the source's: no code",
    answer: async () => new Response("not found", { status: 404 }),
    failure: { message: expect.stringMatching(/answered 404/) },
  },
])("$name", async ({ answer, failure }) => {
  const rejection = await resolve(
    {
      "worker.js": `import "lib-a";`,
      "package.json": JSON.stringify({ main: "worker.js", dependencies: { "lib-a": "1" } }),
    },
    { fetch: answer as typeof globalThis.fetch },
  ).catch((error: unknown) => error);
  expect(rejection).toMatchObject(failure);
  if (!("code" in failure)) expect(rejection).not.toHaveProperty("code");
});

test("esm.sh's own /node/ polyfills (capnweb's Buffer) load as ordinary modules", async () => {
  const esm = fakeEsm({
    "/uses-buffer@1": `import "/node/buffer.mjs"; export const b = 1;`,
    "/node/buffer.mjs": `export const Buffer = class {};`,
  });
  const modules = await resolve(
    {
      "worker.js": `import { b } from "uses-buffer"; export default b;`,
      "package.json": JSON.stringify({ main: "worker.js", dependencies: { "uses-buffer": "1" } }),
    },
    esm,
  );
  expect(Object.keys(modules)).toContain("node_modules/.esm/node/buffer.js");
  expectLinked(modules);
});

const sdkCommit = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

test("a pkg.pr.new commit resolves through esm.sh's /pr/ route, its own subpath imports at that commit, and pkg.pr.new is never asked; a URL naming no package is refused", async () => {
  const esm = fakeEsm({
    [`/pr/acme/shop/@acme/sdk@${sdkCommit}`]: `export * from "/pr/acme/shop/@acme/sdk@${sdkCommit}/es2022/sdk.mjs";`,
    // esm.sh's /pr/ route spells the package's import of its own exported subpath bare
    [`/pr/acme/shop/@acme/sdk@${sdkCommit}/es2022/sdk.mjs`]: `import { name } from "acme/shop/@acme/sdk/contract"; export const connect = () => name;`,
    [`/pr/acme/shop/@acme/sdk@${sdkCommit}/contract`]: `export * from "/pr/acme/shop/@acme/sdk@${sdkCommit}/es2022/contract.mjs";`,
    [`/pr/acme/shop/@acme/sdk@${sdkCommit}/es2022/contract.mjs`]: `export const name = "shop";`,
  });
  const store = memoryStore();
  const modules = await resolve(sdkSource(`https://pkg.pr.new/acme/shop/@acme/sdk@${sdkCommit}`), {
    fetch: esm.fetch,
    store,
  });
  expect(esm.fetched[0]).toBe(
    `/pr/acme/shop/@acme/sdk@${sdkCommit}?target=es2022&external=cloudflare%3Aemail%2Ccloudflare%3Asockets%2Ccloudflare%3Aworkers%2Citerate%2Czod`,
  );
  expect(esm.fetched.every((path) => path.startsWith("/pr/"))).toBe(true);
  expect(modules["worker.js"]).toContain(`from "./node_modules/@acme/sdk.js"`);
  expectLinked(modules);
  // every later cold start: the lock, and no network at all
  expect(
    await resolve(sdkSource(`https://pkg.pr.new/acme/shop/@acme/sdk@${sdkCommit}`), { store }),
  ).toEqual(modules);
  await expect(
    resolve(sdkSource(`https://pkg.pr.new/acme/shop@${sdkCommit}`), esm),
  ).rejects.toThrow(
    /test: package\.json lists @acme\/sdk as https:\/\/pkg\.pr\.new\/acme\/shop@9f8e7d6c5b4a\w+; pin it as https:\/\/pkg\.pr\.new\/<owner>\/<repo>\/@acme\/sdk@<40-hex sha>/,
  );
});

test("a source that imports a package and a subpath the package imports of itself loads that subpath once, under both names (a config's probe imports agents.ts and worker.ts: @iterate-com/agents and its /install)", async () => {
  const esm = fakeEsm({
    [`/pr/acme/shop/@acme/sdk@${sdkCommit}`]: `export * from "/pr/acme/shop/@acme/sdk@${sdkCommit}/es2022/sdk.mjs";`,
    [`/pr/acme/shop/@acme/sdk@${sdkCommit}/es2022/sdk.mjs`]: `import { name } from "acme/shop/@acme/sdk/contract"; export const connect = () => name;`,
    [`/pr/acme/shop/@acme/sdk@${sdkCommit}/contract`]: `export * from "/pr/acme/shop/@acme/sdk@${sdkCommit}/es2022/contract.mjs"; export { default } from "/pr/acme/shop/@acme/sdk@${sdkCommit}/es2022/contract.mjs";`,
    [`/pr/acme/shop/@acme/sdk@${sdkCommit}/es2022/contract.mjs`]: `export const name = "shop"; export default name;`,
  });
  const source = {
    ...sdkSource(`https://pkg.pr.new/acme/shop/@acme/sdk@${sdkCommit}`),
    "worker.ts": `import { connect } from "@acme/sdk"; import shop, { name } from "@acme/sdk/contract"; export default { fetch: () => new Response(connect() + shop + name) };`,
  };
  const modules = await resolve(source, { fetch: esm.fetch });
  expectLinked(modules);
  // fetched once: one module instance, whose classes are the same classes under either name
  expect(
    esm.fetched.filter((path) => path.startsWith(`/pr/acme/shop/@acme/sdk@${sdkCommit}/contract`)),
  ).toHaveLength(1);
  const selfImported = Object.keys(modules).find((name) => name.includes("/contract~"))!;
  expect(modules[selfImported]).toBe(
    'export * from "../../../../../../@acme/sdk/contract.js"; export { default } from "../../../../../../@acme/sdk/contract.js";\n',
  );
});

test.for([
  ["a branch", "main"],
  ["a PR number", "1234"],
  ["a short sha", "9f8e7d6"],
])(
  "a pkg.pr.new ref that is %s is refused, naming the pin, before any lock stored for it is read",
  async ([, ref]) => {
    // A store that answers every key with a lock: the refusal comes before any read of it.
    const store = {
      values: new Map<string, string>(),
      get: vi.fn(async () => JSON.stringify({ modules: {}, platformModules: [] })),
      put: vi.fn(async () => undefined),
    };
    await expect(
      resolve(sdkSource(`https://pkg.pr.new/acme/shop/@acme/sdk@${ref}`), { store }),
    ).rejects.toThrow(
      `test: package.json lists @acme/sdk at "${ref}", which is not a commit, so it could name another build tomorrow; pin the commit: https://pkg.pr.new/<owner>/<repo>/@acme/sdk@<40-hex sha> (a HEAD of the URL names it in x-commit-key)`,
    );
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  },
);

test("an npm: alias loads the package it names under the name it is listed by, subpaths too, and esm.sh is never asked for the listed name", async () => {
  const esm = fakeEsm({
    // esm.sh reads the alias as written as the listed name's own package, at its latest version
    "/react@npm:@preact/compat@18.3.1": `export const createElement = () => "react";`,
    "/@preact/compat@18.3.1": `export * from "/@preact/compat@18.3.1/es2022/compat.mjs";`,
    "/@preact/compat@18.3.1/es2022/compat.mjs": `export const createElement = () => "preact";`,
    "/@preact/compat@18.3.1/jsx-runtime": `export * from "/@preact/compat@18.3.1/es2022/jsx-runtime.mjs";`,
    "/@preact/compat@18.3.1/es2022/jsx-runtime.mjs": `import { createElement } from "./compat.mjs"; export const jsx = createElement;`,
  });
  const modules = await resolve(
    {
      "worker.ts": `import { createElement } from "react"; import { jsx } from "react/jsx-runtime"; export default [createElement, jsx];`,
      "package.json": JSON.stringify({
        main: "worker.ts",
        dependencies: { react: "npm:@preact/compat@18.3.1" },
      }),
    },
    esm,
  );
  // exact: the listed name's own package is never asked for
  expect(esm.fetched.map((path) => path.split("?")[0]).sort()).toEqual([
    "/@preact/compat@18.3.1",
    "/@preact/compat@18.3.1/es2022/compat.mjs",
    "/@preact/compat@18.3.1/es2022/jsx-runtime.mjs",
    "/@preact/compat@18.3.1/jsx-runtime",
  ]);
  expect(importedModules(modules, "worker.js")).toEqual([
    "node_modules/react.js",
    "node_modules/react/jsx-runtime.js",
  ]);
  expectLinked(modules);
});

test.for([
  {
    name: "an alias at a version asks for that version",
    version: "npm:hono@4.9.0",
    asked: "/hono@4.9.0",
  },
  {
    name: "an alias of a scoped package at a range",
    version: "npm:@acme/sdk@^2",
    asked: "/@acme/sdk@^2",
  },
  {
    name: "an alias that names no version asks for the latest",
    version: "npm:hono",
    asked: "/hono@latest",
  },
])("$name", async ({ version, asked }) => {
  const esm = fakeEsm({ [asked]: `export default 1;` });
  await resolve(
    {
      "worker.js": `import one from "alias"; export default one;`,
      "package.json": JSON.stringify({ main: "worker.js", dependencies: { alias: version } }),
    },
    esm,
  );
  expect(esm.fetched.map((path) => path.split("?")[0])).toEqual([asked]);
});

test.for([
  { name: "an alias of an alias", version: "npm:hono@npm:hono@4" },
  { name: "an alias of a URL", version: `npm:https://pkg.pr.new/acme/shop/@acme/sdk@${sdkCommit}` },
  { name: "an alias that names no package", version: "npm:" },
])("refuses $name, naming the form an alias takes", async ({ version }) => {
  await expect(
    resolve({
      "worker.js": `import "alias";`,
      "package.json": JSON.stringify({ main: "worker.js", dependencies: { alias: version } }),
    }),
  ).rejects.toThrow(
    `test: package.json lists alias as ${version}; an alias names a package on npm and its version: npm:<package>@<version>`,
  );
});

test("an alias of a platform package imports its own subpaths at the aliased version; the worker's own iterate/* and the alias's zod stay this deployment's", async () => {
  const esm = fakeEsm({
    "/iterate@0.4.0/stream/processor": `export * from "/iterate@0.4.0/X-ZXh0/es2022/stream/processor.mjs";`,
    // esm.sh leaves iterate external, so it spells the package's import of its own export bare
    "/iterate@0.4.0/X-ZXh0/es2022/stream/processor.mjs": `import { lib } from "iterate/lib"; import { z } from "zod"; export const processor = [lib, z];`,
    "/iterate@0.4.0/lib": `export * from "/iterate@0.4.0/X-ZXh0/es2022/lib.mjs";`,
    "/iterate@0.4.0/X-ZXh0/es2022/lib.mjs": `export const lib = "lib@0.4.0";`,
  });
  const modules = await resolve(
    {
      "worker.ts": `import { processor } from "iterate-2026-10-01/stream/processor"; import { lib } from "iterate/lib"; export default [processor, lib];`,
      "package.json": JSON.stringify({
        main: "worker.ts",
        dependencies: { "iterate-2026-10-01": "npm:iterate@0.4.0" },
      }),
    },
    esm,
  );
  expect(importedModules(modules, "worker.js")).toEqual([
    "node_modules/iterate-2026-10-01/stream/processor.js",
    "node_modules/iterate/lib.js",
  ]);
  expect(
    importedModules(modules, "node_modules/.esm/iterate@0.4.0/X-ZXh0/es2022/stream/processor.js"),
  ).toEqual([
    expect.stringMatching(/^node_modules\/\.esm\/iterate@0\.4\.0\/lib~target=es2022/),
    "node_modules/zod.js",
  ]);
  expectLinked(modules);
});

test("a pkg.pr.new URL listed under another name is an alias: the package the URL names loads, and a moving ref is refused naming that package's pin", async () => {
  const esm = fakeEsm({
    [`/pr/acme/shop/@acme/sdk@${sdkCommit}`]: `export * from "/pr/acme/shop/@acme/sdk@${sdkCommit}/es2022/sdk.mjs";`,
    [`/pr/acme/shop/@acme/sdk@${sdkCommit}/es2022/sdk.mjs`]: `export const connect = () => "shop";`,
  });
  const source = (url: string) => ({
    "worker.ts": `import { connect } from "shop-next"; export default connect;`,
    "package.json": JSON.stringify({ main: "worker.ts", dependencies: { "shop-next": url } }),
  });
  const modules = await resolve(source(`https://pkg.pr.new/acme/shop/@acme/sdk@${sdkCommit}`), esm);
  expect(importedModules(modules, "worker.js")).toEqual(["node_modules/shop-next.js"]);
  expectLinked(modules);
  await expect(resolve(source("https://pkg.pr.new/acme/shop/@acme/sdk@main"), esm)).rejects.toThrow(
    `test: package.json lists shop-next at "main", which is not a commit, so it could name another build tomorrow; pin the commit: https://pkg.pr.new/<owner>/<repo>/@acme/sdk@<40-hex sha>`,
  );
});

/** A fake esm.sh (path+query → module text). Records what was fetched. */
function fakeEsm(files: Record<string, string>) {
  const fetched: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    // Newer URL parsers percent-encode `^` in a path (`lib-a@%5E1.0.0`); esm.sh reads either.
    const pathname = decodeURIComponent(url.pathname);
    fetched.push(pathname + url.search);
    const body = files[pathname + url.search] || files[pathname];
    if (!body) return new Response("not found", { status: 404 });
    return new Response(body, { headers: { "content-type": "application/javascript" } });
  }) as typeof globalThis.fetch;
  return { fetch, fetched };
}

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key) || null,
    put: async (key: string, value: string) => void values.set(key, value),
  };
}

function offline(): Promise<Response> {
  throw new Error("no network in this row");
}

function resolve(
  source: Record<string, string>,
  opts: { fetch?: typeof fetch; store?: ReturnType<typeof memoryStore> } = {},
) {
  return resolveModules(source, {
    platform,
    store: opts.store || memoryStore(),
    fetch: opts.fetch || offline,
    where: "test",
  }).then((resolved) => resolved.modules);
}

/** Every import in the result points at a module in the result (or a workerd builtin). */
function expectLinked(modules: Record<string, string>) {
  for (const [name, code] of Object.entries(modules)) {
    expect(name).toMatch(/\.js$/);
    for (const imp of parse(code)[0]) {
      if (!imp.n || imp.n.startsWith("cloudflare:")) continue;
      expect(imp.n, `${name} → ${imp.n}`).toMatch(/^\.\.?\//);
      const dir = name.split("/").slice(0, -1);
      for (const part of imp.n.split("/"))
        if (part === "..") dir.pop();
        else if (part !== ".") dir.push(part);
      expect(Object.keys(modules), `${name} imports ${imp.n}`).toContain(dir.join("/"));
    }
  }
}

/** The modules module `name` imports, in the order it imports them (its specifiers are relative). */
function importedModules(modules: Record<string, string>, name: string) {
  return parse(modules[name]!)[0].map((imp) => {
    const dir = name.split("/").slice(0, -1);
    for (const part of imp.n!.split("/"))
      if (part === "..") dir.pop();
      else if (part !== ".") dir.push(part);
    return dir.join("/");
  });
}

/** A worker that imports @acme/sdk, listed in package.json at `url`. */
function sdkSource(url: string) {
  return {
    "worker.ts": `import { connect } from "@acme/sdk"; export default { fetch: () => new Response(connect()) };`,
    "package.json": JSON.stringify({ main: "worker.ts", dependencies: { "@acme/sdk": url } }),
  };
}
