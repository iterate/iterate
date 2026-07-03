/**
 * Ensure the tunnels gateway's DNS records exist:
 *
 *   pnpm ensure-resources --env prd
 *
 * Idempotent and create-only — it NEVER deletes anything. The gateway needs
 * proxied originless records for its hostname AND the `*.` wildcard (every
 * tunnel lives at `<name>.<hostname>`); worker zone routes only fire when a
 * proxied DNS record answers the hostname. Both records already exist in prd,
 * so this is normally a no-op read.
 */
import { tunnelsEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

const ctx = await resolveEnvContext({ envs: tunnelsEnvs, dopplerProject: "tunnels" });
const { env, cfV4 } = ctx;
console.log(`Ensuring resources for ${ctx.name} in account ${env.cloudflareAccountId}`);

const zones = await cfV4<{ id: string; name: string }[]>(
  `/zones?account.id=${env.cloudflareAccountId}&per_page=500`,
);
for (const host of [env.hostname, `*.${env.hostname}`]) {
  const bare = host.replace(/^\*\./, "");
  const zone = zones.find(
    (candidate) => bare === candidate.name || bare.endsWith(`.${candidate.name}`),
  );
  if (!zone) {
    console.warn(`⚠ no zone for ${host} in this account — create the zone first, then re-run`);
    continue;
  }
  // Any record type counts as "exists" — create-only means we never fight
  // an operator's hand-made record.
  const existing = await cfV4<unknown[]>(
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}&per_page=5`,
  );
  if (existing.length > 0) {
    console.log(`DNS record for ${host} exists`);
    continue;
  }
  await cfV4(`/zones/${zone.id}/dns_records`, {
    method: "POST",
    body: JSON.stringify({
      type: "AAAA",
      name: host,
      content: "100::", // originless: traffic terminates at the Worker route
      proxied: true,
      comment: `iterate ${ctx.name} tunnels gateway route host (ensure-resources.ts)`,
    }),
  });
  console.log(`created proxied DNS record for ${host}`);
}
console.log(`✅ ${ctx.name} DNS all present`);
