// principal.test.ts — the project token as a table: what verifies, what does not; the admin secret's
// compare; the project secret — minted as a key whose hash alone is stored, verified against it;
// and the session cookie — set, read back, refused.
import { expect, test } from "vitest";
import {
  cookieValueOf,
  rotateProjectApiKey,
  signClaims,
  signProjectToken,
  verifyAdminSecret,
  verifyProjectSecret,
  verifyProjectToken,
} from "./principal.ts";

const SECRET = "test-secret";
const NOW = 1_800_000_000_000;
const claims = {
  projectId: "prj-1",
  actor: "user_a",
  email: "a@example.com",
  expiresAt: NOW + 60_000,
};

test("a token round-trips its claims, email included", async () => {
  const token = await signClaims(claims, SECRET);
  expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(await verifyProjectToken(token, SECRET, NOW)).toEqual(claims);
});

test("a token without an email carries none", async () => {
  const { email: _email, ...bare } = claims;
  expect(await verifyProjectToken(await signClaims(bare, SECRET), SECRET, NOW)).toEqual(bare);
});

test("non-ASCII claims round-trip intact (the payload is UTF-8, decoded as such)", async () => {
  const unicode = { ...claims, actor: "user_élise", email: "élise@例え.jp" };
  expect(await verifyProjectToken(await signClaims(unicode, SECRET), SECRET, NOW)).toEqual(unicode);
});

const refusals: { title: string; token: () => Promise<string>; secret?: string; now?: number }[] = [
  { title: "the wrong secret", token: () => signClaims(claims, "other") },
  {
    title: "a blank secret verifies nothing",
    token: () => signClaims(claims, SECRET),
    secret: "",
  },
  { title: "expired", token: () => signClaims(claims, SECRET), now: claims.expiresAt },
  {
    title: "a tampered payload",
    token: async () => {
      const t = await signClaims(claims, SECRET);
      const [p, s] = t.split(".");
      return `${p.slice(0, -2)}AA.${s}`;
    },
  },
  {
    title: "a tampered signature",
    token: async () => (await signClaims(claims, SECRET)).slice(0, -1) + "A",
  },
  { title: "no dot", token: async () => "nodot" },
  { title: "not JSON", token: async () => "bm90LWpzb24.c2ln" },
  {
    title: "claims missing the actor",
    token: () => signClaims({ projectId: "prj-1", expiresAt: NOW + 1 } as never, SECRET),
  },
];
for (const { title, token, secret = SECRET, now = NOW } of refusals)
  test(`refused: ${title}`, async () => {
    expect(await verifyProjectToken(await token(), secret, now)).toBeNull();
  });

