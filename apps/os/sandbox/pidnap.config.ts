import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "pidnap";

const home = homedir();
const iterateRepo = process.env.ITERATE_REPO ?? join(home, "src/github.com/iterate/iterate");
const sandboxDir = join(iterateRepo, "apps/os/sandbox");
const envFile = join(home, ".iterate/.env");
const mitmproxyDir = join(home, ".mitmproxy");
const caCert = join(mitmproxyDir, "mitmproxy-ca-cert.pem");
const proxyPort = "8888";
const githubMagicToken = encodeURIComponent("getIterateSecret({secretKey: 'github.access_token'})");

const bash = (command: string) => ({
  command: "bash",
  args: ["-c", command.trim()],
});

export default defineConfig({
  http: {
    host: "0.0.0.0",
    port: 9876,
  },
  logDir: "/var/log/pidnap",
  envFile,
  env: {
    ITERATE_REPO: iterateRepo,
    SANDBOX_DIR: sandboxDir,
    // Proxy Env
    PROXY_PORT: proxyPort,
    MITMPROXY_DIR: mitmproxyDir,
    CA_CERT_PATH: caCert,
    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
    HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    http_proxy: `http://127.0.0.1:${proxyPort}`,
    https_proxy: `http://127.0.0.1:${proxyPort}`,
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
    SSL_CERT_FILE: caCert,
    SSL_CERT_DIR: mitmproxyDir,
    REQUESTS_CA_BUNDLE: caCert,
    CURL_CA_BUNDLE: caCert,
    NODE_EXTRA_CA_CERTS: caCert,
    GIT_SSL_CAINFO: caCert,
    // Github Stuff
    GITHUB_MAGIC_TOKEN: githubMagicToken,
  },
  tasks: [
    {
      name: "task-git-config",
      definition: bash(
        `
          git config --global "url.https://x-access-token:${githubMagicToken}@github.com/.insteadOf" "https://github.com/"
          git config --global --add "url.https://x-access-token:${githubMagicToken}@github.com/.insteadOf" "git@github.com:"
        `,
      ),
    },
    {
      name: "task-generate-ca",
      definition: bash(
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
      ),
    },
    {
      name: "task-install-ca",
      definition: bash(
        `
          if [ -f "${caCert}" ]; then
            sudo mkdir -p /usr/local/share/ca-certificates/iterate
            sudo cp "${caCert}" /usr/local/share/ca-certificates/iterate/mitmproxy-ca.crt
            sudo update-ca-certificates
          fi
        `,
      ),
    },
    {
      name: "task-db-migrate",
      definition: {
        command: "pnpm",
        args: ["db:migrate"],
        cwd: `${iterateRepo}/apps/daemon`,
      },
    },
    {
      name: "task-build-daemon-client",
      definition: {
        command: "pnpm",
        args: ["exec", "vite", "build", "--mode", "production"],
        cwd: `${iterateRepo}/apps/daemon`,
        env: {
          NODE_ENV: "production",
        },
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
      name: "daemon-backend",
      definition: {
        command: "tsx",
        args: ["server.ts"],
        cwd: `${iterateRepo}/apps/daemon`,
        env: {
          HOSTNAME: "0.0.0.0",
          PORT: "3001",
          NODE_ENV: "production",
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
      name: "daemon-frontend",
      definition: {
        command: "pnpm",
        args: ["exec", "vite", "preview", "--host", "0.0.0.0", "--port", "3000"],
        cwd: `${iterateRepo}/apps/daemon`,
        env: {
          NODE_ENV: "production",
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
        args: [
          "serve",
          "--port",
          "4096",
          "--hostname",
          "0.0.0.0",
          "--log-level",
          "DEBUG",
          "--print-logs",
        ],
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
