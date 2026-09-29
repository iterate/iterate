// ai-root-shadow-and-fable.e2e.test.ts — `itx.ai` is a root: Workers AI's
// `run(model, inputs, options?)` and `models()` (apps/os/src/itx-ai.ts), under the reserved root as
// `itx.builtins.ai` and reached as `itx.ai` through its platform row. So a test can
// SHADOW it with a deterministic stub (`provide("itx.ai", fake)`) — Misha's test on the real root —
// Locally the real binding is never called: every call lands on the fake. Against the deployed worker
// (WORKER_BASE_URL not local) with E2E_REAL_MODELS=1, the daily real-model suite asks the real
// binding for `models()` and runs one inference directly.

import { expect, test } from "vitest";
import { freshCtx, openItx, until } from "./support/client.ts";
import { FakeAi, type FakeAiReply } from "./support/fake-ai.ts";
import { realModelOnly } from "./support/project-host.ts";

test("MISHA'S TEST on the real root: provide('itx.ai', fake) shadows the binding; resolve ends at the stub; dispose restores the platform row", async () => {
  const ctx = freshCtx("ai-shadow");
  const itx = openItx(ctx);
  expect(await itx.rewriteRules.get("itx.ai")).toMatchObject({
    match: "itx.ai",
    target: "itx.builtins.ai",
    context: "/",
  });
  const fake = new FakeAi([deterministic]);
  const handle = await itx.provide("itx.ai", fake);
  expect(await itx.ai.run("@cf/x", { prompt: "hi" })).toEqual({
    response: "deterministic:@cf/x",
    inputs: { prompt: "hi" },
  });
  expect(fake).toMatchObject({
    calls: [{ model: "@cf/x", inputs: { prompt: "hi" }, options: undefined }],
  });
  expect(await itx.ai.models()).toEqual([{ name: "@cf/fake/model" }]);
  expect(await itx.rewriteRules.resolve("itx.ai.run")).toEqual([
    "itx.ai.run", // resolve() PRINTS
    "itx.builtins.rpcStubs.get('itx.ai').run",
  ]);
  handle[Symbol.dispose]();
  // the DO un-sets the row when the stub's last pager closes — the platform row shows through again
  // (asserted through the TABLE: the real binding is never called locally)
  await until("the platform row is back", async () => {
    const row = await itx.rewriteRules.get("itx.ai");
    return row?.target === "itx.builtins.ai" ? row : undefined;
  });
  expect(await itx.rewriteRules.get("itx.ai")).toMatchObject({
    match: "itx.ai",
    target: "itx.builtins.ai",
    context: "/",
  });
});

// DEPLOYED-TARGET MODE only (support/global-setup.ts): a local boot never calls the real binding. A paid
// inference, so only the daily real-model suite runs it (docs/testing.md#real-model-rows).
realModelOnly(
  "REAL: the real binding answers models() and runs one real inference",
  async () => {
    const ctx = freshCtx("ai-real");
    const itx = openItx(ctx);
    const models = await itx.ai.models();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    const out = await itx.ai.run("@cf/meta/llama-3.2-1b-instruct", {
      prompt: "Reply with the single word: pong",
    });
    expect(typeof out?.response).toBe("string");
  },
  90_000,
);

/** A canned answer naming the model, the inputs handed back. */
const deterministic: FakeAiReply = ({ model, inputs }) => ({
  response: `deterministic:${model}`,
  inputs,
});
