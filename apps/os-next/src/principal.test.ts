// principal.test.ts — the signed-claims codec as a table: what verifies, what does not; the admin
// secret's compare; and the cookie header — read back, refused.
import { expect, test } from "vitest";
import { cookieValueOf, signClaims, verifyAdminSecret, verifyClaims } from "./principal.ts";

const SECRET = "test-secret";
const claims = { actor: "user_a", email: "a@example.com", next: "/" };

test("signed claims round-trip", async () => {
  const token = await signClaims(claims, SECRET);
  expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(await verifyClaims(token, SECRET)).toEqual(claims);
});

test("non-ASCII claims round-trip intact (the payload is UTF-8, decoded as such)", async () => {
  const unicode = { ...claims, actor: "user_élise", email: "élise@例え.jp" };
  expect(await verifyClaims(await signClaims(unicode, SECRET), SECRET)).toEqual(unicode);
});

const refusals: { title: string; token: () => Promise<string>; secret?: string }[] = [
  { title: "the wrong secret", token: () => signClaims(claims, "other") },
  {
    title: "a blank secret verifies nothing",
    token: () => signClaims(claims, SECRET),
    secret: "",
  },
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
];
for (const { title, token, secret = SECRET } of refusals)
  test(`refused: ${title}`, async () => {
    expect(await verifyClaims(await token(), secret)).toBeNull();
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
