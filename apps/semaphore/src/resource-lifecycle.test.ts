import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { createSemaphoreClient } from "./contract.ts";

test("released tags describe only the next acquisition, never intervening use", async () => {
  await using app = await semaphoreFixture();
  const { resources } = app.client;
  await resources.add({ type: "preview", slug: "alpha", data: {} });
  const first = await resources.acquire({ type: "preview", leaseMs: 60_000 });
  await resources.release({ ...first, tags: { preparedAt: "1234" } });
  expect(await resources.list({ type: "preview" })).toMatchObject([
    { slug: "alpha", tags: { preparedAt: "1234" } },
  ]);
  expect(await resources.find({ type: "preview", slug: "alpha" })).toMatchObject({
    tags: { preparedAt: "1234" },
  });
  const prepared = await resources.acquire({ type: "preview", leaseMs: 60_000 });
  expect(prepared).toMatchObject({ slug: "alpha", tags: { preparedAt: "1234" } });
  await resources.release(prepared);
  expect(await resources.acquire({ type: "preview", leaseMs: 60_000 })).toMatchObject({ tags: {} });
});

test("adoption checks the holder atomically and invalidates the previous token", async () => {
  await using app = await semaphoreFixture();
  const { resources } = app.client;
  await resources.add({ type: "preview", slug: "alpha", data: {} });
  const first = await resources.acquire({ type: "preview", leaseMs: 60_000, holder: "pr-1" });
  expect(
    await resources.acquireSpecific({
      type: "preview",
      slug: "alpha",
      leaseMs: 60_000,
      expectedHolder: "pr-2",
      holder: "pr-2",
    }),
  ).toBeNull();
  const renewed = await resources.acquireSpecific({
    type: "preview",
    slug: "alpha",
    leaseMs: 60_000,
    expectedHolder: "pr-1",
    holder: "pr-1",
  });
  expect(renewed).toMatchObject({ holder: "pr-1", slug: "alpha", tags: {} });
  expect(await resources.release({ ...first, tags: { preparedAt: "1234" } })).toMatchObject({
    released: false,
  });
  expect(await resources.list({ type: "preview" })).toMatchObject([
    { leaseState: "leased", holder: "pr-1", tags: {} },
  ]);
});

test("simultaneous claims have one winner and inventory replacement loses preparation", async () => {
  await using app = await semaphoreFixture();
  const { resources } = app.client;
  await resources.add({ type: "preview", slug: "alpha", data: {} });
  const claims = await Promise.all(
    Array.from({ length: 4 }, () =>
      resources.acquireSpecific({ type: "preview", slug: "alpha", leaseMs: 60_000 }),
    ),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  await resources.release({ ...claims.find(Boolean)!, tags: { preparedAt: "1234" } });
  await resources.delete({ type: "preview", slug: "alpha" });
  await resources.add({ type: "preview", slug: "alpha", data: {} });
  expect(await resources.acquire({ type: "preview", leaseMs: 60_000 })).toMatchObject({ tags: {} });
});

/** Real HTTP contract and coordinator; only the already-authenticated admin context is supplied. */
async function semaphoreFixture() {
  const output = await build({
    stdin: {
      contents: `
        import { OpenAPIHandler } from '@orpc/openapi/fetch';
        import { appRouter } from './src/orpc/root.ts';
        export { ResourceCoordinator } from './src/durable-objects/resource-coordinator.ts';
        const handler = new OpenAPIHandler(appRouter);
        export default { async fetch(request, env) {
          const result = await handler.handle(request, { prefix: '/api', context: { principal: { isAdmin: true }, db: env.DB } });
          return result.response || new Response('Not found', {status: 404});
        }};
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "import"],
    external: ["cloudflare:*", "node:*"],
    tsconfig: "tsconfig.json",
  });
  const mf = new Miniflare({
    modules: true,
    script: output.outputFiles[0].text,
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    durableObjects: { RESOURCE_COORDINATOR: { className: "ResourceCoordinator", useSQLite: true } },
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const file of ["0001_init.sql", "0002_add_holder.sql"]) {
      await db.exec(
        (await readFile(`migrations/${file}`, "utf8")).replace(/--[^\n]*/g, "").replace(/\n/g, " "),
      );
    }
    return {
      client: createSemaphoreClient({ apiKey: "fixture", baseURL: (await mf.ready).toString() }),
      [Symbol.asyncDispose]: () => mf.dispose(),
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
