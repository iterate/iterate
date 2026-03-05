import { homedir } from "node:os";
import { join } from "node:path";
import type { AnyContractRouter } from "@orpc/contract";
import { defineConfig } from "pidnap";
import {
  serviceManifestToPidnapConfig,
  type ServiceManifestWithEntryPoint,
} from "../../packages/shared/src/jonasland/index.ts";
import { serviceManifest as eventsServiceManifest } from "../../services/events-contract/src/events/index.ts";
import { registryServiceManifest } from "../../services/registry-contract/src/index.ts";

const home = homedir();
const iterateRepo = process.env.ITERATE_REPO ?? join(home, "src/github.com/iterate/iterate");
const tsxPath = `${iterateRepo}/packages/pidnap/node_modules/.bin/tsx`;
const caddyConfigDir = process.env.CADDY_CONFIG_DIR ?? join(home, ".iterate/caddy");
const caddyRootCaddyfile = process.env.CADDY_ROOT_CADDYFILE ?? join(caddyConfigDir, "Caddyfile");
const otelCollectorConfigPath = `${iterateRepo}/jonasland/sandbox/otel-collector/config.yaml`;

const noOrpcContract = {} as AnyContractRouter;
const homeServiceManifest: ServiceManifestWithEntryPoint = {
  slug: "home-service",
  port: 19030,
  serverEntryPoint: "services/home-service/src/server.ts",
  orpcContract: noOrpcContract,
};

const registryPidnapConfig = serviceManifestToPidnapConfig({
  manifest: registryServiceManifest,
  env: {
    REGISTRY_SERVICE_PORT: "17310",
  },
});
const eventsPidnapConfig = serviceManifestToPidnapConfig({
  manifest: eventsServiceManifest,
});
const homePidnapConfig = serviceManifestToPidnapConfig({
  manifest: homeServiceManifest,
});

export default defineConfig({
  // pidnap's api server is always on localhost:17300
  // (though once caddy is alive it can be accessed using pidnap.iterate.localhost)
  http: {
    host: "0.0.0.0",
    port: 17300,
  },
  envFile: join(home, ".iterate/.env"),
  state: {
    autosaveFile: "/var/log/pidnap/state/autosave.json",
  },
  logDir: "/var/log/pidnap",
  // todo refactor so we can use the manifest to pidnap process helpers here
  processes: [
    {
      name: "caddy",
      definition: {
        command: "/usr/local/bin/caddy",
        args: ["run", "--config", caddyRootCaddyfile, "--adapter", "caddyfile"],
        env: {
          ITERATE_DEFAULT_INGRESS_SERVICE: "home",
        },
      },
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        reloadDelay: 500,
      },
    },
    {
      name: "registry",
      definition: {
        command: tsxPath,
        args: [join(iterateRepo, registryPidnapConfig.definition.args[0]!)],
        env: registryPidnapConfig.definition.env,
      },
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        // registry must pick up ITERATE_PUBLIC_BASE_HOST(_TYPE) changes from ~/.iterate/.env
        reloadDelay: 500,
      },
    },
    {
      name: "frps",
      definition: {
        command: "/usr/local/bin/frps",
        args: ["-c", `${iterateRepo}/jonasland/sandbox/frps.toml`],
      },
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        reloadDelay: false,
      },
    },
    {
      name: "egress-proxy",
      definition: {
        command: tsxPath,
        args: [join(iterateRepo, "services/egress-service/src/server.ts")],
        env: {
          EGRESS_PROXY_PORT: "19000",
          EGRESS_ADMIN_PORT: "19001",
        },
      },
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        // External proxy URL may change via ~/.iterate/.env.
        reloadDelay: 500,
      },
    },
    {
      name: "events",
      definition: {
        command: tsxPath,
        args: [join(iterateRepo, eventsPidnapConfig.definition.args[0]!)],
        env: eventsPidnapConfig.definition.env,
      },
      dependsOn: ["registry"],
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        reloadDelay: false,
      },
    },
    // Optional apps (home/docs/outerbase/example) are on-demand and register routes via registry.
    {
      name: "home",
      definition: {
        command: tsxPath,
        args: [join(iterateRepo, homePidnapConfig.definition.args[0]!)],
        env: homePidnapConfig.definition.env,
      },
      dependsOn: ["registry"],
      options: {
        restartPolicy: "never",
      },
      envOptions: {
        reloadDelay: false,
      },
    },
    {
      name: "openobserve",
      definition: {
        command: "/usr/local/bin/openobserve",
        args: [],
        env: {
          ZO_ROOT_USER_EMAIL: "test@nustom.com",
          ZO_ROOT_USER_PASSWORD: "test",
          ZO_LOCAL_MODE: "true",
          ZO_DATA_DIR: "/var/lib/openobserve",
        },
      },
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        reloadDelay: false,
      },
    },
    {
      name: "otel-collector",
      definition: {
        command: "/usr/local/bin/otelcol-contrib",
        args: ["--config", otelCollectorConfigPath, "--set=service.telemetry.metrics.level=None"],
      },
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        reloadDelay: false,
      },
    },
  ],
});
