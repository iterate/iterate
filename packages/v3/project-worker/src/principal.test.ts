// principal.test.ts — the project token as a table: what verifies, what does not.
import { expect, test } from "vitest";
import { signClaims, verifyProjectToken } from "./principal.ts";

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
