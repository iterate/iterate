import alchemy from "alchemy";
import { WranglerJson } from "alchemy/cloudflare";

process.env.ALCHEMY_CI_STATE_STORE_CHECK ??= "false";

const compatibilityDate = "2025-02-24";
const testDatabaseId = "00000000-0000-0000-0000-000000000000";

const app = await alchemy("ingress-proxy");

await WranglerJson({
  path: "./wrangler.jsonc",
  worker: {
    name: "ingress-proxy-test",
    entrypoint: "./server.ts",
    compatibilityDate,
    compatibilityFlags: ["nodejs_compat_v2"],
    bindings: {
      DB: {
        type: "d1",
        id: testDatabaseId,
        name: "ingress-proxy-test",
        migrationsDir: "./migrations",
        dev: {
          id: testDatabaseId,
          remote: false,
        },
      },
      INGRESS_PROXY_API_TOKEN: "test-token",
      TYPEID_PREFIX: "tst",
    },
  },
  secrets: false,
});

await app.finalize({ noop: true });
