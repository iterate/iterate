// context/module-resolution.test.ts — authored source → loader modules, with no build step. The rows
// pin: TypeScript is stripped and every module name ends in `.js`; relative imports resolve with or
// without extensions and only what the entry reaches is loaded — the entry being package.json's
// `main`, else worker.ts, worker.js, index.ts or index.js; `iterate/*` and zod link the
// deployment's own SDK modules (and only the chunks they reach), and a subpath of either the
// platform does not ship is refused;
// npm imports are crawled from esm.sh ONCE per dependency set and locked in the store (a second
// resolution fetches nothing), with esm.sh's own quirks (builtins as paths, cycles, the platform
// packages left external) handled; and what cannot work in a loaded worker is refused by name. Like
// tsc, stripping elides an import whose bindings are never used as values.
import { parse } from "es-module-lexer/js";
import { expect, test } from "vitest";
import { resolveModules, type PlatformModules } from "./module-resolution.ts";

const platform: PlatformModules = {
  modules: {
    "node_modules/iterate/sdk.js": `import{z}from"../.platform/chunk-a.js";export const sdk="sdk";export{z};`,
    "node_modules/iterate/lib.js": `export const lib="lib";`,
    "node_modules/zod.js": `export*from"./.platform/chunk-a.js";`,
    "node_modules/.platform/chunk-a.js": `export const z="zod";`,
    "node_modules/.platform/chunk-unused.js": `export const nope=1;`,
  },
  imports: {
    "node_modules/iterate/sdk.js": ["node_modules/.platform/chunk-a.js"],
    "node_modules/iterate/lib.js": [],
    "node_modules/zod.js": ["node_modules/.platform/chunk-a.js"],
    "node_modules/.platform/chunk-a.js": [],
    "node_modules/.platform/chunk-unused.js": [],
  },
};

