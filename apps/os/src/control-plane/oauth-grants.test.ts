// src/control-plane/oauth-grants.test.ts — the OAuth provider's grant table over node:sqlite
// (standing in for the control plane's SQLite): KV's read, expiry and list semantics, as the
// provider relies on them. The provider's own flows over it run on the worker
// (__workers-tests__/oauth.test.ts).
import { expect, test } from "vitest";
import { nodeSqliteDurableObjectStorage } from "iterate/stream/test-support";
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

test("a list is a range of the key's index: every key with the prefix and no other, whatever sorts next to it", () => {
  const storage = nodeSqliteDurableObjectStorage();
  const queries: { query: string; bindings: unknown[] }[] = [];
  const grants = new OAuthGrantTable({
    exec: (query: string, ...bindings: unknown[]) => {
      queries.push({ query, bindings });
      return storage.sql.exec(query, ...bindings);
    },
  } as typeof storage.sql);
  // the keys either side of the range: `9` and `;` sort just before and just after `:`
  for (const key of ["grant:user_a9", "grant:user_a:g1", "grant:user_a:~", "grant:user_a;g1"])
    grants.put(key, "{}", null, NOW);
  expect(grants.list("grant:user_a:", {}, NOW)).toEqual({
    keys: [{ name: "grant:user_a:g1" }, { name: "grant:user_a:~" }],
    list_complete: true,
  });
  // SQLite searches the key's index for the range; it reads no row outside it
  const listing = queries.at(-1)!;
  const [plan] = storage.sql
    .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${listing.query}`, ...listing.bindings)
    .toArray();
  expect(plan!.detail).toMatch(/^SEARCH oauth_grants USING INDEX \S+ \(key>\? AND key<\?\)$/);
  // a cursor before the prefix starts at the prefix; one past the range answers nothing
  expect(grants.list("grant:user_a:", { cursor: "grant:" }, NOW).keys).toHaveLength(2);
  expect(grants.list("grant:user_a:", { cursor: "grant:user_a;" }, NOW)).toEqual({
    keys: [],
    list_complete: true,
  });
});
