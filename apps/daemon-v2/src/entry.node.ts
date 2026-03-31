import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import handler from "@tanstack/react-start/server-entry";
import { z } from "zod";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext, RuntimeEnv as RuntimeEnvShape } from "~/context.ts";
import { getRegistryDatabase } from "~/db/index.ts";
import { spawnNodePtyProcess } from "~/lib/node-pty.ts";
import { initializeDaemonV2 } from "~/lib/registry-startup.ts";
import { RegistryStore } from "~/lib/registry-store.ts";
import { createTerminalWebSocketHooks } from "~/lib/terminal-websocket.ts";

const nonEmptyStringWithTrimDefault = (defaultValue: string) =>
  z
    .preprocess((value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    }, z.string().min(1).optional())
    .default(defaultValue);

const optionalNonEmptyStringWithTrim = () =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }, z.string().min(1).optional());

const ingressRoutingType = z
  .preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }, z.enum(["dunder-prefix", "subdomain-host"]).optional())
  .default("subdomain-host");

const RuntimeEnv = z.object({
  REGISTRY_APP_HOST: nonEmptyStringWithTrimDefault("0.0.0.0"),
  REGISTRY_APP_PORT: z.coerce.number().int().min(1).max(65535).default(17310),
  REGISTRY_DB_PATH: nonEmptyStringWithTrimDefault("./data/registry.sqlite"),
  REGISTRY_DB_STUDIO_EMBED_URL: nonEmptyStringWithTrimDefault(
    "https://studio.outerbase.com/embed/sqlite",
  ),
  REGISTRY_DB_STUDIO_NAME: nonEmptyStringWithTrimDefault("jonasland sqlite"),
  REGISTRY_DB_BASIC_AUTH_USER: optionalNonEmptyStringWithTrim(),
  REGISTRY_DB_BASIC_AUTH_PASS: z.string().default(""),
  SYNC_TO_CADDY_PATH: optionalNonEmptyStringWithTrim(),
  ITERATE_INGRESS_HOST: nonEmptyStringWithTrimDefault("iterate.localhost"),
  ITERATE_INGRESS_ROUTING_TYPE: ingressRoutingType,
  ITERATE_INGRESS_DEFAULT_APP: nonEmptyStringWithTrimDefault("registry"),
});

const env: RuntimeEnvShape = RuntimeEnv.parse(process.env);
const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: process.env,
});
const db = getRegistryDatabase(env.REGISTRY_DB_PATH);
const storePromise = RegistryStore.open(env.REGISTRY_DB_PATH);

await initializeDaemonV2({
  env,
  getStore: () => storePromise,
});

export default {
  async fetch(request: Request) {
    return withEvlog(
      {
        request,
        manifest,
        config,
      },
      async ({ log }) => {
        const context: AppContext = {
          manifest,
          config,
          env,
          rawRequest: request,
          db,
          getStore: () => storePromise,
          pty: (request) =>
            createTerminalWebSocketHooks({
              request,
              spawn: spawnNodePtyProcess,
            }),
          log,
        };

        return handler.fetch(request, {
          context,
        });
      },
    );
  },
};
