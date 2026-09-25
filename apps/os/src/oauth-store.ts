// src/oauth-store.ts — THE PROVIDER'S STORE: `OAUTH_KV` as @cloudflare/workers-oauth-provider sees
// it. The provider has one storage interface, `env.OAUTH_KV`, and oauth.ts hands it this object there. A
// grant (`grant:<userId>:<grantId>`) lives in the control plane's D1 (control-plane/oauth-grants.ts),
// because the provider rewrites it on the code exchange and on every refresh and the next refresh
// must read that write, which KV does not promise across locations. Every other key stays in KV.
//
// WHY THIS EXISTS, AND WHEN IT GOES: the library has no storage option. Its refresh-token rotation
// on eventually consistent KV is cloudflare/workers-oauth-provider#214, and #312 (pluggable storage
// providers, with a Durable Object adapter that serializes a grant's exchanges) is the fix it
// proposes. When the library ships storage with strongly consistent grants, switch to it and
// delete this file and control-plane/oauth-grants.ts. The pinned test in
// __workers-tests__/oauth.test.ts ("the library's own grant storage…") runs the library with no
// shim and fails until then.
//
// WHAT THIS ASSUMES OF THE LIBRARY (1.0.0; re-check on every upgrade):
//   • `grant:` keys are the only ones it rewrites while they matter. A `token:` key (an access
//     token) is written once. A `client:` key (a dynamically registered client) is rewritten only
//     by `updateClient`, which the platform never calls, and by the renewal of a registration past
//     half its lifetime — a stale copy of that is still a valid client, so it stays in KV. A new
//     rewritten key outside `grant:` would silently stay in KV with the stale-read bug; the
//     tripwire test in __workers-tests__/oauth.test.ts ("the library writes no key but a grant
//     twice") fails on it.
//   • The `metadata` of a grant's put (its client, resource and redirect URI, since 1.0) is dropped,
//     and `list` answers none: the library then reads each listed grant whole. Only
//     `completeAuthorization`'s revocation of earlier grants lists with metadata, and every call
//     here passes `revokeExistingGrants: false`.
//   • It calls these four members only, in the shapes below.
import { ControlPlane } from "./control-plane/edge.ts";
import type { Env } from "./env.ts";
import { isRetryableTransportError } from "./retryable-error.ts";
import { watchSlowStep } from "./sign-in-watch.ts";

const GRANT_KEY_PREFIX = "grant:";

/** The provider's calls on its store: `get` as text or JSON, `put` of a string with an absolute
 *  (`expiration`) or relative (`expirationTtl`) expiry, `delete`, and `list` by prefix with a
 *  cursor. */
export function providerStore(env: Pick<Env, "DB" | "OAUTH_KV">): KVNamespace {
  const kv = env.OAUTH_KV;
  const controlPlane = new ControlPlane(env);
  /** A call on either store, still pending after five seconds, logs `oauth.step-slow` naming it
   *  while it waits (sign-in-watch.ts): a code exchange reads and rewrites its grant in the control
   *  plane and writes its access token to KV. A KV call names its key's kind, never the key. */
  const watched = <T>(step: string, work: PromiseLike<T>, key?: string | null) =>
    watchSlowStep({ event: "oauth.step-slow", step, keyKind: key?.split(":", 1)[0] }, work);
  /** Asked again ONCE when D1 failed on the platform's side and says to send it again (edge.ts
   *  `ControlPlaneUnavailableError`, `retryable`). Each operation is idempotent (a read, or a
   *  whole-row write or delete); a second failure throws. The retry is a platform failure, which the
   *  prd fault alarm counts. */
  const ask = async <T>(operation: string, call: () => Promise<T>): Promise<T> => {
    const step = `grant-store-${operation}`;
    try {
      return await watched(step, call());
    } catch (error) {
      if (!isRetryableTransportError(error)) throw error;
      console.warn({
        event: "oauth.platform-failure-grant-store-retry",
        name: step,
        message: String(error),
      });
      return watched(step, call());
    }
  };
  const store = {
    async get(key: string, options?: "text" | "json" | { type?: "text" | "json" }) {
      const type = typeof options === "string" ? options : options?.type;
      if (!key.startsWith(GRANT_KEY_PREFIX))
        return watched("kv-get", type === "json" ? kv.get(key, "json") : kv.get(key), key);
      const value = await ask("get", () => controlPlane.oauthGrant(key));
      return type === "json" && value ? JSON.parse(value) : value;
    },
    put(key: string, value: string, options: KVNamespacePutOptions = {}) {
      if (!key.startsWith(GRANT_KEY_PREFIX))
        return watched("kv-put", kv.put(key, value, options), key);
      const expiresAt =
        options.expiration ??
        (options.expirationTtl === undefined
          ? null
          : Math.floor(Date.now() / 1000) + options.expirationTtl);
      return ask("put", () => controlPlane.putOAuthGrant(key, value, expiresAt));
    },
    delete(key: string) {
      if (!key.startsWith(GRANT_KEY_PREFIX)) return watched("kv-delete", kv.delete(key), key);
      return ask("delete", () => controlPlane.deleteOAuthGrant(key));
    },
    list(options: KVNamespaceListOptions = {}) {
      const { prefix, cursor, limit } = options;
      if (!prefix?.startsWith(GRANT_KEY_PREFIX))
        return watched("kv-list", kv.list(options), prefix);
      return ask("list", () =>
        controlPlane.listOAuthGrants(prefix, { cursor: cursor || undefined, limit }),
      );
    },
  };
  // The provider calls only these four members, in the shapes above; KVNamespace's others
  // (getWithMetadata, a bulk get of many keys) it never calls.
  return store as unknown as KVNamespace;
}
