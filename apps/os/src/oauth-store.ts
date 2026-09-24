// src/oauth-store.ts — THE PROVIDER'S STORE: `OAUTH_KV` as @cloudflare/workers-oauth-provider sees
// it. The provider has one storage interface, `env.OAUTH_KV`, and oauth.ts hands it this object there. A
// grant (`grant:<userId>:<grantId>`) lives in the control plane (control-plane/oauth-grants.ts),
// because the provider rewrites it on the code exchange and on every refresh and the next refresh
// must read that write, which KV does not promise across locations. Every other key the provider
// keeps — an access token, a registered client — is written once and then only read or deleted,
// and stays in KV.
import { ControlPlane } from "./control-plane/edge.ts";
import type { Env } from "./env.ts";
import { isRetryableTransportError } from "./retryable-error.ts";

const GRANT_KEY_PREFIX = "grant:";

/** The provider's calls on its store, in the shapes 0.10.3 makes them: `get` as text or JSON, `put`
 *  of a string with an absolute (`expiration`) or relative (`expirationTtl`) expiry, `delete`, and
 *  `list` by prefix with a cursor. */
export function providerStore(env: Pick<Env, "CONTROL_PLANE" | "OAUTH_KV">): KVNamespace {
  const kv = env.OAUTH_KV;
  const controlPlane = new ControlPlane(env.CONTROL_PLANE);
  /** Asked again ONCE when the call was cut at the transport: every deploy resets the control
   *  plane's Durable Object, and edge.ts replaces the stub the cut call threw from. Each operation
   *  is idempotent (a read, or a whole-row write or delete); a second failure throws. */
  const ask = async <T>(operation: string, call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (!isRetryableTransportError(error)) throw error;
      console.warn({ event: "oauth.grant-store-retry", operation, message: String(error) });
      return call();
    }
  };
  const store = {
    async get(key: string, options?: "text" | "json" | { type?: "text" | "json" }) {
      const type = typeof options === "string" ? options : options?.type;
      if (!key.startsWith(GRANT_KEY_PREFIX))
        return type === "json" ? kv.get(key, "json") : kv.get(key);
      const value = await ask("get", () => controlPlane.oauthGrant(key));
      return type === "json" && value ? JSON.parse(value) : value;
    },
    put(key: string, value: string, options: KVNamespacePutOptions = {}) {
      if (!key.startsWith(GRANT_KEY_PREFIX)) return kv.put(key, value, options);
      const expiresAt =
        options.expiration ??
        (options.expirationTtl === undefined
          ? null
          : Math.floor(Date.now() / 1000) + options.expirationTtl);
      return ask("put", () => controlPlane.putOAuthGrant(key, value, expiresAt));
    },
    delete(key: string) {
      if (!key.startsWith(GRANT_KEY_PREFIX)) return kv.delete(key);
      return ask("delete", () => controlPlane.deleteOAuthGrant(key));
    },
    list(options: KVNamespaceListOptions = {}) {
      const { prefix, cursor, limit } = options;
      if (!prefix?.startsWith(GRANT_KEY_PREFIX)) return kv.list(options);
      return ask("list", () =>
        controlPlane.listOAuthGrants(prefix, { cursor: cursor || undefined, limit }),
      );
    },
  };
  // The provider calls only these four members, in the shapes above; KVNamespace's others
  // (getWithMetadata, a bulk get of many keys) it never calls.
  return store as unknown as KVNamespace;
}
