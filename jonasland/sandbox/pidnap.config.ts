export default {
  http: {
    host: "0.0.0.0",
    port: 9876,
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
        args: [
          "run",
          "--config",
          "/opt/jonasland-sandbox/caddy/Caddyfile",
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
        command: "/opt/pidnap/node_modules/.bin/tsx",
        args: ["/opt/services/registry-service/src/server.ts"],
        env: {
          PORT: "19010",
          EVENTS_SERVICE_ORPC_URL: "http://127.0.0.1:19010/orpc",
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
        command: "/opt/pidnap/node_modules/.bin/tsx",
        args: ["/opt/services/events-service/src/server.ts"],
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
      name: "caddy-sync",
      definition: {
        command: "/opt/pidnap/node_modules/.bin/tsx",
        args: ["/opt/jonasland-sandbox/services/caddy-sync-service.ts"],
        env: {
          CADDY_SYNC_EVENTS_SERVICE_ORPC_URL: "http://127.0.0.1:19010/orpc",
          CADDY_SYNC_REGISTRY_SERVICE_ORPC_URL: "http://127.0.0.1:8777/orpc",
          CADDY_SYNC_CADDY_ADMIN_URL: "http://127.0.0.1:2019",
          CADDY_SYNC_CADDY_LISTEN_ADDRESS: ":80",
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
        command: "/opt/pidnap/node_modules/.bin/tsx",
        args: ["/opt/services/orders-service/src/server.ts"],
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
        command: "/opt/pidnap/node_modules/.bin/tsx",
        args: ["/opt/services/docs-service/src/server.ts"],
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
