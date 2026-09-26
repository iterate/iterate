// caller.test.ts — the signed-claims codec as a table: what verifies, what does not; the digest and
// the secrets' compare; and `stampCaller`, the provenance an event is stored with.
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import type { EventSource } from "iterate/stream/processor";
import {
  secretsEqual,
  sha256Hex,
  signClaims,
  platformSource,
  stampCaller,
  type Caller,
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

// ── stampCaller — the platform's provenance stamp on an event ──
// Every row's event arrives with a forged source (every field a writer might claim); the stamp is
// built from the caller alone, so the forged fields never survive.
const FORGED = {
  origin: "/elsewhere",
  principal: { actor: "forged" },
  grant: "grant_forged",
  platform: true,
  processor: { slug: "p", version: "1" },
  schedule: { key: "k", scheduledAtOffset: 1, at: "2026-01-01T00:00:00.000Z" },
};
const viewed = {
  actor: "user_bob",
  email: "bob@example.com",
  impersonatedBy: { actor: "user_admin", email: "admin@example.com" },
};
const STAMP_ROWS: { writer: string; caller: Caller; source: EventSource }[] = [
  {
    writer: "a person through a grant, at the context they addressed",
    caller: { principal: { actor: "user_1", email: "a@b.c" }, grant: "grant_abc" },
    source: { origin: "/here", principal: { actor: "user_1", email: "a@b.c" }, grant: "grant_abc" },
  },
  {
    writer: "an admin signed in as someone: both people, as the platform admitted them",
    caller: { principal: viewed, grant: "g" },
    source: { origin: "/here", principal: viewed, grant: "g" },
  },
  {
    writer: "the admin secret: a principal and no grant",
    caller: { principal: { actor: "admin" } },
    source: { origin: "/here", principal: { actor: "admin" } },
  },
  {
    writer: "loaded code at this context: the context alone",
    caller: { principal: null, app: true },
    source: { origin: "/here" },
  },
  {
    writer: "loaded code whose call started at /agents/a/sandbox: that context",
    caller: { principal: null, app: true, path: "/agents/a/sandbox" },
    source: { origin: "/agents/a/sandbox" },
  },
  {
    writer: "the platform writing a fact on a person's behalf: attributed to them, and `platform`",
    caller: { principal: { actor: "user_1" }, grant: "g", platform: true },
    source: { origin: "/here", principal: { actor: "user_1" }, grant: "g", platform: true },
  },
  {
    writer: "a grant without a principal is no one's: no grant",
    caller: { principal: null, grant: "g" },
    source: { origin: "/here" },
  },
];
test.for(STAMP_ROWS)("$writer", ({ caller, source }) => {
  expect(stampCaller({ type: "x", payload: { n: 1 }, source: FORGED }, caller, "/here")).toEqual({
    type: "x",
    payload: { n: 1 },
    source,
  });
});

test("the platform's own records are stamped as the context itself, vouched for", () => {
  expect(platformSource("/agents/a")).toEqual({ origin: "/agents/a", platform: true });
});
