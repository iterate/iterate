// ai-root-shadow-and-fable.e2e.test.ts — `itx.ai` IS THE FIRST BINDINGS ROOT: Cloudflare's Workers AI
// binding, verbatim (`run(model, inputs, options?)`, `models()`, `gateway(id).run(req)`, …), under the
// reserved root as `itx.builtins.ai` and reached as `itx.ai` through its platform row. So a test can
// SHADOW it with a deterministic stub (`provide("itx.ai", fake)`) — Misha's test on the real root —
// and THE DREAM is one rewrite rule: `itx.fable ⇒ itx.ai.run('@cf/…', @)` pins the model, and `@`
// (rule 7) is the caller's input — spliced as an argument, the one argument when nested, its fields
// merged by `...@` under the template's own keys (a pinned gateway model cannot be talked out of).
// Locally the real binding is never called: every call lands on the fake. Against the deployed worker
// (WORKER_BASE_URL not local) the last test asks the real binding for `models()` and runs ONE
// inference through `itx.fable`.

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { codeOf, freshCtx, openItx, rejection, until } from "./support/client.ts";

const MODEL = "@cf/meta/llama-3.2-1b-instruct";

/** The binding's gateway half, as an RpcTarget so the DO's mid-chain `.run(req)` rides back here. */
class FakeAiGateway extends RpcTarget {
  readonly #id: string;
  constructor(id: string) {
    super();
    this.#id = id;
  }
  run(request: unknown) {
    return { gateway: this.#id, request };
  }
}

/** A deterministic `env.AI`: the same three doors, canned answers, every call recorded. */
class FakeAi extends RpcTarget {
  readonly calls: { model: string; inputs: unknown; options?: unknown }[] = [];
  run(model: string, inputs: unknown, options?: unknown) {
    this.calls.push({ model, inputs, options });
    return { response: `deterministic:${model}`, inputs };
  }
  gateway(id: string) {
    return new FakeAiGateway(id);
  }
  models() {
    return [{ name: "@cf/fake/model" }];
  }
}

test("MISHA'S TEST on the real root: provide('itx.ai', fake) shadows the binding; resolve ends at the stub; dispose restores the platform row", async () => {
  const ctx = freshCtx("ai-shadow");
  const itx = openItx(ctx);
  expect(await itx.rewriteRules.get("itx.ai")).toEqual({
    match: "itx.ai",
    target: "itx.builtins.ai",
    origin: "platform",
  });
  const fake = new FakeAi();
  const handle = await itx.provide("itx.ai", fake);
  expect(await itx.ai.run("@cf/x", { prompt: "hi" })).toEqual({
    response: "deterministic:@cf/x",
    inputs: { prompt: "hi" },
  });
  expect(fake.calls).toEqual([{ model: "@cf/x", inputs: { prompt: "hi" }, options: undefined }]);
  expect(await itx.ai.models()).toEqual([{ name: "@cf/fake/model" }]);
  expect(await itx.rewriteRules.resolve("itx.ai.run")).toEqual([
    "itx.ai.run",
    "itx.builtins.rpcStubs.get('itx.ai').run",
  ]);
  handle[Symbol.dispose]();
  // the DO un-sets the row when the stub's last pager closes — the platform row shows through again
  // (asserted through the TABLE: the real binding is never called locally)
  await until("the platform row is back", async () => {
    const row = await itx.rewriteRules.get("itx.ai");
    return row?.origin === "platform" ? row : undefined;
  });
  expect(await itx.rewriteRules.get("itx.ai")).toEqual({
    match: "itx.ai",
    target: "itx.builtins.ai",
    origin: "platform",
  });
});

test("THE DREAM: `itx.fable ⇒ itx.ai.run('@cf/…', @)` pins the model; the caller's inputs (and options) fill `@`; the row is string-at-rest with `@` in it", async () => {
  const ctx = freshCtx("fable");
  const itx = openItx(ctx);
  const fake = new FakeAi();
  await itx.provide("itx.ai", fake);
  await itx.provide("itx.fable", `itx.ai.run('${MODEL}', @)`);
  expect(await itx.rewriteRules.get("itx.fable")).toEqual({
    match: "itx.fable",
    target: `itx.ai.run('${MODEL}',@)`,
    origin: "context",
  });
  expect(await itx.fable({ prompt: "hi" })).toEqual({
    response: `deterministic:${MODEL}`,
    inputs: { prompt: "hi" },
  });
  await itx.fable({ prompt: "again" }, { gateway: { id: "g" } });
  expect(fake.calls).toEqual([
    { model: MODEL, inputs: { prompt: "hi" }, options: undefined },
    { model: MODEL, inputs: { prompt: "again" }, options: { gateway: { id: "g" } } },
  ]);
  // the pure chain shows `@` filled, and the law holds through a template rule
  const chain = (await itx.rewriteRules.resolve("itx.fable({ prompt: 'hi' })")) as string[];
  expect(chain).toEqual([
    "itx.fable({prompt:'hi'})",
    `itx.ai.run('${MODEL}',{prompt:'hi'})`,
    `itx.builtins.rpcStubs.get('itx.ai').run('${MODEL}',{prompt:'hi'})`,
  ]);
  expect(await itx.invoke(chain.at(-1)!)).toEqual(await itx.invoke("itx.fable({ prompt: 'hi' })"));
  // a property access on the match (a string invoke with no call — the sugar's bare `itx.fable` is a
  // capnweb path, not a call): `@` DROPS and the pinned call runs as is
  expect(fake.calls).toHaveLength(4);
  await itx.invoke("itx.fable");
  expect(fake.calls).toHaveLength(5);
  expect(fake.calls.at(-1)).toEqual({ model: MODEL, inputs: undefined, options: undefined });
});

test("THE GATEWAY SHAPE: `...@` merges the caller's fields under a pinned model (the template wins); a nested `@` takes exactly one argument", async () => {
  const ctx = freshCtx("gateway");
  const itx = openItx(ctx);
  await itx.provide("itx.ai", new FakeAi());
  await itx.provide(
    "itx.claude",
    "itx.ai.gateway('g').run({ provider: 'anthropic', endpoint: 'v1/messages', query: { model: 'claude-x', ...@ } })",
  );
  expect(await itx.rewriteRules.get("itx.claude")).toMatchObject({
    target:
      "itx.ai.gateway('g').run({endpoint:'v1/messages',provider:'anthropic',query:{...@,model:'claude-x'}})",
  });
  expect(await itx.claude({ messages: [{ role: "user", content: "hi" }], model: "evil" })).toEqual({
    gateway: "g",
    request: {
      provider: "anthropic",
      endpoint: "v1/messages",
      query: { messages: [{ role: "user", content: "hi" }], model: "claude-x" },
    },
  });
  const twoArgs = await rejection(itx.claude({ messages: [] }, { extra: true }));
  expect(String((twoArgs as Error).message)).toMatch(/takes exactly one argument, got 2/);
  const notAnObject = await rejection(itx.claude("just a string"));
  expect(String((notAnObject as Error).message)).toMatch(/merges an object/);
});

test("the door end to end: `@` is refused in a match, in a call, and outside a target's final step", async () => {
  const ctx = freshCtx("at-door");
  const itx = openItx(ctx);
  expect(String((await rejection(itx.provide("itx.a(@)", "itx.kv"))).message)).toMatch(
    /legal only in a rewrite rule's target/,
  );
  expect(String((await rejection(itx.provide("itx.x", "itx.ai.run(@).then"))).message)).toMatch(
    /legal only in the target's FINAL step/,
  );
  expect(String((await rejection(itx.invoke("itx.kv.get(@)"))).message)).toMatch(
    /legal only in a rewrite rule's target/,
  );
  // …and a masked `itx.ai` refuses the dream, coded, while `itx.builtins.ai` is the physical door
  await itx.provide("itx.fable", `itx.ai.run('${MODEL}', @)`);
  await itx.provide("itx.ai", null);
  expect(codeOf(await rejection(itx.fable({ prompt: "hi" })))).toBe("NO_ITX_EXPRESSION_MATCH");
});

// DEPLOYED-TARGET MODE only (support/global-setup.ts): a local boot never calls the real binding.
test.skipIf(/^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(process.env.WORKER_BASE_URL ?? ""))(
  "DEPLOYED: the real binding answers models(); the dream runs ONE real inference through `itx.fable`",
  async () => {
    const ctx = freshCtx("ai-real");
    const itx = openItx(ctx);
    const models = await itx.ai.models();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    await itx.provide("itx.fable", `itx.ai.run('${MODEL}', @)`);
    const out = await itx.fable({ prompt: "Reply with the single word: pong" });
    expect(typeof out?.response).toBe("string");
  },
  90_000,
);
