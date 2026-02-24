const allProcesses = [
  {
    name: "caddy",
    definition: {
      command: "/usr/local/bin/caddy",
      args: ["run", "--config", "/etc/jonasland5/caddy/Caddyfile", "--adapter", "caddyfile"],
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
] as const;

const selectedProcessNames = process.env.JONASLAND5_ENABLED_PROCESSES?.split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const processAllowSet =
  selectedProcessNames && selectedProcessNames.length > 0
    ? new Set(selectedProcessNames)
    : undefined;

export default {
  http: {
    host: "0.0.0.0",
    port: 9876,
  },
  state: {
    autosaveFile: "/var/log/pidnap/state/autosave.json",
  },
  logDir: "/var/log/pidnap",
  processes:
    processAllowSet === undefined
      ? [...allProcesses]
      : allProcesses.filter((entry) => processAllowSet.has(entry.name)),
};
