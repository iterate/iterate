// iterate/no-raw-itx-get: code reaches its context with `using itx = this.getItx()`, never a raw
// `ITX.get()`, in a linted file or in a module it hands over as text (`"worker.js": `…``,
// `String.raw`, a const, a `/* js */` template), and a `getItx()` in a linted file is bound by
// `using` or answered whole by an accessor. Each row is one file in a temp project linted once by
// the real oxlint binary; `reported` is how many times the rule flags it.

import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

const rows = [
  // ── flagged: a scope nothing releases ──
  {
    name: "the old default template",
    reported: 1,
    source: "class W { async fetch() { return (await this.env.ITX.get().whoami()).projectSlug; } }",
  },
  {
    name: "a scope released by hand, its calls not",
    reported: 1,
    source:
      "async function f(env) { const itx = env.ITX.get(); try { return await itx.cd('/a').whoami(); } finally { itx[Symbol.dispose](); } }",
  },
  {
    name: "a live scope into a constructor",
    reported: 1,
    source: "class W { fetch() { return new Notes(this.env.ITX.get()); } }",
  },
  {
    name: "the LiveState sink closure",
    reported: 1,
    source:
      "class F { chat = new LiveState({ append: (e) => this.env.ITX.get().append(e) }, 'chat', {}); }",
  },
  { name: "optional chaining", reported: 1, source: "function f(env) { return env?.ITX?.get(); }" },
  {
    name: "a computed member",
    reported: 1,
    source: 'function f(env) { return env["ITX"].get(); }',
  },
  {
    name: "a type assertion",
    reported: 1,
    source: "function f(env: unknown) { return (env as any).ITX.get(); }",
  },
  {
    name: "a non-null assertion",
    reported: 1,
    source: "function f(env: { ITX?: { get(): unknown } }) { return env.ITX!.get(); }",
  },
  {
    name: "a destructured binding",
    reported: 1,
    source: "function f(env) { const { ITX } = env; return ITX.get(); }",
  },
  {
    name: "an embedded worker.js module",
    reported: 1,
    source: embeddedModule("  async run() { return (await this.env.ITX.get().whoami()).path; }"),
  },
  {
    name: "an embedded module with an interpolation",
    reported: 1,
    source:
      'export const hooked = (hook: string) => ({\n  "worker.js": `export default class { async run() { const itx = this.env.ITX.get(); return itx.${hook}.deliver(); } }`,\n});\n',
  },
  {
    name: "a /* js */ template",
    reported: 1,
    source:
      "export const SRC = /* js */ `export default class { run() { return this.env.ITX.get().whoami(); } }`;\n",
  },
  {
    name: "a String.raw module",
    reported: 1,
    source:
      'export const S = { "worker.js": String.raw`export default class { run() { return this.env.ITX.get().whoami(); } }` };\n',
  },
  {
    name: "a module held in a const without a marker",
    reported: 1,
    source:
      'const SRC = `export default class { run() { return this.env.ITX.get().whoami(); } }`;\nexport const S = { "worker.js": SRC };\n',
  },
  {
    name: "a getItx() scope held in a const",
    reported: 1,
    source: "class W { async f() { const itx = this.getItx(); return await itx.whoami(); } }",
  },
  {
    name: "a call chained on getItx()",
    reported: 1,
    source: "class W { f() { return this.getItx().whoami(); } }",
  },
  {
    name: "a getItx() scope passed on",
    reported: 1,
    source: "class W { f() { return new Notes(this.getItx()); } }",
  },
  {
    name: "an accessor's scope held in a let",
    reported: 1,
    source: "async function f(getItx) { let itx = getItx(); return await itx.whoami(); }",
  },
  {
    name: "two calls in one embedded module report once",
    reported: 1,
    source: embeddedModule(
      "  a() { return this.env.ITX.get().whoami(); }\n  b() { return this.env.ITX.get().whoami(); }",
    ),
  },
  // ── not flagged ──
  {
    name: "using getItx()",
    reported: 0,
    source: "class W { async fetch() { using itx = this.getItx(); return await itx.whoami(); } }",
  },
  {
    name: "await using, a typed getItx()",
    reported: 0,
    source:
      "type Itx = { whoami(): Promise<object> } & Disposable;\nclass W { getItx!: () => Itx; async f() { await using itx = (this.getItx() as Itx); return await itx.whoami(); } }\n",
  },
  {
    name: "an accessor",
    reported: 0,
    source: "class W { notes = new Notes(() => this.getItx()); }",
  },
  {
    name: "using an accessor's scope",
    reported: 0,
    source: "async function f(getItx) { using itx = getItx(); return await itx.whoami(); }",
  },
  {
    name: "the binding's fetch",
    reported: 0,
    source: "function f(env, request) { return env.ITX.fetch(request); }",
  },
  {
    name: "another binding's get",
    reported: 0,
    source: 'function f(env) { return env.KV.get("k"); }',
  },
  { name: "a map's get", reported: 0, source: "function f(map) { return map.get(); }" },
  {
    name: "the recording scope's own get",
    reported: 0,
    source: "function itxScope(entrypoint) { return record(entrypoint.get()); }",
  },
  { name: "a fake binding", reported: 0, source: "const env = { ITX: { get: () => ({}) } };\n" },
  {
    name: "an imported module text",
    reported: 0,
    source:
      'import { SDK_MODULE } from "./sdk-module.ts";\nexport const S = { "sdk.js": SDK_MODULE };\n',
  },
  {
    name: "a string that mentions ITX.get()",
    reported: 0,
    source: 'export const note = "never call env.ITX.get() yourself";\n',
  },
  {
    name: "an embedded module through getItx",
    reported: 0,
    source: embeddedModule(
      "  async run() { using itx = this.getItx(); return await itx.whoami(); }",
    ),
  },
  {
    name: "a disable above the module's key",
    reported: 0,
    source: `export const SOURCE = {\n  // oxlint-disable-next-line iterate/no-raw-itx-get -- the careless keep is the subject\n  "worker.js": \`export default class { run() { return this.env.ITX.get().whoami(); } }\`,\n};\n`,
  },
];

