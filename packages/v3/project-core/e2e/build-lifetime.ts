import assert from "node:assert/strict";
import { test } from "node:test";
import type { Scope } from "../src/types.ts";
import { base, project, session, timeout } from "./support.ts";

test(
  "compares pipelined and explicitly disposed builder facets",
  { skip: !base, timeout },
  async () => {
    const id = project("build-lifetime");
    const started = new Date().toISOString();
    using context = session<Scope>(id);
    const files = {
      "src/message.ts": `// ${id}\nexport const message: string = "builder lifetime";`,
      "src/main.ts": 'import { message } from "./message"; export default { message };',
    };
    await context.append({
      id: "source",
      type: "repo.commit",
      data: { name: "site", parent: null, message: "builder lifetime", files },
    });
    const { revision } = (await context.invoke(["repos", "head"], "site")) as { revision: string };
    const input = { source: { repo: "site", revision }, options: { entryPoint: "src/main.ts" } };

    const pipelined = await context.build.build(input);
    assert.equal(pipelined.status, "built");
    if (pipelined.status !== "built") return;
    assert.equal(pipelined.cache, "miss");
    assert.equal(
      pipelined.code.modules[pipelined.code.mainModule]?.includes("builder lifetime"),
      true,
    );

    using builder = await context.build;
    const held = await builder.build(input);
    assert.equal(held.status, "built");
    if (held.status !== "built") return;
    assert.equal(held.cache, "hit");
    assert.equal(held.key, pipelined.key);
    assert.deepEqual(held.code, pipelined.code);

    const minified = await builder.build({ ...input, options: { ...input.options, minify: true } });
    assert.equal(minified.status, "built");
    if (minified.status !== "built") return;
    assert.equal(minified.cache, "miss");
    assert.notEqual(minified.key, pipelined.key);
    assert.ok(minified.code.modules[minified.code.mainModule]);
    console.log(JSON.stringify({ project: id, started, ended: new Date().toISOString() }));
  },
);
