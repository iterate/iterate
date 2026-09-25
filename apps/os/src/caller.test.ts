// caller.test.ts — the signed-claims codec as a table: what verifies, what does not; the digest and
// the secrets' compare; and `stampCaller`, the attribution an event is stored with.
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  secretsEqual,
  sha256Hex,
  signClaims,
  stampCaller,
  verifyAdminSecret,
  verifyClaims,
} from "./caller.ts";

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

test("sha256Hex is node's SHA-256 in hex; secretsEqual compares whole strings", async () => {
  expect(await sha256Hex("itk_☃")).toBe(createHash("sha256").update("itk_☃").digest("hex"));
  expect(await secretsEqual("abc", "abc")).toBe(true);
  expect(await secretsEqual("abc", "abd")).toBe(false);
  expect(await secretsEqual("abc", "ab")).toBe(false);
  expect(await secretsEqual("", "")).toBe(true);
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

// ── stampCaller — the platform's attribution on an event ──
const event: { type: string; payload: { n: number }; source?: Record<string, unknown> } = {
  type: "x",
  payload: { n: 1 },
};
test("a person through a grant: source.principal and source.grant, a client-supplied stamp replaced", () => {
  expect(
    stampCaller(
      {
        ...event,
        source: {
          principal: { actor: "forged" },
          grant: "grant_forged",
          processor: { slug: "p", version: "1" },
        },
      },
      { principal: { actor: "user_1", email: "a@b.c" }, grant: "grant_abc" },
    ),
  ).toEqual({
    ...event,
    source: {
      processor: { slug: "p", version: "1" },
      principal: { actor: "user_1", email: "a@b.c" },
      grant: "grant_abc",
    },
  });
});
test("an admin signed in as someone: both stamped; a client's claim of one is dropped with its principal", () => {
  const viewed = {
    actor: "user_bob",
    email: "bob@example.com",
    impersonatedBy: { actor: "user_admin", email: "admin@example.com" },
  };
  const forged = {
    ...event,
    source: { principal: { actor: "user_bob", impersonatedBy: { actor: "user_x", email: "x@y" } } },
  };
  expect(stampCaller(forged, { principal: viewed, grant: "g" })).toEqual({
    ...event,
    source: { principal: viewed, grant: "g" },
  });
  expect(
    stampCaller(forged, { principal: { actor: "user_bob", email: "bob@example.com" }, grant: "g" }),
  ).toEqual({
    ...event,
    source: { principal: { actor: "user_bob", email: "bob@example.com" }, grant: "g" },
  });
});
test("the admin secret: a principal, no grant key at all", () => {
  expect(stampCaller(event, { principal: { actor: "admin" } })).toEqual({
    ...event,
    source: { principal: { actor: "admin" } },
  });
});
test("nobody (the kernel, an anonymous session): a client's stamp is dropped; an empty source is dropped whole", () => {
  expect(
    stampCaller(
      { ...event, source: { principal: { actor: "forged" }, grant: "g" } },
      { principal: null },
    ),
  ).toEqual(event);
  expect(
    stampCaller(
      { ...event, source: { grant: "g", processor: { slug: "p", version: "1" } } },
      { principal: null },
    ),
  ).toEqual({
    ...event,
    source: { processor: { slug: "p", version: "1" } },
  });
});
test("a client's claim that the platform wrote its event is dropped, whoever it is", () => {
  const claimed = { ...event, source: { platform: true } };
  expect(stampCaller(claimed, { principal: { actor: "user_1" }, grant: "g" })).toEqual({
    ...event,
    source: { principal: { actor: "user_1" }, grant: "g" },
  });
  expect(stampCaller(claimed, { principal: null, app: true })).toEqual(event);
});
test("the platform writing a fact on a person's behalf: attributed to them, and stamped `platform`", () => {
  expect(
    stampCaller(event, { principal: { actor: "user_1" }, grant: "g", platform: true }),
  ).toEqual({
    ...event,
    source: { principal: { actor: "user_1" }, grant: "g", platform: true },
  });
});
