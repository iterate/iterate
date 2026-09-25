// src/oauth-store.test.ts — the provider's store over a fake control-plane D1: a grant call D1 failed
// on the platform's side, and says to send again, is asked once more, its retry logged as a platform
// failure the prd fault alarm counts (beside the failure edge.ts logs); anything else throws at once.
// A call that stalls is named while it waits.
import { expect, onTestFinished, test, vi } from "vitest";
import { providerStore } from "./oauth-store.ts";

test.for([
  "D1_ERROR: Network connection lost.",
  "D1_ERROR: D1 DB reset because its code was updated.",
  "D1_ERROR: Internal error in D1 DB storage caused object to be reset.",
])("a grant read D1 says to send again (%s) is asked once more, and logged", async (message) => {
  const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => {
    warns.mockRestore();
  });
  const store = storeOver([
    () => Promise.reject(new Error(message)),
    () => Promise.resolve({ results: [{ value: '{"id":"g1"}' }] }),
  ]);
  expect(await store.get("grant:user_a:g1", { type: "json" })).toEqual({ id: "g1" });
  expect(retries(warns)).toEqual([
    {
      event: "oauth.platform-failure-grant-store-retry",
      name: "grant-store-get",
      message: `ControlPlaneUnavailableError: The control plane failed oauthGrant: ${message}`,
    },
  ]);
});

test("a second failure throws: the grant store never retries twice", async () => {
  const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => {
    warns.mockRestore();
  });
  const store = storeOver([
    () => Promise.reject(new Error("D1_ERROR: Network connection lost.")),
    () => Promise.reject(new Error("D1_ERROR: Network connection lost.")),
    () => Promise.resolve({ results: [{ value: '{"id":"never read"}' }] }),
  ]);
  await expect(store.get("grant:user_a:g1", { type: "json" })).rejects.toThrow(
    /The control plane failed oauthGrant: D1_ERROR: Network connection lost/,
  );
  expect(retries(warns)).toHaveLength(1);
});

test.for([
  // the platform's, but not to be sent again: the query may still be queued
  ["D1_ERROR: D1 DB is overloaded. Requests queued for too long.", /failed oauthGrant/],
  // ours
  ["D1_ERROR: no such table: oauth_grants: SQLITE_ERROR", /failed oauthGrant: D1_ERROR: no such/],
] as const)("a grant read failing with %s is not asked again", async ([message, thrown]) => {
  const store = storeOver([
    () => Promise.reject(new Error(message)),
    () => Promise.resolve({ results: [{ value: '{"id":"never read"}' }] }),
  ]);
  await expect(store.get("grant:user_a:g1", "text")).rejects.toThrow(thrown);
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
    DB: fakeD1(() => new Promise((r) => (answerGrant = (value) => r({ results: [{ value }] })))),
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

/** The grant store's own retries among the warns. */
const retries = (warns: { mock: { calls: unknown[][] } }) =>
  warns.mock.calls
    .map(([entry]) => entry as { event?: string })
    .filter((entry) => entry.event?.startsWith("oauth."));

/** The store over a control-plane D1 whose every query answers with the next of `answers`. KV is
 *  never reached. */
function storeOver(answers: (() => Promise<{ results: unknown[] }>)[]) {
  return providerStore({ DB: fakeD1(() => answers.shift()!()), OAUTH_KV: {} as KVNamespace });
}

/** A D1 binding whose every statement's rows are `rows()`'s. */
function fakeD1(rows: () => Promise<{ results: unknown[] }>) {
  return { prepare: () => ({ bind: () => ({ all: rows }) }) } as unknown as D1Database;
}
