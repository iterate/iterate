// A direct build consumes only source bytes and returns inert native loader input. It does not load
// the worker: contextual ITX and fetch authority are added only by `workers.load` afterwards.

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

test("builds direct source bytes and caches the complete input", async () => {
  const projectId = freshCtx("build");
  const itx = openItx(projectId);
  const input = {
    files: {
      // A deployed content-addressed cache survives test runs. Fresh input proves a real miss,
      // then exactly the same bytes prove a hit; the project itself is not part of the cache key.
      "src/message.ts": `// Test run ${projectId}\nexport const message: string = "hello from a direct build";`,
      "src/main.ts": `import { WorkerEntrypoint } from "cloudflare:workers";
import { message } from "./message";
export default class App extends WorkerEntrypoint {
  describe() { return message; }
}`,
    },
    options: { entryPoint: "src/main.ts" },
  };
  const first = await itx.build(input);
  expect(first).toMatchObject({ status: "built", cache: "miss" });
  expect(first.code.mainModule).toBeTruthy();
  expect(first.code.modules).toHaveProperty(first.code.mainModule);

  const repeat = await itx.build(input);
  expect(repeat).toMatchObject({ status: "built", cache: "hit", key: first.key });
  expect(repeat.code).toEqual(first.code);

  const minified = await itx.build({
    ...input,
    options: { ...input.options, minify: true },
  });
  expect(minified).toMatchObject({ status: "built" });
  expect(minified.key).not.toBe(first.key);
});

test("builds a pinned repository revision, then loads it with the establishing context", async () => {
  const projectId = freshCtx("repo-build");
  const itx = openItx(projectId).cd("/documents/draft");
  const revision = await itx.repos.get("/application").commit({
    files: {
      "src/message.ts": 'export const message = "from an immutable revision";',
      "src/main.ts": `import { WorkerEntrypoint } from "cloudflare:workers";
import { message } from "./message";
export default class App extends WorkerEntrypoint {
  async describe() {
    return { message, context: await this.env.ITX.get().whoami() };
  }
}`,
    },
    parent: null,
    message: "buildable application",
  });

  const built = await itx.build({
    source: { repo: "/application", revision: revision.revision },
    options: { entryPoint: "src/main.ts" },
  });
  expect(built).toMatchObject({ status: "built" });
  if (built.status !== "built") throw new Error(`build rejected: ${built.diagnostics.join("\n")}`);

  expect(await itx.workers.load(built.code).describe()).toEqual({
    message: "from an immutable revision",
    context: { projectId, path: "/documents/draft" },
  });
});

test("returns malformed TypeScript as source diagnostics instead of a worker defect", async () => {
  const itx = openItx(freshCtx("build-diagnostics"));
  const result = await itx.build({
    files: {
      "src/main.ts": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class App extends WorkerEntrypoint {
  describe() { const = "broken"; }
}`,
    },
    options: { entryPoint: "src/main.ts" },
  });
  expect(result.status).toBe("rejected");
  expect(result.diagnostics.join("\n")).toMatch(/error|unexpected|expected/i);
});

test("checks submitted code against the actual contextual ITX declaration surface", async () => {
  const itx = openItx(freshCtx("check"));
  const good = await itx.check({
    files: {
      "src/good.ts": `import { WorkerEntrypoint } from "cloudflare:workers";
import type { ItxEnv } from "itx";
export default class App extends WorkerEntrypoint<ItxEnv> {
  async describe() {
    const itx = await this.env.ITX.get();
    const page = await itx.cd("/review").readEvents();
    return page.events.length;
  }
}`,
    },
    options: { entryPoint: "src/good.ts" },
  });
  expect(good).toEqual({ status: "checked", diagnostics: [] });

  const bad = await itx.check({
    files: {
      "src/bad.ts": `import { WorkerEntrypoint } from "cloudflare:workers";
import type { ItxEnv } from "itx";
export default class App extends WorkerEntrypoint<ItxEnv> {
  async describe() {
    const itx = await this.env.ITX.get();
    await itx.append({ type: 42 });
    return itx.cd("/review").imaginary();
  }
}`,
    },
    options: { entryPoint: "src/bad.ts" },
  });
  expect(bad.status).toBe("rejected");
  expect(bad.diagnostics).toContainEqual(
    expect.objectContaining({
      file: "src/bad.ts",
      code: 2339,
      message: expect.stringMatching(/imaginary/),
    }),
  );
  expect(bad.diagnostics).toContainEqual(
    expect.objectContaining({
      file: "src/bad.ts",
      code: 2322,
      message: expect.stringMatching(/number/),
    }),
  );
});
