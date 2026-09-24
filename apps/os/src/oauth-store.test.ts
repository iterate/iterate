// src/oauth-store.test.ts — the provider's store over a fake control plane: a grant call cut at the
// transport (what a deploy's reset of the control plane's Durable Object does to a call in flight)
// is asked once more, on a fresh stub, and logged as a platform failure the prd fault alarm counts.
import { expect, onTestFinished, test, vi } from "vitest";
import { providerStore } from "./oauth-store.ts";

test("a grant read cut at the transport is asked once more on a fresh stub, and logged as a platform failure", async () => {
  const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => {
    warns.mockRestore();
  });
  const store = storeOver([
    () => Promise.reject(transportCut()),
    () => Promise.resolve('{"id":"g1"}'),
  ]);
  expect(await store.get("grant:user_a:g1", { type: "json" })).toEqual({ id: "g1" });
  expect(warns).toHaveBeenCalledExactlyOnceWith({
    event: "oauth.platform-failure-grant-store-retry",
    name: "grant-store-get",
    message: expect.stringContaining("Durable Object reset"),
  });
});

test("a second cut throws: the grant store never retries twice", async () => {
  const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => {
    warns.mockRestore();
  });
  const store = storeOver([
    () => Promise.reject(transportCut()),
    () => Promise.reject(transportCut()),
    () => Promise.resolve('{"id":"never read"}'),
  ]);
  await expect(store.get("grant:user_a:g1", { type: "json" })).rejects.toThrow(
    /Durable Object reset/,
  );
  expect(warns).toHaveBeenCalledTimes(1);
});

test("a refusal that is no transport failure is not asked again", async () => {
  const store = storeOver([
    () => Promise.reject(new Error("no such table: oauth_grants")),
    () => Promise.resolve('{"id":"never read"}'),
  ]);
  await expect(store.get("grant:user_a:g1", "text")).rejects.toThrow(/no such table/);
});

/** The store over a control plane whose every stub answers `oauthGrant` with the next of
 *  `answers` (edge.ts takes a fresh stub after a transport failure). KV is never reached. */
function storeOver(answers: (() => Promise<string>)[]) {
  const namespace = {
    getByName: () => ({ oauthGrant: () => answers.shift()!() }),
  };
  return providerStore({
    CONTROL_PLANE: namespace as never,
    OAUTH_KV: {} as KVNamespace,
  });
}

/** What workerd throws for a call a Durable Object reset cut (retryable-error.ts). */
function transportCut() {
  return Object.assign(new Error("Durable Object reset because its code was updated."), {
    retryable: true,
  });
}
