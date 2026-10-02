/** The workerd compatibility date every Iterate Worker runs on: each deployed Worker's config
 *  (scripts/lib/wrangler-config.ts and start-app.ts, core/os readWranglerBase, packages/spa's deploy)
 *  and each Worker core/os loads at runtime (context/worker-loader.ts, secret/exchange-jail.ts).
 *  Moving it changes all of them at once: every compatibility flag whose enable date it passes
 *  (workerd's src/workerd/io/compatibility-date.capnp) turns on. */
export const COMPATIBILITY_DATE = "2026-09-29";
