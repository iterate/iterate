import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "pidnap";

const home = homedir();
const iterateRepo = process.env.ITERATE_REPO ?? join(home, "src/github.com/iterate/iterate");
const tsxPath = `${iterateRepo}/packages/pidnap/node_modules/.bin/tsx`;
const caddyConfigDir = process.env.CADDY_CONFIG_DIR ?? join(home, ".iterate/caddy");
const caddyRootCaddyfile = process.env.CADDY_ROOT_CADDYFILE ?? join(caddyConfigDir, "Caddyfile");
const iteratePublicBaseUrl = process.env.ITERATE_PUBLIC_BASE_URL ?? "http://iterate.localhost";
const iteratePublicBaseUrlType = process.env.ITERATE_PUBLIC_BASE_URL_TYPE ?? "prefix";

export default defineConfig({
  http: {
    host: "0.0.0.0",
    port: 17300,
  },
  state: {
    autosaveFile: "/var/log/pidnap/state/autosave.json",
  },
  logDir: "/var/log/pidnap",
  processes: [
    {
      name: "caddy",
      definition: {
        command: "/usr/local/bin/caddy",
        args: ["run", "--config", caddyRootCaddyfile, "--adapter", "caddyfile"],
        env: {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
          OTEL_PROPAGATORS: "tracecontext,baggage",
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
      name: "registry",
      definition: {
        command: tsxPath,
        args: [`${iterateRepo}/services/registry-service/src/server.ts`],
        env: {
          REGISTRY_SERVICE_PORT: "17310",
          CADDY_CONFIG_DIR: caddyConfigDir,
          CADDY_ROOT_CADDYFILE: caddyRootCaddyfile,
          CADDY_BIN_PATH: "/usr/local/bin/caddy",
          ITERATE_PUBLIC_BASE_URL: iteratePublicBaseUrl,
          ITERATE_PUBLIC_BASE_URL_TYPE: iteratePublicBaseUrlType,
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
          OTEL_PROPAGATORS: "tracecontext,baggage",
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
      name: "frps",
      definition: {
        command: "/usr/local/bin/frps",
        args: ["-c", "/opt/jonasland-sandbox/frps.toml"],
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
        args: [`${iterateRepo}/services/events-service/src/server.ts`],
        env: {
          PORT: "17320",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
          OTEL_PROPAGATORS: "tracecontext,baggage",
        },
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
