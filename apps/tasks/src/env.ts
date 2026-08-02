/** Worker bindings (wrangler.jsonc declares exactly these). No secrets and
 * no storage — auth is the per-connection session token, proven by use
 * against os, and every board lives on a platform workspace. */
export type AppEnv = {
  OS_BASE_URL: string;
};
