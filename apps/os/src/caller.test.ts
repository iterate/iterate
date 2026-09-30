// caller.test.ts — the signed-claims codec as a table: what verifies, what does not; the digest and
// the secrets' compare; and `stampCaller`, the attribution an event is stored with.
import { createHash } from "node:crypto";
import { INTEGRATION_PROVIDERS } from "iterate/api";
import { expect, test } from "vitest";
import {
  secretsEqual,
  sha256Hex,
  signClaims,
  PLATFORM_FACT_TYPES,
  refuseNonPlatformWrites,
  refusePlatformIdempotencyKeys,
  stampCaller,
  verifyAdminSecret,
  verifyClaims,
  type Caller,
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
// Every row writes at `/agents/b` (`here`); the writer's own `source` is dropped but for `processor`.
const event = { type: "x", payload: { n: 1 } };
const forged = {
  origin: "/",
  principal: { actor: "user_owner" },
  grant: "grant_forged",
  onBehalfOf: { principal: { actor: "user_owner" }, run: "/@1" },
  platform: true as const,
  schedule: { key: "k", scheduledAtOffset: 1, at: "2026-01-01T00:00:00.000Z" },
};
const viewed = {
  actor: "user_bob",
  email: "bob@example.com",
  impersonatedBy: { actor: "user_admin", email: "admin@example.com" },
};
test.for<{ name: string; source?: object; caller: Caller; stamped: object }>([
  {
    name: "a person through a grant: origin, principal and grant; a forged stamp replaced whole",
    source: forged,
    caller: { principal: { actor: "user_1", email: "a@b.c" }, grant: "grant_abc" },
    stamped: {
      origin: "/agents/b",
      principal: { actor: "user_1", email: "a@b.c" },
      grant: "grant_abc",
    },
  },
  {
    name: "an admin signed in as someone: the platform's impersonation, never a client's",
    source: { principal: { actor: "user_bob", impersonatedBy: { actor: "x", email: "x@y" } } },
    caller: { principal: viewed, grant: "g" },
    stamped: { origin: "/agents/b", principal: viewed, grant: "g" },
  },
  {
    name: "the admin secret: a principal, no grant key at all",
    caller: { principal: { actor: "admin" } },
    stamped: { origin: "/agents/b", principal: { actor: "admin" } },
  },
  {
    name: "loaded code that crossed a hop: the context its call started at, whatever it claims",
    source: forged,
    caller: { principal: null, app: true, path: "/agents/a" },
    stamped: { origin: "/agents/a" },
  },
  {
    name: "nobody (the kernel, an anonymous session): only where it came from",
    source: { principal: { actor: "forged" }, grant: "g", platform: true },
    caller: { principal: null },
    stamped: { origin: "/agents/b" },
  },
  {
    name: "the engine's `processor` label is the one field a writer keeps, under the stamped origin",
    source: { ...forged, processor: { slug: "p", version: "1" } },
    caller: { principal: null, app: true },
    stamped: { origin: "/agents/b", processor: { slug: "p", version: "1" } },
  },
  {
    name: "a script a person asked for: loaded code, for them (its cause's token, verified by the append)",
    source: forged,
    caller: {
      principal: null,
      app: true,
      onBehalfOf: { principal: { actor: "user_1", email: "a@b.c" }, grant: "g", run: "/@7" },
    },
    stamped: {
      origin: "/agents/b",
      onBehalfOf: { principal: { actor: "user_1", email: "a@b.c" }, grant: "g", run: "/@7" },
    },
  },
  {
    name: "the platform writing a fact on a person's behalf: attributed to them, and stamped `platform`",
    caller: { principal: { actor: "user_1" }, grant: "g", platform: true },
    stamped: { origin: "/agents/b", principal: { actor: "user_1" }, grant: "g", platform: true },
  },
])("stampCaller: $name", ({ source, caller, stamped }) => {
  expect(stampCaller({ ...event, source }, caller, "/agents/b")).toStrictEqual({
    ...event,
    source: stamped,
  });
});

// ── the platform's writes — its facts and the config pointer: no one else appends or schedules one ──
test.for<{ name: string; who: keyof typeof writers; refused?: true }>([
  { name: "a person", who: "a person", refused: true },
  { name: "loaded code", who: "loaded code", refused: true },
  { name: "a first-party processor", who: "a first-party processor", refused: true },
  { name: "the platform", who: "the platform for a person" },
])(
  "every platform fact and config pointer row, appended or scheduled by $name",
  ({ who, refused }) => {
    const platformWrites = [
      ...[
        ...PLATFORM_FACT_TYPES,
        // spelled out, so the list cannot lose them: the webhooks a processor trusts, and every
        // provider's connection facts
        "events.iterate.com/github/webhook-received",
        "events.iterate.com/slack/webhook-received",
        ...INTEGRATION_PROVIDERS.flatMap((provider) => [
          `events.iterate.com/${provider}/connected`,
          `events.iterate.com/${provider}/disconnected`,
        ]),
      ].map((type) => ({ type, payload: {} })),
      pointerRow(["itx", "config"], ["itx", ["cd", "/x"], "w"]),
      pointerRow(["itx", "config"], null),
      pointerRow(["itx", "config"], null, { ifTarget: ["itx", "w"] }),
      pointerRow(["itx", "config", "deliverEvent"], ["itx", "w"]),
    ];
    for (const write of platformWrites)
      for (const event of [
        write,
        {
          type: "events.iterate.com/itx/schedule-set",
          payload: { key: "k", when: { afterMs: 1 }, events: [{ type: "note" }, write] },
        },
      ]) {
        const refuse = () => refuseNonPlatformWrites([event], writers[who]);
        if (refused)
          expect(refuse, JSON.stringify(write)).toThrow(
            /is the platform's own fact|only the platform's publication writes it/,
          );
        else expect(refuse, JSON.stringify(write)).not.toThrow();
      }
    // a row beside the pointer is anyone's
    for (const event of [{ type: "note" }, pointerRow(["itx", "configs"], ["itx", "w"])])
      expect(() => refuseNonPlatformWrites([event], writers[who])).not.toThrow();
  },
);

// ── the platform's idempotency keys — no other writer takes one first ──
const writers = {
  "loaded code": { principal: null, app: true },
  "a person": { principal: { actor: "user_1" }, grant: "g" },
  "the platform for a person": { principal: { actor: "user_1" }, grant: "g", platform: true },
  "a first-party processor": { principal: null },
} satisfies Record<string, Caller>;
test.for<{ key: string; who: keyof typeof writers; on: "a project" | "a global"; refused?: true }>([
  { key: "itx/run-settled:9", who: "loaded code", on: "a project", refused: true },
  { key: "itx/child-created:/x", who: "loaded code", on: "a project", refused: true },
  { key: "itx@/", who: "loaded code", on: "a project", refused: true },
  { key: "project/delete-requested", who: "loaded code", on: "a project", refused: true },
  { key: "repo/created:/repos/x", who: "loaded code", on: "a project", refused: true },
  { key: "workspace/deleted:/w", who: "loaded code", on: "a project", refused: true },
  { key: "secret/lent:l1", who: "loaded code", on: "a project", refused: true },
  { key: "agent/created:/agents/a", who: "loaded code", on: "a project" },
  { key: "itxx/mine", who: "loaded code", on: "a project" },
  { key: "itx/ingress-configured:abc", who: "a first-party processor", on: "a project" },
  { key: "project/delete-requested", who: "a person", on: "a project" },
  { key: "account/grant-ended/g", who: "a person", on: "a global", refused: true },
  { key: "organization/created", who: "loaded code", on: "a global", refused: true },
  { key: "account/grant-ended/g", who: "the platform for a person", on: "a global" },
  { key: "itx/run-settled:9", who: "loaded code", on: "a global" },
])(
  "the platform's idempotency keys: $key from $who on $on context",
  ({ key, who, on, refused }) => {
    const refuse = () =>
      refusePlatformIdempotencyKeys([{ idempotencyKey: key }], writers[who], on === "a global");
    if (refused) expect(refuse).toThrow(/is the platform's/);
    else expect(refuse).not.toThrow();
  },
);

/** A rewrite rule's row, as the append boundary has normalized it. */
function pointerRow(match: string[], target: unknown, extra: { ifTarget?: unknown } = {}) {
  return {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match, target, ...extra },
  };
}
