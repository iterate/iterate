const otelServiceEnv = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};

const allProcesses = [
  {
    name: "caddy",
    definition: {
      command: "/usr/local/bin/caddy",
      args: ["run", "--config", "/etc/jonasland5/caddy/Caddyfile", "--adapter", "caddyfile"],
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
    name: "services",
    definition: {
      command: "/opt/jonasland5-services/node_modules/.bin/tsx",
      args: ["/opt/jonasland5-services/services/src/server.ts"],
      env: otelServiceEnv,
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
      command: "/opt/jonasland5-services/node_modules/.bin/tsx",
      args: ["/opt/jonasland5-services/events/src/server.ts"],
      env: otelServiceEnv,
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
      command: "/opt/jonasland5-services/node_modules/.bin/tsx",
      args: ["/opt/jonasland5-services/orders/src/server.ts"],
      env: otelServiceEnv,
    },
    options: {
      restartPolicy: "always",
    },
    envOptions: {
      reloadDelay: false,
    },
  },
  {
    name: "home",
    definition: {
      command: "/opt/jonasland5-sandbox/node_modules/.bin/tsx",
      args: ["/opt/jonasland5-sandbox/services/home-service.ts"],
      env: otelServiceEnv,
    },
    options: {
      restartPolicy: "always",
    },
    envOptions: {
      reloadDelay: false,
    },
  },
  {
    name: "outerbase",
    definition: {
      command: "/opt/jonasland5-sandbox/node_modules/.bin/tsx",
      args: ["/opt/jonasland5-sandbox/services/outerbase-iframe-service.ts"],
      env: otelServiceEnv,
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
      command: "node",
      args: ["/opt/jonasland5-sandbox/services/egress-service.mjs"],
    },
    options: {
      restartPolicy: "always",
    },
    envOptions: {
      reloadDelay: false,
    },
  },
  {
    name: "openobserve",
    definition: {
      command: "/usr/local/bin/openobserve",
      env: {
        ZO_HTTP_ADDR: "0.0.0.0",
        ZO_HTTP_PORT: "5080",
        ZO_LOCAL_MODE: "true",
        ZO_LOCAL_MODE_STORAGE: "disk",
        ZO_DATA_DIR: "/var/lib/openobserve",
        ZO_ROOT_USER_EMAIL: "root@example.com",
        ZO_ROOT_USER_PASSWORD: "Complexpass#123",
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
    name: "clickstack",
    definition: {
      command: "/etc/jonasland5/clickstack-launcher.sh",
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
      args: ["--config", "/etc/jonasland5/otel-collector/config.yaml"],
    },
    options: {
      restartPolicy: "always",
    },
    envOptions: {
      reloadDelay: false,
    },
  },
] as const;

const defaultEnabledProcesses = new Set([
  "caddy",
  "services",
  "events",
  "orders",
  "home",
  "outerbase",
  "egress-proxy",
  "openobserve",
  "otel-collector",
]);

const selectedProcessNames = process.env.JONASLAND5_ENABLED_PROCESSES?.split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const processAllowSet =
  selectedProcessNames && selectedProcessNames.length > 0
    ? new Set(selectedProcessNames)
    : defaultEnabledProcesses;

export default {
  http: {
    host: "0.0.0.0",
    port: 9876,
  },
  state: {
    autosaveFile: "/var/log/pidnap/state/autosave.json",
  },
  logDir: "/var/log/pidnap",
  processes: allProcesses.filter((entry) => processAllowSet.has(entry.name)),
};
