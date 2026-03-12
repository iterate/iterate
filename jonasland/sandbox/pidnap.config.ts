import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "pidnap";
import { daemonServiceManifest } from "../../services/daemon-contract/src/index.ts";

const home = homedir();
const iterateRepo = process.env.ITERATE_REPO ?? join(home, "src/github.com/iterate/iterate");
const tsxPath = `${iterateRepo}/packages/pidnap/node_modules/.bin/tsx`;
const caddyRuntimeUser = "iterate-caddy";
const caddyConfigDir = join(home, ".iterate/caddy");
const caddyRootCaddyfile = join(caddyConfigDir, "Caddyfile");
const otelCollectorConfigPath = `${iterateRepo}/jonasland/sandbox/otel-collector/config.yaml`;
const caddyDataHome = "/home/iterate-caddy";
const cloudflareTunnelMetricsAddress = "127.0.0.1:20241";

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
        reloadDelay: "immediately",
      },
    },
    {
      name: "registry",
      definition: {
        command: tsxPath,
        args: [join(iterateRepo, "services/registry/src/server.ts")],
        env: {
          PORT: "17310",
          REGISTRY_SERVICE_PORT: "17310",
          ITERATE_INGRESS_DEFAULT_SERVICE: "home",
        },
      },
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        // registry must pick up ingress env changes from ~/.iterate/.env
        reloadDelay: "immediately",
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
        reloadDelay: "immediately",
      },
    },
    {
      name: "cloudflare-tunnel",
      // cloudflared exposes /ready on its metrics listener once it has at least
      // one live edge connection, so pidnap can wait on real tunnel readiness
      // instead of just "process started".
      definition: {
        command: "sh",
        args: [
          "-lc",
          [
            'if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then',
            `  exec cloudflared tunnel --metrics ${cloudflareTunnelMetricsAddress} run --token "$CLOUDFLARE_TUNNEL_TOKEN"`,
            "fi",
            "exec sleep infinity",
          ].join("\n"),
        ],
      },
      healthCheck: {
        url: `http://${cloudflareTunnelMetricsAddress}/ready`,
        intervalMs: 2_000,
      },
      dependsOn: ["caddy"],
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        reloadDelay: "immediately",
        onlyRestartIfChanged: ["CLOUDFLARE_TUNNEL_TOKEN"],
      },
    },
    {
      name: "events",
      definition: {
        command: tsxPath,
        args: [join(iterateRepo, "services/events/src/server.ts")],
        env: {
          PORT: "17320",
        },
      },
      dependsOn: ["registry"],
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        reloadDelay: "immediately",
      },
    },
    {
      name: "daemon",
      definition: {
        command: tsxPath,
        args: [join(iterateRepo, daemonServiceManifest.serverEntryPoint)],
        env: {
          PORT: String(daemonServiceManifest.port),
        },
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
        args: [join(iterateRepo, "services/home/src/server.ts")],
        env: {
          PORT: "19030",
        },
      },
      dependsOn: ["registry"],
      options: {
        restartPolicy: "never",
      },
      envOptions: {
        reloadDelay: "immediately",
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
        reloadDelay: "immediately",
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
        reloadDelay: "immediately",
      },
    },
  ],
});
