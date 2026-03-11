import { homedir } from "node:os";
import { join } from "node:path";
import type { AnyContractRouter } from "@orpc/contract";
import { defineConfig } from "pidnap";
import { serviceManifestToPidnapConfig } from "../../packages/shared/src/jonasland/index.ts";
import { daemonServiceManifest } from "../../services/daemon-contract/src/index.ts";

const home = homedir();
const iterateRepo = process.env.ITERATE_REPO ?? join(home, "src/github.com/iterate/iterate");
const tsxPath = `${iterateRepo}/packages/pidnap/node_modules/.bin/tsx`;
const caddyRuntimeUser = "iterate-caddy";
const caddyConfigDir = join(home, ".iterate/caddy");
const caddyRootCaddyfile = join(caddyConfigDir, "Caddyfile");
const otelCollectorConfigPath = `${iterateRepo}/jonasland/sandbox/otel-collector/config.yaml`;
const caddyDataHome = "/home/iterate-caddy";

const noContract = {} as AnyContractRouter;

const registryPidnapConfig = serviceManifestToPidnapConfig({
  manifest: {
    slug: "registry",
    port: 17310,
    serverEntryPoint: "services/registry/src/server.ts",
    orpcContract: noContract,
  },
  env: {
    REGISTRY_SERVICE_PORT: "17310",
    ITERATE_INGRESS_DEFAULT_SERVICE: "home",
  },
});
const eventsPidnapConfig = serviceManifestToPidnapConfig({
  manifest: {
    slug: "events",
    port: 17320,
    serverEntryPoint: "services/events/src/server.ts",
    orpcContract: noContract,
  },
});
const daemonPidnapConfig = serviceManifestToPidnapConfig({
  manifest: daemonServiceManifest,
});
const homePidnapConfig = serviceManifestToPidnapConfig({
  manifest: {
    slug: "home",
    port: 19030,
    serverEntryPoint: "services/home/src/server.ts",
    orpcContract: noContract,
  },
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
        command: "sudo",
        args: [
          "-E",
          "-u",
          caddyRuntimeUser,
          "/usr/local/bin/caddy",
          "run",
          "--config",
          caddyRootCaddyfile,
          "--adapter",
          "caddyfile",
        ],
        env: {
          HOME: caddyDataHome,
          XDG_DATA_HOME: `${caddyDataHome}/.local/share`,
          XDG_CONFIG_HOME: `${caddyDataHome}/.config`,
          ITERATE_INGRESS_DEFAULT_SERVICE: "home",
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
        // registry must pick up ingress env changes from ~/.iterate/.env
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
    {
      name: "daemon",
      definition: {
        command: tsxPath,
        args: [join(iterateRepo, daemonPidnapConfig.definition.args[0]!)],
        env: daemonPidnapConfig.definition.env,
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
          ZO_ROOT_USER_EMAIL: "root@example.com",
          ZO_ROOT_USER_PASSWORD: "Complexpass#123",
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
      dependsOn: ["openobserve"],
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        reloadDelay: false,
      },
    },
  ],
});
