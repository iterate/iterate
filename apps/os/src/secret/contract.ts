// src/secret/contract.ts — A SECRET: a domain object on the context at `/secrets/<name>` — the path
// the placeholder spells (`getSecret("/secrets/<name>")` in an outbound request's URL or headers),
// under the RESOURCE OWNER's root (a project's `/`; a user's own secret lives at
// `/users/<id>/secrets/<name>`, an organization's under `/organizations/<id>`, and the deployment's
// own — the operator's, lent to projects — at `global:/secrets/<name>`). Its VALUE is in the
// `secret` facet's storage on that path — encrypted at rest, never on a log; its facts are on that
// path's log, and THIS FILE is the only place they are spelled. The rest of the folder derives from
// it: processor.ts reduces these events (no saga — a value cannot ride an event, so the write is a
// VERB, `itx.secrets.set`, context/built-ins.ts, which runs on this path, lands the facts itself and
// puts the value in the facet), durable-object.ts is the facet — the material's one keeper, and the
// one code that substitutes it into a request and dispatches it (a context's egress forwards a
// placeholder-bearing request to it, a WebSocket upgrade included). The catalog is the owner root's:
// `secret/set` and `secret/deleted` are cross-posted there and folded by the `project`, `account`,
// `organization` or `instance` processor — what `itx.secrets.list()` reads; the catalog's shape and
// its fold are spelled here too (`SecretCatalog`, `reduceSecretCatalog`), once for every owner. Every type
// is derived here, never hand-kept:
//   SecretState                          = ProcessorState<typeof SecretContract>  the reduced state below
//   ConsumedEvent<typeof SecretContract>                                           what reduce sees
//   EventInput<typeof SecretContract>                                              what the verbs append
import { z } from "zod";
import { jsonEqual } from "iterate/lib";
import {
  type ConsumedEvent,
  defineProcessorContract,
  type ProcessorState,
} from "iterate/stream/processor";
import type { SecretRefresh } from "iterate/api";

/** The refresh strategies implemented (secrets.ts), by kind: what a `set` names, a `refreshed`
 *  reports and the catalog keeps — pinned to the SDK's `SecretRefresh`, so a strategy added there
 *  is a type error here until it is named. */
export const SecretRefreshKind = z.enum([
  "oauth-refresh-token",
  "waitrose-session",
  "github-app-installation",
  "worker",
] satisfies SecretRefresh["kind"][]);
export type SecretRefreshKind = z.infer<typeof SecretRefreshKind>;

/** Whom a borrowed secret is lent by — a person, or this deployment itself (the operator's
 *  `global:/secrets/<name>`) — and what the lender's connection is when it is one (so a project's
 *  integrations list can show "Google, lent by ada@…"). */
const BorrowedFrom = z.object({
  lendId: z.string().min(1),
  lender: z.union([
    z.object({ userId: z.string().min(1), email: z.string().optional() }),
    z.object({ instance: z.literal(true) }),
  ]),
  integration: z
    .object({ provider: z.string(), account: z.string(), externalId: z.string() })
    .optional(),
});

/** The catalog an owner root keeps — every secret set under it, by its path (`/secrets/<name>`,
 *  what the placeholder spells; the context lives under that root): the pin, the refresh strategy's
 *  kind, and when it was first set — never a value. What `itx.secrets.list()` reads; the `project`,
 *  `account`, `organization` and `instance` states each carry one. */
export const SecretCatalog = z.record(
  z.string(),
  z.object({
    urls: z.array(z.string()),
    refresh: SecretRefreshKind.optional(),
    /** Exchange code's (`refresh` "worker") source, as its SHA-256 hex: which code refreshes it. */
    refreshSourceSha256: z.string().optional(),
    createdAt: z.string(),
    /** A borrowed secret (`secret/borrowed`): no material here, every use forwarded to the lender. */
    borrowed: BorrowedFrom.optional(),
    /** The live lends of this secret, by lend id: the project it is lent to (or `every-project`),
     *  and as which path. */
    lends: z
      .record(z.string(), z.object({ to: z.string(), as: z.string(), since: z.string() }))
      .optional(),
  }),
);
export type SecretCatalog = z.infer<typeof SecretCatalog>;