test("TypeScript is stripped, siblings resolve by any spelling, only what the entry reaches loads", async () => {
  const modules = await resolve({
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

test.each([
  ["a missing sibling", { "worker.js": `import "./nope.js";` }, /no such file/],
  [
    "a computed dynamic import",
    { "worker.js": "const m = 'x'; await import(m);" },
    /computed specifier/,
  ],
  ["a URL import", { "worker.js": `import "https://esm.sh/zod";` }, /import packages by name/],
  [
    "an iterate subpath the platform does not ship",
    { "worker.js": `import "iterate/node";` },
    /iterate\/node is not a module loaded workers have \(the platform ships .*iterate\/sdk.*\)/,
  ],
  [
    "a zod subpath the platform does not ship (a second zod)",
    {
      "worker.js": `import "zod/v4";`,
      "package.json": JSON.stringify({ dependencies: { zod: "4" } }),
    },
    /zod\/v4 is not a module loaded workers have/,
  ],
  ["no entry", { "lib.js": "", "README.md": "# hi" }, /no entry/],
  [
    "a package not in package.json dependencies (never `latest`, never locked for everyone)",
    {
      "worker.js": `import "hono";`,
      "package.json": JSON.stringify({ devDependencies: { hono: "4" } }),
    },
    /imports hono; list hono in package\.json "dependencies"/,
  ],
  [
    "a Node.js builtin in the author's own module",
    { "worker.js": `import { Buffer } from "node:buffer"; export default Buffer;` },
    /imports the Node\.js builtin node:buffer/,
  ],
  [
    "a package.json main that is not a file",
    { "package.json": JSON.stringify({ main: "./src/app.ts" }), "worker.ts": "" },
    /main "\.\/src\/app\.ts" is not a file/,
  ],
])("refuses %s", async (_, source, message) => {
  await expect(resolve(source)).rejects.toThrow(message);
});

test.each([
  [
    "package.json's main",
    { "package.json": '{ "main": "./src/app.ts" }', "src/app.ts": "", "worker.ts": "" },
    "src/app.js",
  ],
  ["worker.ts before index.ts", { "index.ts": "", "worker.ts": "" }, "worker.js"],
  ["index.ts when there is no worker file", { "index.ts": "", "lib.ts": "" }, "index.js"],
])("the entry is %s", async (_, source, mainModule) => {
  const resolved = await resolveModules(source, {
    platform,
    store: memoryStore(),
    fetch: offline,
    where: "test",
  });
  expect(resolved).toMatchObject({ mainModule });
  expect(Object.keys(resolved.modules)).toEqual([mainModule]);
});

test("iterate/* and zod link this deployment's modules, and only the chunks they reach", async () => {
  const modules = await resolve({
    "worker.js": `import { sdk } from "iterate/sdk"; import { z } from "zod"; import "./nested/x.ts"; export default [sdk, z];`,
    "nested/x.ts": `import { lib } from "iterate/lib"; export default lib;`,
  });
  expect(modules["worker.js"]).toContain(`from "./node_modules/iterate/sdk.js"`);
  expect(modules["nested/x.js"]).toContain(`from "../node_modules/iterate/lib.js"`);
  expect(Object.keys(modules)).not.toContain("node_modules/.platform/chunk-unused.js");
  expectLinked(modules);
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
    "package.json": JSON.stringify({ dependencies: { "lib-a": "^1.0.0" } }),
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

test.each([
  [
    "a Node builtin",
    { "/needs-node@1": `import "node:fs";` },
    /needs the Node\.js builtin node:fs/,
  ],
  ["a missing package", {}, /answered 404/],
])("refuses %s, naming it", async (_, files, message) => {
  const esm = fakeEsm(files);
  await expect(
    resolve(
      {
        "worker.js": `import "needs-node";`,
        "package.json": JSON.stringify({ dependencies: { "needs-node": "1" } }),
      },
      esm,
    ),
  ).rejects.toThrow(message);
});

test("esm.sh's own /node/ polyfills (capnweb's Buffer) load as ordinary modules", async () => {
  const esm = fakeEsm({
    "/uses-buffer@1": `import "/node/buffer.mjs"; export const b = 1;`,
    "/node/buffer.mjs": `export const Buffer = class {};`,
  });
  const modules = await resolve(
    {
      "worker.js": `import { b } from "uses-buffer"; export default b;`,
      "package.json": JSON.stringify({ dependencies: { "uses-buffer": "1" } }),
    },
    esm,
  );
  expect(Object.keys(modules)).toContain("node_modules/.esm/node/buffer.js");
  expectLinked(modules);
});

test("a pkg.pr.new version resolves through esm.sh's /pr/ route, a PR ref pinned to the commit pkg.pr.new serves; a URL naming another package is refused", async () => {
  const esm = fakeEsm({
    "/acme/shop/@acme/sdk@1234": { commit: "acme:shop:9f8e7d6c5b4a" },
    "/pr/acme/shop/@acme/sdk@9f8e7d6c5b4a": `export * from "/pr/acme/shop/@acme/sdk@9f8e7d6c5b4a/es2022/sdk.mjs";`,
    "/pr/acme/shop/@acme/sdk@9f8e7d6c5b4a/es2022/sdk.mjs": `export const connect = () => "shop";`,
  });
  const source = (url: string) => ({
    "worker.ts": `import { connect } from "@acme/sdk"; export default { fetch: () => new Response(connect()) };`,
    "package.json": JSON.stringify({ dependencies: { "@acme/sdk": url } }),
  });
  const modules = await resolve(source("https://pkg.pr.new/acme/shop/@acme/sdk@1234"), esm);
  expect(esm.fetched.slice(0, 2)).toEqual([
    "/acme/shop/@acme/sdk@1234",
    "/pr/acme/shop/@acme/sdk@9f8e7d6c5b4a?target=es2022&external=cloudflare%3Aemail%2Ccloudflare%3Asockets%2Ccloudflare%3Aworkers%2Citerate%2Czod",
  ]);
  expect(modules["worker.js"]).toContain(`from "./node_modules/@acme/sdk.js"`);
  expectLinked(modules);
  await expect(resolve(source("https://pkg.pr.new/acme/shop/other-sdk@1234"), esm)).rejects.toThrow(
    /lists @acme\/sdk as https:\/\/pkg\.pr\.new\/acme\/shop\/other-sdk@1234/,
  );
});

/** A fake esm.sh (path+query → module text) and pkg.pr.new (path → `{ commit }`, answered as its
 *  `x-commit-key` header). Records what was fetched. */
function fakeEsm(files: Record<string, string | { commit: string }>) {
  const fetched: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    // Newer URL parsers percent-encode `^` in a path (`lib-a@%5E1.0.0`); esm.sh reads either.
    const pathname = decodeURIComponent(url.pathname);
    fetched.push(pathname + url.search);
    const body = files[pathname + url.search] || files[pathname];
    if (!body) return new Response("not found", { status: 404 });
    if (typeof body !== "string")
      return new Response(null, { headers: { "x-commit-key": body.commit } });
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