test("signProjectToken signs the claims with an expiry ttlMs from now; a ttl at or below zero mints a token that never verifies", async () => {
  const before = Date.now();
  const token = await signProjectToken({ projectId: "prj-1", actor: "user_a" }, 60_000, SECRET);
  const verified = await verifyProjectToken(token, SECRET);
  expect(verified?.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
  expect(verified?.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  expect(
    await verifyProjectToken(
      await signProjectToken({ projectId: "prj-1", actor: "user_a" }, -1, SECRET),
      SECRET,
    ),
  ).toBeNull();
});

// ── the admin secret ── `verifyAdminSecret(candidate, secret)`: `{ candidate, secret, becomes }` rows.
const adminRows: { candidate: string; secret: string; becomes: boolean }[] = [
  { candidate: "s3cret", secret: "s3cret", becomes: true },
  { candidate: "s3cret ", secret: "s3cret", becomes: false }, // exact, untrimmed
  { candidate: "s3cre", secret: "s3cret", becomes: false }, // a prefix
  { candidate: "", secret: "s3cret", becomes: false },
  { candidate: "s3cret", secret: "", becomes: false }, // a blank secret matches nothing
  { candidate: "", secret: "", becomes: false },
];
for (const { candidate, secret, becomes } of adminRows)
  test(`verifyAdminSecret(${JSON.stringify(candidate)}, ${JSON.stringify(secret)}) ⇒ ${becomes ? '{ actor: "admin" }' : "null"}`, async () => {
    expect(await verifyAdminSecret(candidate, secret)).toEqual(becomes ? { actor: "admin" } : null);
  });

const cookieRows: { header: string | null; name: string; becomes: string | null }[] = [
  { header: null, name: "a", becomes: null },
  { header: "a=1", name: "a", becomes: "1" },
  { header: "b=2; a=x=y", name: "a", becomes: "x=y" }, // a value may hold `=`
  { header: "a=", name: "a", becomes: "" },
  { header: "ab=1", name: "a", becomes: null }, // the whole name
  { header: "a", name: "a", becomes: null }, // no `=`: not a cookie
];
for (const { header, name, becomes } of cookieRows)
  test(`cookieValueOf(${JSON.stringify(header)}, ${JSON.stringify(name)}) ⇒ ${JSON.stringify(becomes)}`, () => {
    expect(cookieValueOf(header, name)).toBe(becomes);
  });

// ── the project secret ── `rotateProjectApiKey(projectId, kv)` / `verifyProjectSecret(project, secret,
// kv)` over a Map-backed KV: the key's shape, the stored hash's shape and key, then `{ project,
// secret, becomes }` rows around one minted key.

/** A KV namespace as the two functions use it — `get` and `put` over a Map the test can inspect. */
const kvOf = () => {
  const rows = new Map<string, string>();
  const kv = {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => {
      rows.set(key, value);
    },
  } as unknown as KVNamespace;
  return { rows, kv };
};
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

test("rotateProjectApiKey: 32 random bytes as base64url; only the SHA-256 hash is stored, base64url, under project-api-key:<projectId> — outside the secret:<projectId>: prefix", async () => {
  const { rows, kv } = kvOf();
  const key = await rotateProjectApiKey("prj-1", kv);
  expect(key).toMatch(BASE64URL_32_BYTES);
  expect([...rows.keys()]).toEqual(["project-api-key:prj-1"]);
  const stored = rows.get("project-api-key:prj-1")!;
  expect(stored).toMatch(BASE64URL_32_BYTES); // a digest is 32 bytes too
  expect(stored).not.toBe(key);
  expect(await rotateProjectApiKey("prj-1", kv)).not.toBe(key); // every mint is fresh
});

const secretRows: {
  title: string;
  project: string;
  secret: (key: string) => string;
  becomes: boolean;
}[] = [
  { title: "the right key", project: "prj-1", secret: (key) => key, becomes: true },
  {
    title: "a wrong key (one character off)",
    project: "prj-1",
    secret: (key) => `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`,
    becomes: false,
  },
  {
    title: "a prefix of the key",
    project: "prj-1",
    secret: (key) => key.slice(0, -1),
    becomes: false,
  },
  {
    title: "the right key for the wrong project",
    project: "prj-2",
    secret: (key) => key,
    becomes: false,
  },
  { title: "an empty key", project: "prj-1", secret: () => "", becomes: false },
];
for (const { title, project, secret, becomes } of secretRows)
  test(`verifyProjectSecret: ${title} ⇒ ${becomes ? '{ actor: "project:prj-1" }' : "null"}`, async () => {
    const { kv } = kvOf();
    const key = await rotateProjectApiKey("prj-1", kv);
    expect(await verifyProjectSecret(project, secret(key), kv)).toEqual(
      becomes ? { actor: "project:prj-1" } : null,
    );
  });

test("a rotation retires the previous key at once; a project never rotated has no key; a stored hash of the wrong length or not base64url verifies nothing", async () => {
  const { rows, kv } = kvOf();
  expect(await verifyProjectSecret("prj-1", "anything", kv)).toBeNull();
  const first = await rotateProjectApiKey("prj-1", kv);
  const second = await rotateProjectApiKey("prj-1", kv);
  expect(await verifyProjectSecret("prj-1", first, kv)).toBeNull();
  expect(await verifyProjectSecret("prj-1", second, kv)).toEqual({ actor: "project:prj-1" });
  rows.set("project-api-key:prj-1", "AAAA"); // three bytes, not a digest
  expect(await verifyProjectSecret("prj-1", second, kv)).toBeNull();
  rows.set("project-api-key:prj-1", "!!!!"); // not base64url at all
  expect(await verifyProjectSecret("prj-1", second, kv)).toBeNull();
});
