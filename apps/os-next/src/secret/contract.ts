// src/secret/contract.ts — A SECRET: a domain object on the context at `/secrets/<name>` — the path
// the placeholder spells (`getSecret("/secrets/<name>")` in an outbound request's URL or headers),
// under the RESOURCE OWNER's root (a project's `/`; a user's own secret lives at
// `/users/<id>/secrets/<name>`, an organization's under `/organizations/<id>`). Its VALUE is in the
// `secret` facet's storage on that path — encrypted at rest, never on a log; its facts are on that
// path's log, and THIS FILE is the only place they are spelled. The rest of the folder derives from
// it: processor.ts reduces these events (no saga — a value cannot ride an event, so the write is a
// VERB, `itx.secrets.set`, context/built-ins.ts, which runs on this path, lands the facts itself and
// puts the value in the facet), durable-object.ts is the facet — the material's one keeper, and the
// one code that substitutes it into a request and dispatches it (a context's egress forwards a
// placeholder-bearing request to it, a WebSocket upgrade included). The catalog is the owner root's:
// `secret/set` and `secret/deleted` are cross-posted there and folded by the `project`, `account` or
// `organization` processor — what `itx.secrets.list()` reads. Every type is derived here, never
// hand-kept:
//   SecretState                          = ProcessorState<typeof SecretContract>  the reduced state below
//   ConsumedEvent<typeof SecretContract>                                           what reduce sees
//   EventInput<typeof SecretContract>                                              what the verbs append
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/next/stream/processor";
import type { SecretRefresh } from "../secrets.ts";

export const SecretContract = defineProcessorContract({
  slug: "secret",
  version: "1",
  description:
    "A secret: whether material is stored and whether the secret was deleted, by the offsets of the facts that say so — never a value.",
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
  }),
  events: {
    "events.iterate.com/secret/set": {
      description:
        "Material was written — by `itx.secrets.set`, or by the OAuth exchange a `beginOAuth` began. Never the value: the pin (origins) and the strategy kind. On the secret's path, and cross-posted to the owner's root for the catalog — hence it names the path (the one the placeholder spells).",
      payloadSchema: z.object({
        path: z.string().min(1),
        urls: z.array(z.string()).min(1),
        refresh: z
          .enum(["oauth-refresh-token", "waitrose-session"] satisfies SecretRefresh["kind"][])
          .optional(),
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
        kind: z.enum(["oauth-refresh-token", "waitrose-session"] satisfies SecretRefresh["kind"][]),
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
      }),
    },
  },
  consumes: ["events.iterate.com/secret/set", "events.iterate.com/secret/deleted"],
  emits: [],
});

/** The secret's reduced state: whether material is stored and whether it was deleted, by the offsets
 *  of the facts that say so (the contract's `stateSchema`). */
export type SecretState = ProcessorState<typeof SecretContract>;
