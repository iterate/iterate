import assert from "node:assert/strict";
import { test } from "node:test";
import type { Scope } from "../src/types.ts";
import { base, project, session, timeout } from "./support.ts";

test(
  "bundles pinned TypeScript, caches build inputs, and loads with fresh authority",
  { skip: !base, timeout },
  async () => {
    const id = project("build");
    using context = session<Scope>(id);
    const files = {
      "src/message.ts": `// ${id}\nexport const message: string = "Hello, bundled TypeScript";`,
      "src/main.ts": `import { WorkerEntrypoint } from "cloudflare:workers";
import { message } from "./message";
export default class App extends WorkerEntrypoint {
  async describe() { return [message, (await (await this.env.ITX.get()).inspect()).context.path]; }
}`,
    };
    await context.append({
      id: "source",
      type: "repo.commit",
      data: {
        name: "site",
        parent: null,
        message: "TypeScript app",
        files,
      },
    });
    const { revision } = (await context.invoke(["repos", "head"], "site")) as { revision: string };
    const input = { source: { repo: "site", revision }, options: { entryPoint: "src/main.ts" } };
    const first = await context.build.build(input);
    assert.equal(first.status, "built");
    if (first.status !== "built") return;
    assert.equal(first.cache, "miss");
    const cached = await context.build.build(input);
    assert.equal(cached.status, "built");
    if (cached.status !== "built") return;
    assert.equal(cached.cache, "hit");
    assert.equal(cached.key, first.key);
    assert.deepEqual(cached.code, first.code);
    const changed = await context.build.build({
      ...input,
      options: { ...input.options, minify: true },
    });
    assert.equal(changed.status, "built");
    if (changed.status !== "built") return;
    assert.notEqual(changed.key, first.key);
    using rootWorker = await context.load(first.code);
    using reviewWorker = await context.cd("/review").load(cached.code);
    assert.deepEqual(await rootWorker.invoke(["describe"]), ["Hello, bundled TypeScript", "/"]);
    assert.deepEqual(await reviewWorker.invoke(["describe"]), [
      "Hello, bundled TypeScript",
      "/review",
    ]);
  },
);

test(
  "returns source diagnostics without executing rejected builds",
  { skip: !base, timeout },
  async () => {
    using context = session<Scope>(project("build-rejected"));
    const sources: Record<string, Record<string, string>> = {
      syntax: { "main.ts": "export const broken: = ;" },
      missing: { "main.ts": 'import value from "not-installed"; export default value;' },
      registry: {
        "main.ts": "export default 1;",
        "package.json": '{"dependencies":{"zod":"latest"}}',
      },
    };
    for (const [name, files] of Object.entries(sources)) {
      await context.append({
        id: name,
        type: "repo.commit",
        data: { name, parent: null, message: name, files },
      });
      const { revision } = (await context.invoke(["repos", "head"], name)) as { revision: string };
      const result = await context.build.build({
        source: { repo: name, revision },
        options: { entryPoint: "main.ts" },
      });
      assert.equal(result.status, "rejected", name);
      assert.ok(result.diagnostics.length > 0);
      assert.ok(!("code" in result), "rejections do not return executable code");
    }
    assert.equal(
      (await context.readEvents()).events.length,
      3,
      "building must not execute or append to the project",
    );
  },
);