/** Why a lend ended: its lender revoked it, the lender no longer reaches the borrowing project, or
 *  the borrower deleted its borrowed secret. */
export const LendRevokedReason = z.enum(["lender", "membership-ended", "borrower-deleted"]);
export type LendRevokedReason = z.infer<typeof LendRevokedReason>;

export const SecretContract = defineProcessorContract({
  slug: "secret",
  version: "3",
  description:
    "A secret: whether material is stored (or borrowed) and whether the secret was deleted, by the offsets of the facts that say so — never a value.",
  /** THE REDUCED STATE — what the reduce keeps between events: the write that put the current
   *  material there, as the OFFSET of the `secret/set` that says so (read that event for the pin and
   *  the strategy kind), and where deletion stands the same way. It is what `snapshot()` answers and
   *  what `itx.secrets.delete` reads before it acts. */
  stateSchema: z.object({
    /** The latest `secret/set`; null while no material is stored (never set, or deleted). */
    material: z.object({ offset: z.number().int().positive() }).nullable().default(null),
    /** The `secret/deleted` that emptied it; null while the secret lives — and cleared again by a
     *  later `secret/set`: unlike a repo, a secret is re-settable after its deletion. */
    deletion: z.object({ offset: z.number().int().positive() }).nullable().default(null),
    /** The lend a borrowed secret stands on; null for a secret with its own material. */
    borrowed: z.object({ lendId: z.string() }).nullable().default(null),
  }),
  events: {
    "events.iterate.com/secret/set": {
      description:
        "Material was written — by `itx.secrets.set`, or by the OAuth exchange a `beginOAuth` began. Never the value: the pin (origins), the strategy kind and, for exchange code, its source's hash. On the secret's path, and cross-posted to the owner's root for the catalog — hence it names the path (the one the placeholder spells).",
      payloadSchema: z.object({
        path: z.string().min(1),
        urls: z.array(z.string()).min(1),
        refresh: SecretRefreshKind.optional(),
        /** Exchange code's source (`refresh` "worker"), as its SHA-256 hex — never the source. */
        refreshSourceSha256: z.string().optional(),
      }),
    },
    "events.iterate.com/secret/deleted": {
      description:
        "The value was forgotten (`itx.secrets.delete`). On the secret's path, and cross-posted to the owner's root, whose catalog drops the entry — hence it names the path.",
      payloadSchema: z.object({ path: z.string().min(1) }),
    },
    "events.iterate.com/secret/refreshed": {
      description:
        "The refresh strategy ran — on a 401 from the pinned host, or on first use with no access token yet — and this is how it went; the facet appends it itself. A fact, not state.",
      payloadSchema: z.object({
        kind: SecretRefreshKind,
        ok: z.boolean(),
        error: z.string().optional(),
      }),
    },
    "events.iterate.com/secret/used": {
      description:
        "A dispatch through the material: the request AS RECEIVED — its placeholders, never a value — and the upstream's status (a WebSocket upgrade is a dispatch, status 101); the facet appends it itself, best-effort. A fact, not state.",
      payloadSchema: z.object({
        method: z.string(),
        url: z.string(),
        status: z.number().int(),
        /** The project a lent secret was used for (`secret/lent`): the use ran here, at the lender. */
        borrower: z.string().optional(),
      }),
    },
    "events.iterate.com/secret/lent": {
      description:
        "The owner lent this secret to a project as one of its own paths (`itx.secrets.lend`) — or, the operator's instance secret, to every project (`to: \"every-project\"`). On the lender's secret path and cross-posted to the lender's root, whose catalog lists the lend. The borrower gets no material: its uses are forwarded here.",
      payloadSchema: z.object({
        path: z.string().min(1),
        lendId: z.string().min(1),
        to: z.string().min(1),
        as: z.string().min(1),
      }),
    },
    "events.iterate.com/secret/borrowed": {
      description:
        "A lend arrived: this path now forwards every use to the lender's secret. On the borrower's path and cross-posted to the borrower's root, whose catalog shows it as borrowed.",
      payloadSchema: BorrowedFrom.extend({
        path: z.string().min(1),
        urls: z.array(z.string()).min(1),
      }),
    },
    "events.iterate.com/secret/lend-revoked": {
      description:
        "A lend ended — its lender revoked it, the lender no longer reaches the project, or the borrower deleted the borrowed secret. On both sides, each cross-posted to its root. On the lender's side, `borrower` names the one project a lend to every project ended for; the lend stands for the rest.",
      payloadSchema: z.object({
        path: z.string().min(1),
        lendId: z.string().min(1),
        reason: LendRevokedReason,
        borrower: z.string().min(1).optional(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/secret/set",
    "events.iterate.com/secret/deleted",
    "events.iterate.com/secret/lent",
    "events.iterate.com/secret/borrowed",
    "events.iterate.com/secret/lend-revoked",
  ],
  emits: [],
});

/** The secret's reduced state: whether material is stored and whether it was deleted, by the offsets
 *  of the facts that say so (the contract's `stateSchema`). */
export type SecretState = ProcessorState<typeof SecretContract>;

/** The owner root's fold of a secret's certificates into its catalog — the cases every owner's
 *  reduce delegates here. The latest `set` is the row (a rotation keeps the row and its lends, a
 *  new pin or strategy replaces it); the first set's time stays; the same pin and strategy again is
 *  a no-op. A `deleted` drops the row. A `borrowed` is a row of its own; `lent` adds a lend to the
 *  lender's row; `lend-revoked` drops the lend, or the borrowed row it stood on — but not a lend to
 *  every project that ended for one `borrower`. Undefined when the
 *  catalog is unchanged, as a reduce answers. */
export function reduceSecretCatalog(
  secrets: SecretCatalog,
  event: ConsumedEvent<typeof SecretContract>,
): SecretCatalog | undefined {
  switch (event.type) {
    case "events.iterate.com/secret/set": {
      const { path, urls, refresh, refreshSourceSha256 } = event.payload;
      const known = secrets[path];
      if (
        known &&
        !known.borrowed &&
        known.refresh === refresh &&
        known.refreshSourceSha256 === refreshSourceSha256 &&
        jsonEqual(known.urls, urls)
      )
        return undefined;
      return {
        ...secrets,
        [path]: {
          urls,
          refresh,
          refreshSourceSha256,
          createdAt: known?.createdAt ?? event.createdAt,
          ...(known?.lends && { lends: known.lends }),
        },
      };
    }
    case "events.iterate.com/secret/borrowed": {
      const { path, urls, ...borrowed } = event.payload;
      return { ...secrets, [path]: { urls, createdAt: event.createdAt, borrowed } };
    }
    case "events.iterate.com/secret/lent": {
      const { path, lendId, to, as } = event.payload;
      const known = secrets[path];
      if (!known || known.lends?.[lendId]) return undefined;
      const lends = { ...known.lends, [lendId]: { to, as, since: event.createdAt } };
      return { ...secrets, [path]: { ...known, lends } };
    }
    case "events.iterate.com/secret/lend-revoked": {
      const { path, lendId, borrower } = event.payload;
      const known = secrets[path];
      if (known?.borrowed?.lendId === lendId) {
        const { [path]: _gone, ...rest } = secrets;
        return rest;
      }
      if (!known?.lends?.[lendId] || borrower) return undefined;
      const { [lendId]: _ended, ...lends } = known.lends;
      return { ...secrets, [path]: { ...known, lends } };
    }
    case "events.iterate.com/secret/deleted": {
      if (!secrets[event.payload.path]) return undefined;
      const { [event.payload.path]: _gone, ...rest } = secrets;
      return rest;
    }
  }
}
