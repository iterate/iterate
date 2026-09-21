// browser-root.e2e.test.ts — `itx.browser` is apps/os's Browser Run root: quickAction returns the
// action's RESULT, fetch is the raw binding. Locally the real binding is never called (shadowed).
// Against the deployed worker the last test screenshots inline HTML.

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { freshCtx, openItx, until } from "./support/client.ts";
import { deployedOnly } from "./support/project-host.ts";

class FakeBrowser extends RpcTarget {
  readonly calls: { action: string; options: unknown }[] = [];
  async quickAction(action: string, options: unknown) {
    this.calls.push({ action, options });
    if (action === "markdown") return "# fake";
    return { action, options };
  }
  fetch() {
    return new Response("fake-browser-fetch");
  }
}

test("provide('itx.browser', fake) shadows the binding; resolve ends at the stub; dispose restores the platform row", async () => {
  const ctx = freshCtx("browser-shadow");
  const itx = openItx(ctx);
  expect(await itx.rewriteRules.get("itx.browser")).toMatchObject({
    match: "itx.browser",
    target: "itx.builtins.browser",
    context: "/",
  });
  const fake = new FakeBrowser();
  const handle = await itx.provide("itx.browser", fake);
  expect(await itx.browser.quickAction("markdown", { url: "https://example.com" })).toBe("# fake");
  expect(fake.calls).toEqual([{ action: "markdown", options: { url: "https://example.com" } }]);
  expect(await itx.rewriteRules.resolve("itx.browser.quickAction")).toEqual([
    "itx.browser.quickAction",
    "itx.builtins.rpcStubs.get('itx.browser').quickAction",
  ]);
  handle[Symbol.dispose]();
  await until("the platform row is back", async () => {
    const row = await itx.rewriteRules.get("itx.browser");
    return row?.target === "itx.builtins.browser" ? row : undefined;
  });
  expect(await itx.rewriteRules.get("itx.browser")).toMatchObject({
    match: "itx.browser",
    target: "itx.builtins.browser",
    context: "/",
  });
});

deployedOnly(
  "DEPLOYED: Browser Run screenshots inline HTML at 480×640",
  async () => {
    const ctx = freshCtx("browser-real");
    const itx = openItx(ctx);
    const png = await itx.browser.quickAction("screenshot", {
      html: "<!doctype html><title>x</title><body>Tuesday</body>",
      viewport: { width: 480, height: 640 },
    });
    const bytes = png instanceof Uint8Array ? png : Uint8Array.from(png as Iterable<number>);
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(bytes.byteLength).toBeGreaterThan(100);
  },
  90_000,
);
