// principal.test.ts — the project token as a table: what verifies, what does not.
import { expect, test } from "vitest";
import { signProjectToken, verifyProjectToken } from "./principal.ts";

const SECRET = "test-secret";
const NOW = 1_800_000_000_000;
const claims = {
  projectId: "prj-1",
  actor: "user_a",
  email: "a@example.com",
  expiresAt: NOW + 60_000,
};

test("a token round-trips its claims, email included", async () => {
  const token = await signProjectToken(claims, SECRET);
  expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(await verifyProjectToken(token, SECRET, NOW)).toEqual(claims);
});

test("a token without an email carries none", async () => {
  const { email: _email, ...bare } = claims;
  expect(await verifyProjectToken(await signProjectToken(bare, SECRET), SECRET, NOW)).toEqual(bare);
});

const refusals: { title: string; token: () => Promise<string>; secret?: string; now?: number }[] = [
  { title: "the wrong secret", token: () => signProjectToken(claims, "other") },
  {
    title: "a blank secret verifies nothing",
    token: () => signProjectToken(claims, SECRET),
    secret: "",
  },
  { title: "expired", token: () => signProjectToken(claims, SECRET), now: claims.expiresAt },
  {
    title: "a tampered payload",
    token: async () => {
      const t = await signProjectToken(claims, SECRET);
      const [p, s] = t.split(".");
      return `${p.slice(0, -2)}AA.${s}`;
    },
  },
  {
    title: "a tampered signature",
    token: async () => (await signProjectToken(claims, SECRET)).slice(0, -1) + "A",
  },
  { title: "no dot", token: async () => "nodot" },
  { title: "not JSON", token: async () => "bm90LWpzb24.c2ln" },
  {
    title: "claims missing the actor",
    token: () => signProjectToken({ projectId: "prj-1", expiresAt: NOW + 1 } as never, SECRET),
  },
];
for (const { title, token, secret = SECRET, now = NOW } of refusals)
  test(`refused: ${title}`, async () => {
    expect(await verifyProjectToken(await token(), secret, now)).toBeNull();
  });
