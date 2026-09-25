// src/control-plane/oauth-grants.ts — THE OAUTH PROVIDER'S GRANTS: the `grant:<userId>:<grantId>`
// records @cloudflare/workers-oauth-provider keeps (the code's hash and PKCE challenge, the current
// and previous refresh token hashes, the encrypted props), as a table in the control plane's D1
// (db/definitions.sql `oauth_grants`), not in KV. The provider rewrites a grant on the code exchange
// and on every refresh, and the next refresh must read that write, which KV does not promise: a
// location that cached a key serves it for up to 60 s after another location wrote a new one
// (https://developers.cloudflare.com/kv/concepts/how-kv-works/). D1 does, because every query goes
// to its primary: without the Sessions API "all queries will continue to be executed only by the
// primary database" (https://developers.cloudflare.com/d1/best-practices/read-replication/), so
// `withSession` must never appear under src/control-plane/.
//
// The provider's KV semantics are kept (oauth-store.ts is the KV-shaped face): an expiry, absolute
// or relative, after which a row reads as absent (purged on the next write); a key-ordered,
// prefix-scoped, cursor-paged list.
import { createD1Client } from "sqlfu";
import { batch } from "./db/index.ts";
import {
  deleteOAuthGrant,
  listOAuthGrants,
  oauthGrant,
  purgeExpiredOAuthGrants,
  upsertOAuthGrant,
} from "./db/queries/.generated/oauth-grants.sql.ts";

/** KV's page size cap: `list` answers at most this many keys. */
const LIST_LIMIT_MAX = 1000;

/** A page of keys, as KV's `list` answers it. `cursor` is the last key answered. */
export type OAuthGrantListing = {
  keys: { name: string; expiration?: number }[];
  list_complete: boolean;
  cursor?: string;
};

export class OAuthGrantTable {
  readonly #d1: D1Database;
  readonly #client: ReturnType<typeof createD1Client>;

  constructor(d1: D1Database) {
    this.#d1 = d1;
    this.#client = createD1Client(d1);
  }

  /** The grant's JSON, or null when absent or expired at `now` (epoch seconds). */
  async get(key: string, now: number): Promise<string | null> {
    return (await oauthGrant(this.#client, { key, now }))?.value ?? null;
  }

  /** Write the grant whole, as KV's `put` does: a put without an expiry leaves a row that never
   *  expires. Every expired row goes first, in the same batch, so the table holds only live grants
   *  plus whatever expired since the last write. */
  async put(key: string, value: string, expiresAt: number | null, now: number): Promise<void> {
    await batch(this.#d1, [
      purgeExpiredOAuthGrants.query({ now }),
      upsertOAuthGrant.query({ key, value, expiresAt }),
    ]);
  }

  async delete(key: string): Promise<void> {
    await deleteOAuthGrant(this.#client, { key });
  }

  /** The live keys starting with `prefix`, in key order, after `cursor`: a range of the key's
   *  index, from `prefix` (or the cursor past it) to the first key past every key starting with it —
   *  `prefix` with its last character one higher (`grant:user_a:` → `grant:user_a;`). Never a LIKE
   *  pattern (a user id's `_` is a LIKE wildcard), and never `substr`, which reads every row. */
  async list(
    prefix: string,
    options: { cursor?: string; limit?: number },
    now: number,
  ): Promise<OAuthGrantListing> {
    const limit = Math.min(options.limit ?? LIST_LIMIT_MAX, LIST_LIMIT_MAX);
    const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const rows = await listOAuthGrants(this.#client, {
      cursor: options.cursor || "",
      prefix,
      end,
      now,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const keys = page.map((row) =>
      row.expiresAt ? { name: row.key, expiration: row.expiresAt } : { name: row.key },
    );
    if (rows.length <= limit) return { keys, list_complete: true };
    return { keys, list_complete: false, cursor: page.at(-1)!.key };
  }
}