test("raw ITX.get() is refused wherever it hands out a scope, in a file and in the modules it embeds, and so is a getItx() no `using` binds; `using`, an accessor and other gets are not", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/no-raw-itx-get": "error" } });
  const paths = rows.map((_, i) => `row-${i}.ts`);
  rows.forEach((row, i) => fixture.write(paths[i]!, row.source));
  const diagnostics = fixture.diagnostics(paths);
  const reported = rows.map(
    (_, i) =>
      diagnostics.filter(
        (diagnostic) =>
          diagnostic.filename === paths[i] && diagnostic.code === "iterate(no-raw-itx-get)",
      ).length,
  );
  expect(Object.fromEntries(rows.map((row, i) => [row.name, reported[i]]))).toEqual(
    Object.fromEntries(rows.map((row) => [row.name, row.reported])),
  );
});

test("an embedded module's report names the lines of the module that call ITX.get()", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/no-raw-itx-get": "error" } });
  fixture.write(
    "module.ts",
    embeddedModule("  a() { return 1; }\n  b() { return this.env.ITX.get().whoami(); }"),
  );
  const [diagnostic] = fixture.diagnostics(["module.ts"]);
  expect(diagnostic).toMatchObject({
    code: "iterate(no-raw-itx-get)",
    message: expect.stringContaining("its line 4"),
    labels: [{ span: { line: 2 } }],
  });
});

/** A file whose module map hands over one `worker.js` module: a WorkerEntrypoint around `body`. */
function embeddedModule(body: string) {
  return `export const SOURCE = {\n  "worker.js": \`import { WorkerEntrypoint } from "cloudflare:workers";\nexport default class extends WorkerEntrypoint {\n${body}\n}\`,\n};\n`;
}
