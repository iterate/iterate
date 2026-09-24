// src/oauth-store.test.ts — the provider's store over a fake control plane: a grant call cut at the
// transport is asked once more, on a fresh stub. A deploy's reset of the control plane's Durable
// Object is expected; any other cut is logged as a platform failure the prd fault alarm counts.
import { expect, onTestFinished, test, vi } from "vitest";
import { providerStore } from "./oauth-store.ts";

test.each([
  [
    "Durable Object reset because its code was updated.",
    "oauth.deploy-reset-grant-store-retry",
    "Error: Durable Object reset because its code was updated.",
  ],
  // any other cut is the platform's failure, which the edge's bounded read names (control-plane/edge.ts)
  [
    "Network connection lost.",
    "oauth.platform-failure-grant-store-retry",
    expect.stringMatching(
      /^ControlPlaneUnavailableError: The control plane failed oauthGrant after \d+ ms: Network connection lost\.$/,
    ),
  ],
])(
  "a grant read cut at the transport (%s) is asked once more on a fresh stub, and logged as %s",
  async (message, event, logged) => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => {
      warns.mockRestore();
    });
    const store = storeOver([
      () => Promise.reject(transportCut(message)),
      () => Promise.resolve('{"id":"g1"}'),
    ]);
    expect(await store.get("grant:user_a:g1", { type: "json" })).toEqual({ id: "g1" });
    expect(warns).toHaveBeenCalledExactlyOnceWith({
      event,
      name: "grant-store-get",
      message: logged,
    });
  },
);

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

/** What workerd throws for a call cut at the transport (retryable-error.ts): by default, a deploy's
 *  reset of the Durable Object. */
function transportCut(message = "Durable Object reset because its code was updated.") {
  return Object.assign(new Error(message), { retryable: true });
}
