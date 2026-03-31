import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "pidnap";

const home = homedir();
const iterateRepo = process.env.ITERATE_REPO ?? join(home, "src/github.com/iterate/iterate");
const daemonAppRoot = join(iterateRepo, "apps/daemon-v2");
const exampleAppRoot = join(iterateRepo, "apps/example");
const eventsAppRoot = join(iterateRepo, "apps/events");
const wrappedDevCommand = 'exec pnpm dev -- --host "$HOST" --port "$PORT"';
// Static bootstrap handlers are committed in `builtin-handlers.caddy`.
// Dynamic registry-managed handlers are written here by the registry service.
const syncToCaddyPath = join(home, ".iterate", "registry-app-routes.caddy");
const caddyDataHome = "/home/iterate-caddy";

export default defineConfig({
  // pidnap's api server is always on localhost:17300
  // (though once caddy is alive it can be accessed using pidnap.iterate.localhost)
  http: {
    host: "0.0.0.0",
    port: 17300, // 173 = ITE haha
  },
  envFile: join(home, ".iterate/.env"),
  state: {
    autosaveFile: "/var/log/pidnap/state/autosave.json",
  },
  logDir: join(home, ".iterate/pidnap-logs"),
  // Bootstrap routing rule: if a default-on service needs ingress before
  // registry has started, it should have a committed built-in handler in
  // `builtin-handlers.caddy`. Registry then owns only the dynamic fragment.
  // todo refactor so we can use the manifest to pidnap process helpers here
  processes: [
    {
      name: "caddy",
      definition: {
        // Keep the target user's HOME/XDG dirs explicit. Without -E, sudo resets
        // env and Caddy relies on iterate-caddy's login-home defaults instead.
        // With -E, this env block is preserved so Caddy writes PKI/state under
        // /home/iterate-caddy instead of inheriting /home/iterate from pidnap.
        command: "sudo",
        args: [
          "-E",
          "-u",
          "iterate-caddy",
          "/usr/local/bin/caddy",
          "run",
          // This --watch is very important, because it means that caddy will reload when the registry service
          // writes to ~/.iterate/registry-app-routes.caddy
          "--watch",
          "--config",
          join(home, ".iterate", "Caddyfile"),
        ],
        env: {
          HOME: caddyDataHome,
          // Caddy imports this path and reloads it automatically via `--watch`.
          SYNC_TO_CADDY_PATH: syncToCaddyPath,
          XDG_DATA_HOME: `${caddyDataHome}/.local/share`,
          XDG_CONFIG_HOME: `${caddyDataHome}/.config`,
        },
      },
      envOptions: {
        onlyRestartIfChanged: [
          "ITERATE_INGRESS_DEFAULT_APP",
          "ITERATE_INGRESS_HOST",
          "ITERATE_INGRESS_ROUTING_TYPE",
          "ITERATE_EGRESS_PROXY",
          "SYNC_TO_CADDY_PATH",
        ],
      },
    },
    {
      name: "daemon",
      definition: {
        command: "pnpm",
        cwd: daemonAppRoot,
        args: ["vite", "dev", "--", "--host", "0.0.0.0", "--port", "17310"],
        env: {
          REGISTRY_DB_PATH: join(home, ".iterate", "daemon.db"),
          // Registry never talks to the Caddy admin API directly; it only writes
          // the dynamic fragment and lets Caddy's `--watch` loop pick it up.
          SYNC_TO_CADDY_PATH: syncToCaddyPath,
        },
      },
      healthCheck: {
        url: "http://registry.iterate.localhost/api/__common/health",
        intervalMs: 2_000,
      },
    },
    // The FRP server is needed for e2e tests. Its purpose is for vitest e2e test runners to establish a tunnel
    // with a deployment, which can then be used as egress proxy target from the deployment.
    // This is used in e2e tests to send all traffic out the container to a test-specific mock-http-server
    // running in the vitest server - possibly far away across the internet (when testing fly machines, for example)    // TODO this should not be in the default pidnap config
    {
      name: "frps",
      definition: {
        command: "/usr/local/bin/frps",
        args: ["-c", join(home, ".iterate", "frps.toml")],
      },
    },
    // Cloudflare tunnel is used primarily by docker-deployment.ts to allow HTTP clients from across
    // the internet to call _into_ the deployment. Most importantly, our own ingress proxy worker
    // in cloudflare needs to be able to reach caddy in the deployment.
    // In fly-deployment.ts this is not necessary because the fly app has a public <slug>.fly.dev URL
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
            '  exec cloudflared tunnel --metrics 127.0.0.1:20241 run --token "$CLOUDFLARE_TUNNEL_TOKEN"',
            "fi",
            "exec sleep infinity",
          ].join("\n"),
        ],
      },
      healthCheck: {
        url: "http://127.0.0.1:20241/ready",
        intervalMs: 2_000,
      },
      dependsOn: ["caddy"],
      envOptions: {
        onlyRestartIfChanged: ["CLOUDFLARE_TUNNEL_TOKEN"],
      },
    },
    {
      name: "example",
      definition: {
        command: "tsx",
        args: [
          "./scripts/run-app.ts",
          "--app",
          "./src/app.ts",
          "--cwd",
          exampleAppRoot,
          "--health-check",
          "/api/__common/health",
          "--tag",
          "openapi",
          "--",
          "sh",
          "-lc",
          wrappedDevCommand,
        ],
        cwd: daemonAppRoot,
        env: {
          DB_PATH: join(home, ".iterate", "example.db"),
          APP_CONFIG: JSON.stringify({
            pirateSecret: "arrr",
          }),
        },
      },
      healthCheck: {
        url: "http://example.iterate.localhost/api/__common/health",
        intervalMs: 2_000,
      },
      dependsOn: ["daemon"],
      options: {
        restartPolicy: "always",
      },
    },
    {
      name: "events",
      definition: {
        command: "tsx",
        args: [
          "./scripts/run-app.ts",
          "--app",
          "./src/app.ts",
          "--cwd",
          eventsAppRoot,
          "--health-check",
          "/api/__common/health",
          "--tag",
          "openapi",
          "--",
          "sh",
          "-lc",
          wrappedDevCommand,
        ],
        cwd: daemonAppRoot,
        env: {
          DB_PATH: join(home, ".iterate", "events.db"),
        },
      },
      healthCheck: {
        url: "http://events.iterate.localhost/api/__common/health",
        intervalMs: 2_000,
      },
      dependsOn: ["daemon"],
      options: {
        restartPolicy: "always",
      },
    },
    // {
    //   name: "openobserve",
    //   definition: {
    //     command: "/usr/local/bin/openobserve",
    //     args: [],
    //     env: {
    //       ZO_ROOT_USER_EMAIL: "test@nustom..com",
    //       ZO_ROOT_USER_PASSWORD: "424242",
    //       ZO_LOCAL_MODE: "true",
    //       ZO_DATA_DIR: `${home}/.iterate/openobserve`,
    //       ZO_MMDB_DISABLE_DOWNLOAD: "true",
    //       ZO_TELEMETRY: "false",
    //       RUST_LOG: "warn",
    //     },
    //   },
    // },
    // {
    //   name: "otel-collector",
    //   definition: {
    //     command: "/usr/local/bin/otelcol-contrib",
    //     args: [
    //       "--config",
    //       join(home, ".iterate", "config-otel-collector.yaml"),
    //       "--set=service.telemetry.metrics.level=None",
    //     ],
    //   },
    //   dependsOn: ["openobserve"],
    // },
  ],
});
