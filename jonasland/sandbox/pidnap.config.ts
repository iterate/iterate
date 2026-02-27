const iterateRepo = process.env.ITERATE_REPO ?? "/home/iterate/src/github.com/iterate/iterate";
const tsxPath = `${iterateRepo}/packages/pidnap/node_modules/.bin/tsx`;
const pidnapEventsCallbackURL =
  process.env.PIDNAP_EVENTS_CALLBACK_URL?.trim() || "http://127.0.0.1:19010/api/streams/pidnap";

export default {
  http: {
    host: "0.0.0.0",
    port: 9876,
  },
  state: {
    autosaveFile: "/var/log/pidnap/state/autosave.json",
  },
  events: {
    callbackURL: pidnapEventsCallbackURL,
    timeoutMs: 2000,
  },
  logDir: "/var/log/pidnap",
  processes: [
    {
      name: "caddy",
      definition: {
        command: "/usr/local/bin/caddy",
        args: [
          "run",
          "--config",
          `${iterateRepo}/jonasland/sandbox/caddy/Caddyfile`,
          "--adapter",
          "caddyfile",
        ],
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
          PORT: "19010",
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
      name: "events",
      definition: {
        command: tsxPath,
        args: [`${iterateRepo}/services/events-service/src/server.ts`],
        env: {
          PORT: "19010",
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
      name: "orders",
      definition: {
        command: tsxPath,
        args: [`${iterateRepo}/services/orders-service/src/server.ts`],
        env: {
          EVENTS_SERVICE_BASE_URL: "http://127.0.0.1:19010/orpc",
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
      name: "docs",
      definition: {
        command: tsxPath,
        args: [`${iterateRepo}/services/docs-service/src/server.ts`],
        env: {
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
};
