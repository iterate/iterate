/**
 * PM2 ecosystem config for sandbox services.
 * Reads env vars from ~/.iterate/.env on every restart.
 */

const fs = require("fs");
const path = require("path");

const ITERATE_REPO = process.env.ITERATE_REPO || "/home/iterate/src/github.com/iterate/iterate";
const ENV_PATH = path.join(process.env.HOME || "/home/iterate", ".iterate", ".env");
const BOOTSTRAP_SCRIPT = "/home/iterate/.local/bin/iterate-daemon-bootstrap.sh";
const ENV_REFRESH_SCRIPT = "/home/iterate/.local/bin/env-refresh-cron.sh";

function parseEnvFile(contents) {
  const result = {};
  const lines = contents.split(/\r?\n/);

  for (const line of lines) {
    if (!line || line.trim().startsWith("#")) continue;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2] ?? "";

    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }

    value = value.replace(/\\n/g, "\n");
    result[key] = value;
  }

  return result;
}

let envConfig = {};
try {
  if (fs.existsSync(ENV_PATH)) {
    envConfig = parseEnvFile(fs.readFileSync(ENV_PATH, "utf8"));
  }
} catch (err) {
  console.error("[ecosystem.config.cjs] Failed to read .env:", err?.message || err);
}

const services = [
  {
    name: "iterate-daemon",
    cwd: "/home/iterate",
    script: BOOTSTRAP_SCRIPT,
    exec_interpreter: "/bin/bash",
    env: {
      ...envConfig,
      HOSTNAME: "0.0.0.0",
      PORT: "3000",
      ITERATE_REPO,
    },
    meta: {
      displayName: "Iterate Server",
      description: "Main daemon server with web UI",
      ports: [
        {
          name: "http",
          port: 3000,
          protocol: "http",
          healthEndpoint: "/api/health",
          hasWebUI: true,
        },
      ],
    },
  },
  {
    name: "opencode",
    script: "opencode",
    args: "serve --port 4096 --hostname 0.0.0.0 --log-level DEBUG",
    env: {
      ...envConfig,
      ITERATE_REPO,
    },
    meta: {
      displayName: "OpenCode",
      description: "AI coding assistant server",
      ports: [
        {
          name: "http",
          port: 4096,
          protocol: "http",
          healthEndpoint: "/session",
          hasWebUI: true,
        },
      ],
    },
  },
  {
    name: "env-refresh-cron",
    cwd: "/home/iterate",
    script: ENV_REFRESH_SCRIPT,
    exec_interpreter: "/bin/bash",
    env: {
      ...envConfig,
      ITERATE_REPO,
    },
    meta: {
      displayName: "Env Refresh Cron",
      description: "Refresh env vars from control plane every minute",
    },
  },
];

module.exports = {
  apps: services,
  _meta: Object.fromEntries(services.map((service) => [service.name, service.meta])),
};
