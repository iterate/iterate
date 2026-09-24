// src/control-plane/oauth-grants.test.ts — the OAuth provider's grant table over node:sqlite
// (standing in for the control plane's SQLite): KV's read, expiry and list semantics, as the
// provider relies on them. The provider's own flows over it run on the worker
// (__workers-tests__/oauth.test.ts).
import { expect, test } from "vitest";
import { nodeSqliteDurableObjectStorage } from "../stream/test-support.ts";
import { OAuthGrantTable } from "./oauth-grants.ts";

const NOW = 1_790_000_000;

test("a read answers the last write, whole", () => {
  const grants = new OAuthGrantTable(nodeSqliteDurableObjectStorage().sql);
  expect(grants.get("grant:user_a:g1", NOW)).toBeNull();
  grants.put("grant:user_a:g1", '{"authCodeId":"x"}', NOW + 600, NOW);
  expect(grants.get("grant:user_a:g1", NOW)).toBe('{"authCodeId":"x"}');
  // the code exchange rewrites the grant: its refresh token, and no expiry any more
  grants.put("grant:user_a:g1", '{"refreshTokenId":"r1"}', null, NOW);
  expect(grants.get("grant:user_a:g1", NOW + 10_000)).toBe('{"refreshTokenId":"r1"}');
  grants.delete("grant:user_a:g1");
  expect(grants.get("grant:user_a:g1", NOW)).toBeNull();
});

test("an expired grant reads as absent, lists as absent, and goes on the next write", () => {
  const storage = nodeSqliteDurableObjectStorage();
  const grants = new OAuthGrantTable(storage.sql);
  grants.put("grant:user_a:g1", "{}", NOW + 600, NOW);
  expect(grants.get("grant:user_a:g1", NOW + 599)).toBe("{}");
  expect(grants.get("grant:user_a:g1", NOW + 600)).toBeNull();
  expect(grants.list("grant:user_a:", {}, NOW + 600)).toEqual({ keys: [], list_complete: true });
  grants.put("grant:user_a:g2", "{}", null, NOW + 600);
  expect(storage.sql.exec("SELECT key FROM oauth_grants").toArray()).toEqual([
    { key: "grant:user_a:g2" },
  ]);
});

test("a list is one user's keys in key order, paged by cursor, with each one's expiry", () => {
  const grants = new OAuthGrantTable(nodeSqliteDurableObjectStorage().sql);
  for (const id of ["g3", "g1", "g2"]) grants.put(`grant:user_a:${id}`, "{}", null, NOW);
  grants.put("grant:user_a:g4", "{}", NOW + 600, NOW);
  // `_` is a LIKE wildcard: a prefix match must not reach user_ab's or userXa's grants
  grants.put("grant:user_ab:g1", "{}", null, NOW);
  grants.put("grant:userXa:g1", "{}", null, NOW);
  const first = grants.list("grant:user_a:", { limit: 3 }, NOW);
  expect(first).toEqual({
    keys: [{ name: "grant:user_a:g1" }, { name: "grant:user_a:g2" }, { name: "grant:user_a:g3" }],
    list_complete: false,
    cursor: "grant:user_a:g3",
  });
  expect(grants.list("grant:user_a:", { limit: 3, cursor: first.cursor }, NOW)).toEqual({
    keys: [{ name: "grant:user_a:g4", expiration: NOW + 600 }],
    list_complete: true,
  });
  expect(grants.list("grant:", {}, NOW).keys).toHaveLength(6);
});
