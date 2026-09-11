import { expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import { freshCtx, openItx, rejection } from "./support/client.ts";

const entrypoint = (value: string) =>
  `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint { async value() { return ${JSON.stringify(value)}; } }`;

test("two literal sources with a djb2 collision never share a loaded worker", async () => {
  const itx = openItx(freshCtx("loader-collision"));
  // `Aa` and `B@` have the same old djb2 contribution: 65 × 33 + 97 = 66 × 33 + 64.
  // They must remain two distinct source identities, even in the same context and deployment.
  expect(
    await itx.invoke([
      "itx",
      "workers",
      ["get", { source: { "cap.js": entrypoint("Aa") } }],
      ["value"],
    ]),
  ).toBe("Aa");
  expect(
    await itx.invoke([
      "itx",
      "workers",
      ["get", { source: { "cap.js": entrypoint("B@") } }],
      ["value"],
    ]),
  ).toBe("B@");
});

test("native workers.load cacheKey reuses an unchanged loaded module", async () => {
  const itx = openItx(freshCtx("native-cache"));
  const code = {
    compatibilityDate: "2026-09-01",
    mainModule: "main.js",
    modules: {
      "main.js": {
        js: `import { WorkerEntrypoint } from "cloudflare:workers";
let calls = 0;
export default class extends WorkerEntrypoint { async next() { return ++calls; } }`,
      },
    },
  };
  const options = { cacheKey: "counter@1" };

  expect(await itx.workers.load(code, options).next()).toBe(1);
  expect(await itx.workers.load(code, options).next()).toBe(2);
});

test("native workers.load cacheKey also changes with its effective code", async () => {
  const itx = openItx(freshCtx("native-cache-code"));
  const code = (value: string) => ({
    compatibilityDate: "2026-09-01",
    mainModule: "main.js",
    modules: {
      "main.js": {
        js: `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint { async value() { return ${JSON.stringify(value)}; } }`,
      },
    },
  });
  const options = { cacheKey: "document@1" };

  expect(await itx.workers.load(code("before"), options).value()).toBe("before");
  expect(await itx.workers.load(code("after"), options).value()).toBe("after");
});

test("native workers.load cacheKey incorporates JSON module configuration", async () => {
  const itx = openItx(freshCtx("native-cache-json"));
  const code = (edition: number) => ({
    compatibilityDate: "2026-09-01",
    mainModule: "main.js",
    modules: {
      "main.js": {
        js: `import { WorkerEntrypoint } from "cloudflare:workers";
import settings from "./settings.json";
export default class extends WorkerEntrypoint { async edition() { return settings.edition; } }`,
      },
      "settings.json": { json: { edition } },
    },
  });
  const options = { cacheKey: "document@json" };

  expect(await itx.workers.load(code(1), options).edition()).toBe(1);
  expect(await itx.workers.load(code(2), options).edition()).toBe(2);
});

test("cached native loading refuses a live capability binding", async () => {
  const itx = openItx(freshCtx("native-cache-live"));
  class LiveBinding extends RpcTarget {
    hello() {
      return "hello";
    }
  }
  const error = await rejection(
    itx.workers
      .load(
        {
          compatibilityDate: "2026-09-01",
          mainModule: "main.js",
          modules: { "main.js": { js: "export default {}" } },
          env: { live: new LiveBinding() },
        },
        { cacheKey: "not-live" },
      )
      .value(),
  );

  expect(error.message).toMatch(/fresh loading/i);
});

test("native loader input retains modules, bindings and props, but ITX comes from the establishing context", async () => {
  const projectId = freshCtx("native");
  const itx = openItx(projectId).cd("/documents/draft");
  const code = {
    compatibilityDate: "2026-09-01",
    mainModule: "entry.mjs",
    modules: {
      "entry.mjs": {
        js: `import { WorkerEntrypoint } from "cloudflare:workers";
import label from "./label.txt";
import settings from "./settings.json";
export class DocumentWorker extends WorkerEntrypoint {
  async describe() {
    const context = await this.env.ITX.get().whoami();
    return { label, settings, greeting: this.env.GREETING, props: this.ctx.props, context };
  }
}`,
      },
      "label.txt": { text: "Draft" },
      "settings.json": { json: { collaborative: true } },
    },
    env: { GREETING: "Hello", ITX: "caller cannot choose the authority" },
  };
  const result = await itx.invoke([
    "itx",
    "workers",
    ["load", code, { className: "DocumentWorker", props: { theme: "paper" } }],
    ["describe"],
  ]);
  expect(result).toEqual({
    label: "Draft",
    settings: { collaborative: true },
    greeting: "Hello",
    props: { theme: "paper" },
    context: { projectId, path: "/documents/draft" },
  });
});

test("native workers use the same itx.fetch policy as caller requests", async () => {
  const itx = openItx(freshCtx("native_fetch"));
  class Policy extends RpcTarget {
    fetch(request: Request) {
      return new Response(`policy:${new URL(request.url).pathname}`);
    }
  }
  const policy = new Policy();
  await itx.provide("itx.fetch", policy.fetch.bind(policy));
  const code = {
    compatibilityDate: "2026-09-01",
    mainModule: "main.js",
    modules: {
      "main.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async request(url) { return await (await fetch(url)).text(); }
}`,
    },
    // The establishing context overrides even an explicit native outbound setting.
    globalOutbound: null,
  };
  expect(await itx.workers.load(code).request("https://example.invalid/documents")).toBe(
    "policy:/documents",
  );
  expect(await (await itx.fetch(new Request("https://example.invalid/documents"))).text()).toBe(
    "policy:/documents",
  );
});
