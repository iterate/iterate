import { homedir } from "node:os";
import { defineConfig } from "pidnap";

const home = homedir();
const iterateRepo = process.env.ITERATE_REPO ?? `${home}/src/github.com/iterate/iterate`;
const sandboxDir = `${iterateRepo}/apps/os/sandbox`;
const envFile = `${home}/.iterate/.env`;
const mitmproxyDir = `${home}/.mitmproxy`;
const caCert = `${mitmproxyDir}/mitmproxy-ca-cert.pem`;

export default defineConfig({
  logDir: "/var/log/pidnap",
  envFile,
  tasks: [
    // Generate mitmproxy CA cert if missing
    {
      name: "generate-ca",
      definition: {
        command: "sh",
        args: [
          "-c",
          `
          if [ ! -f "${caCert}" ]; then
            echo "Generating CA certificate..."
            mkdir -p "${mitmproxyDir}"
            mitmdump -p 0 --set confdir="${mitmproxyDir}" &
            PID=$!
            sleep 2
            kill $PID 2>/dev/null || true
          else
            echo "CA certificate already exists"
          fi
          `,
        ],
      },
    },
    // Install CA cert to system trust store
    {
      name: "install-ca",
      definition: {
        command: "sh",
        args: [
          "-c",
          `
          if [ -f "${caCert}" ]; then
            sudo mkdir -p /usr/local/share/ca-certificates/iterate
            sudo cp "${caCert}" /usr/local/share/ca-certificates/iterate/mitmproxy-ca.crt
            sudo update-ca-certificates
          fi
          `,
        ],
      },
    },
    // Run database migrations for daemon
    {
      name: "db-migrate",
      definition: {
        command: "pnpm",
        args: ["db:migrate"],
        cwd: `${iterateRepo}/apps/daemon`,
      },
    },
  ],
  processes: [
    {
      name: "egress-proxy",
      definition: {
        command: "mitmdump",
        args: [
          "-p",
          "8888",
          "--set",
          `confdir=${mitmproxyDir}`,
          "-s",
          `${sandboxDir}/egress-proxy-addon.py`,
          "--ssl-insecure",
        ],
      },
      envOptions: {
        reloadDelay: false,
      },
      options: {
        restartPolicy: "always",
        backoff: { type: "exponential", initialDelayMs: 1000, maxDelayMs: 30000 },
      },
    },
    {
      name: "iterate-daemon",
      definition: {
        command: "tsx",
        args: ["server.ts"],
        cwd: `${iterateRepo}/apps/daemon`,
        env: {
          HOSTNAME: "0.0.0.0",
          PORT: "3000",
        },
      },
      options: {
        restartPolicy: "always",
        backoff: { type: "exponential", initialDelayMs: 1000, maxDelayMs: 30000 },
      },
      envOptions: {
        inheritGlobalEnv: false,
      },
    },
    {
      name: "opencode",
      definition: {
        // Note, the client needs to handle the working directory by passing in a directory when creating a client using the SDK.
        command: "opencode",
        args: ["serve", "--port", "4096", "--hostname", "0.0.0.0", "--log-level", "DEBUG"],
      },
      envOptions: {
        reloadDelay: 500,
      },
      options: {
        restartPolicy: "always",
        backoff: { type: "exponential", initialDelayMs: 1000, maxDelayMs: 30000 },
      },
    },
  ],
});
