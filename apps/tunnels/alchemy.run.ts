import alchemy from "alchemy";
import { DurableObjectNamespace, Worker } from "alchemy/cloudflare";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";
import { slugify } from "@iterate-com/shared/slugify";
import { ensureProxiedDnsForHostnames } from "@iterate-com/shared/alchemy/iterate-app";
import { z } from "zod/v4";
import type { CaptunServerShard } from "captun/worker";

const APP_NAME = "tunnels";

const AlchemyEnv = z.object({
  ALCHEMY_PASSWORD: z.string().trim().min(1),
  ALCHEMY_LOCAL: z.stringbool().optional(),
  ALCHEMY_STAGE: z.string().trim().min(1),
  CLOUDFLARE_API_TOKEN: z.string().trim().min(1),
  CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1),
  /** Gateway hostname, e.g. tunnels.iterate.com — tunnels live at <name>.<hostname>. */
  CAPTUN_HOSTNAME: z.string().trim().min(1),
  /** Gateway Secret: clients must present it as their connect token. */
  CAPTUN_TOKEN: z.string().trim().min(1),
  SHARD_COUNT: z.string().trim().default("1"),
});

const env = AlchemyEnv.parse(process.env);

const app = await alchemy(APP_NAME, {
  password: env.ALCHEMY_PASSWORD,
  stage: env.ALCHEMY_STAGE,
  ...(env.ALCHEMY_LOCAL ? { local: true } : {}),
  adopt: true,
  stateStore: (scope) =>
    scope.local
      ? new SQLiteStateStore(scope, { engine: "libsql" })
      : new CloudflareStateStore(scope),
});

const workerName = slugify(`${APP_NAME}-${app.stage}`);
const hostnames = [env.CAPTUN_HOSTNAME, `*.${env.CAPTUN_HOSTNAME}`];

const captunServerShard = DurableObjectNamespace<CaptunServerShard>("captun-server-shard", {
  className: "CaptunServerShard",
  sqlite: true,
});

const worker = await Worker(APP_NAME, {
  name: workerName,
  entrypoint: "./src/worker.ts",
  adopt: true,
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    CaptunServerShard: captunServerShard,
    CAPTUN_TOKEN: alchemy.secret(env.CAPTUN_TOKEN),
    CUSTOM_HOSTNAME: env.CAPTUN_HOSTNAME,
    SHARD_COUNT: env.SHARD_COUNT,
  },
  routes: hostnames.map((hostname) => ({ pattern: `${hostname}/*`, adopt: true })),
  observability: { enabled: true },
});

console.dir({ url: `https://${env.CAPTUN_HOSTNAME}`, workersDevUrl: worker.url }, { depth: null });

await app.finalize();

if (!app.local) {
  await ensureProxiedDnsForHostnames({
    hostnames,
    comment: `Managed by tunnels alchemy (${app.stage}).`,
  });
}

export { worker };
