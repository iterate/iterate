/**
 * The store's bounds (state.ts `MINTED_RECORDS_KEPT`): every change keeps the newest 500 minted
 * clients, revoked accounts and spent codes, so the one stored value stays small however many e2e
 * runs have used the shop.
 */
import { expect, test } from "vitest";
import { DEFAULT_CLIENT_ID, PetshopStore, type PetshopState } from "./state.ts";

test("a minted client past the newest 500 goes with its accounts' revocation epochs and token failures; others stay", async () => {
  const { store } = memoryStore();
  const first = await store.createClient({});
  await store.expireAccessTokens(first.clientId, "ada@example.com");
  await store.expireAccessTokens(first.clientId, "bo@example.com");
  await store.setTokenEndpointFailures(first.clientId, 2);
  await store.expireAccessTokens(DEFAULT_CLIENT_ID, "ada@example.com");
  await store.expireAccessTokens("graphql-session-login", "cy");
  const second = await store.createClient({});
  await store.expireAccessTokens(second.clientId, "bo@example.com");
  for (let index = 0; index < 499; index += 1) await store.createClient({});

  const state = await store.getState();
  expect(Object.keys(state.clients)).toHaveLength(501);
  expect(state.clients).not.toHaveProperty(first.clientId);
  expect(state.clients).toHaveProperty(DEFAULT_CLIENT_ID);
  expect(state.clients).toHaveProperty(second.clientId);
  expect(state).toMatchObject({
    accessTokenEpochs: {
      [`${DEFAULT_CLIENT_ID}:ada@example.com`]: 1,
      "graphql-session-login:cy": 1,
      [`${second.clientId}:bo@example.com`]: 1,
    },
  });
  // the dropped client's accounts' epochs are all gone
  expect(Object.keys(state.accessTokenEpochs)).toHaveLength(3);
  expect(Object.keys(state.tokenEndpointFailuresRemainingByClient)).toEqual([]);
});

test("an account's revocation epoch past the newest 500 goes, the least recently revoked first", async () => {
  const { store } = memoryStore();
  await store.expireAccessTokens("tesco-login", "a@example.com");
  await store.expireAccessTokens(DEFAULT_CLIENT_ID, "b@example.com");
  for (let index = 0; index < 498; index += 1)
    await store.expireAccessTokens("graphql-session-login", `user-${index}`);
  expect(await store.expireAccessTokens("tesco-login", "a@example.com")).toBe(2);
  await store.expireAccessTokens(DEFAULT_CLIENT_ID, "c@example.com");

  const { accessTokenEpochs } = await store.getState();
  expect(Object.keys(accessTokenEpochs)).toHaveLength(500);
  expect(accessTokenEpochs).toMatchObject({
    "tesco-login:a@example.com": 2,
    [`${DEFAULT_CLIENT_ID}:c@example.com`]: 1,
    "graphql-session-login:user-0": 1,
  });
  expect(accessTokenEpochs).not.toHaveProperty(`${DEFAULT_CLIENT_ID}:b@example.com`);
});

test("the newest 500 spent authorization codes are remembered, so a replay among them is refused", async () => {
  const { store } = memoryStore();
  for (let index = 0; index <= 500; index += 1)
    expect(await store.consumeAuthorizationCode(`code-${index}`)).toBe(true);
  expect(await store.consumeAuthorizationCode("code-500")).toBe(false);
  expect(await store.consumeAuthorizationCode("code-1")).toBe(false);

  const { usedAuthorizationCodeIds } = await store.getState();
  expect(usedAuthorizationCodeIds).toHaveLength(500);
  expect(usedAuthorizationCodeIds).not.toContain("code-0");
});

test("a state stored with more than the bounds keeps only the newest of each at its next change", async () => {
  const { store, blobs } = memoryStore();
  const state = await store.getState();
  for (let index = 0; index < 1_200; index += 1) {
    const clientId = `petshop-client-${index}`;
    state.clients[clientId] = { clientSecret: "s", accessTokenTtlSeconds: 120 };
    state.accessTokenEpochs[`${clientId}:ada`] = 1;
    state.accessTokenEpochs[`tesco-login:${index}@example.com`] = 1;
    state.usedAuthorizationCodeIds.push(`code-${index}`);
  }
  blobs.set("state", state);

  await store.revokeToken("any-token");

  const bounded = await store.getState();
  expect(Object.keys(bounded.clients)).toEqual([
    DEFAULT_CLIENT_ID,
    ...range(700, 1_200).map((index) => `petshop-client-${index}`),
  ]);
  // the dropped clients' epochs go first, then the oldest of the rest
  expect(Object.keys(bounded.accessTokenEpochs)).toEqual([
    ...range(950, 1_200).flatMap((index) => [
      `petshop-client-${index}:ada`,
      `tesco-login:${index}@example.com`,
    ]),
  ]);
  expect(bounded).toMatchObject({
    usedAuthorizationCodeIds: range(700, 1_200).map((index) => `code-${index}`),
  });
});

/** The store over a map, cloning values in and out as a Durable Object's storage does. */
function memoryStore() {
  const blobs = new Map<string, PetshopState>();
  const store = new PetshopStore({
    get: async <T>(key: string) => structuredClone(blobs.get(key)) as T | undefined,
    put: async (key, value) => void blobs.set(key, structuredClone(value as PetshopState)),
  });
  return { store, blobs };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => from + index);
