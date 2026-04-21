import alchemy, { type Scope } from "alchemy";
import { Ai, Vite } from "alchemy/cloudflare";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";

const APP_NAME = "ai-poc-vite";

const env = {
  ALCHEMY_PASSWORD: process.env.ALCHEMY_PASSWORD ?? "local-dev",
  ALCHEMY_STAGE: process.env.ALCHEMY_STAGE ?? "local",
  ALCHEMY_LOCAL: process.env.ALCHEMY_LOCAL === "true",
};

const stateStore = (scope: Scope) =>
  scope.local ? new SQLiteStateStore(scope, { engine: "libsql" }) : new CloudflareStateStore(scope);

if (env.ALCHEMY_LOCAL) delete process.env.CI;

const app = await alchemy(APP_NAME, {
  stage: env.ALCHEMY_STAGE,
  local: env.ALCHEMY_LOCAL,
  password: env.ALCHEMY_PASSWORD,
  stateStore,
});

export const worker = await Vite(APP_NAME, {
  name: `${APP_NAME}-${app.stage}`,
  adopt: true,
  entrypoint: "./src/worker.ts",
  compatibilityDate: "2026-04-01",
  bindings: {
    AI: Ai(),
  },
});

console.dir({ url: worker.url }, { depth: null });

await app.finalize();
