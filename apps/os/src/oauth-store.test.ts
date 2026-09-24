// src/oauth-store.test.ts — the provider's store over a fake control plane: a grant call cut at the
// transport is asked once more, on a fresh stub. A deploy's reset of the control plane's Durable
// Object is expected; any other cut is logged as a platform failure the prd fault alarm counts. A
// call that stalls is named while it waits.
import { expect, onTestFinished, test, vi } from "vitest";
import { providerStore } from "./oauth-store.ts";

test.each([
  [
    "Durable Object reset because its code was updated.",
    "oauth.deploy-reset-grant-store-retry",
    "Error: Durable Object reset because its code was updated.",
  ],
  // any other cut is the platform's failure, which the edge's read names (control-plane/edge.ts)
  [
    "Network connection lost.",
    "oauth.platform-failure-grant-store-retry",
    "ControlPlaneUnavailableError: The control plane failed oauthGrant: Network connection lost.",
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

test("a grant read or a KV write still waiting after five seconds names its step while it waits", async () => {
  vi.useFakeTimers();
  const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => {
    vi.useRealTimers();
    warns.mockRestore();
  });
  let answerGrant!: (value: string) => void;
  let confirmPut!: () => void;
  const store = providerStore({
    CONTROL_PLANE: {
      getByName: () => ({ oauthGrant: () => new Promise((r) => (answerGrant = r)) }),
    } as never,
    OAUTH_KV: { put: () => new Promise<void>((r) => (confirmPut = r)) } as unknown as KVNamespace,
  });
  const read = store.get("grant:user_a:g1", { type: "json" });
  const write = store.put("token:user_a:g1:t1", "{}", { expirationTtl: 3600 });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(warns).toHaveBeenCalledTimes(2);
  expect(warns).toHaveBeenNthCalledWith(1, {
    event: "oauth.step-slow",
    step: "grant-store-get",
    waitedMs: 5_000,
  });
  expect(warns).toHaveBeenNthCalledWith(2, {
    event: "oauth.step-slow",
    step: "kv-put",
    keyKind: "token",
    waitedMs: 5_000,
  });
  answerGrant('{"id":"g1"}');
  confirmPut();
  expect(await read).toEqual({ id: "g1" });
  await write;
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
