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
const jaegerVersion = "1.67.0";

function bash(script: string) {
  return {
    command: "bash",
    args: ["-lc", script],
  };
}

// ITERATE_SKIP_PROXY is set by the control plane at machine creation when
// DANGEROUS_RAW_SECRETS_ENABLED is true. When set, proxy/CA vars are omitted
// so managed processes connect directly to the internet using system CAs.
const skipProxy = process.env.ITERATE_SKIP_PROXY === "true";

// Proxy and CA env vars for pidnap-managed processes.
// When skipProxy is true, these are omitted so traffic goes direct.
// The user's interactive shell gets these from ~/.iterate/.env instead (managed by daemon).
const proxyEnv: Record<string, string> = skipProxy
  ? {}
  : {
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
      GITHUB_MAGIC_TOKEN: encodeURIComponent(
        "getIterateSecret({secretKey: 'github.access_token'})",
      ),
    };

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
    PROXY_PORT: proxyPort,
    MITMPROXY_DIR: mitmproxyDir,
    CA_CERT_PATH: caCert,
    ...proxyEnv,
  },
  processes: [
    // Init tasks (run once, sequential)
    {
      name: "task-git-config",
      definition: bash(
        `
          # Use credential helper instead of insteadOf URL credentials.
          # The insteadOf approach embeds magic strings in the URL, which causes git to use
          # a 401-challenge flow (two requests) that breaks through the mitmproxy proxy chain.
          # A credential helper provides credentials directly, avoiding this issue.
          # The helper script lives in home-skeleton/.git-credential-helper.sh
          chmod +x ~/.git-credential-helper.sh
          git config --global credential.helper '!~/.git-credential-helper.sh'
          # Rewrite git@github.com: SSH URLs to HTTPS so they go through the proxy
          git config --global "url.https://github.com/.insteadOf" "git@github.com:"
        `,
      ),
      options: { restartPolicy: "never" },
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
      options: { restartPolicy: "never" },
      dependsOn: ["task-git-config"],
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
      options: { restartPolicy: "never" },
      dependsOn: ["task-generate-ca"],
    },
    {
      name: "task-db-migrate",
      definition: {
        command: "pnpm",
        args: ["db:migrate"],
        cwd: `${iterateRepo}/apps/daemon`,
      },
      options: { restartPolicy: "never" },
      dependsOn: ["task-install-ca"],
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
      options: { restartPolicy: "never" },
      dependsOn: ["task-db-migrate"],
    },
    {
      name: "task-install-jaeger",
      definition: bash(
        `
          set -euo pipefail
          BIN_DIR="$HOME/.local/bin"
          BIN_PATH="$BIN_DIR/jaeger-all-in-one"
          if [ -x "$BIN_PATH" ]; then
            exit 0
          fi
          mkdir -p "$BIN_DIR"
          ARCH=$(uname -m)
          if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
            JAEGER_ARCH="arm64"
          else
            JAEGER_ARCH="amd64"
          fi
          URL="https://github.com/jaegertracing/jaeger/releases/download/v${jaegerVersion}/jaeger-${jaegerVersion}-linux-\${JAEGER_ARCH}.tar.gz"
          TMP_DIR=$(mktemp -d)
          curl -fsSL "$URL" -o "$TMP_DIR/jaeger.tgz"
          tar -xzf "$TMP_DIR/jaeger.tgz" -C "$TMP_DIR"
          cp "$TMP_DIR/jaeger-${jaegerVersion}-linux-\${JAEGER_ARCH}/jaeger-all-in-one" "$BIN_PATH"
          chmod +x "$BIN_PATH"
          rm -rf "$TMP_DIR"
        `,
      ),
      options: { restartPolicy: "never" },
      dependsOn: ["task-build-daemon-client"],
    },
    // Long-running processes (depend on init tasks)
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
      },
      dependsOn: ["task-install-jaeger"],
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
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
        },
      },
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        inheritGlobalEnv: false,
      },
    },
    {
      name: "daemon-frontend",
      definition: {
        // Build is baked into the image.
        command: "pnpm",
        args: ["exec", "vite", "preview", "--host", "0.0.0.0", "--port", "3000"],
        cwd: `${iterateRepo}/apps/daemon`,
        env: {
          NODE_ENV: "production",
        },
      },
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        inheritGlobalEnv: false,
      },
      dependsOn: ["daemon-backend"],
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
        // TODO: confirm why opencode needs a lower env reload delay than default.
        reloadDelay: 500,
      },
      options: {
        restartPolicy: "always",
      },
      dependsOn: ["task-install-jaeger"],
    },
    {
      name: "trace-viewer",
      definition: {
        command: "jaeger-all-in-one",
        args: [
          "--collector.otlp.enabled=true",
          "--collector.otlp.http.host-port=0.0.0.0:4318",
          "--collector.otlp.grpc.host-port=0.0.0.0:4317",
          "--query.http-server.host-port=0.0.0.0:16686",
        ],
      },
      envOptions: {
        reloadDelay: false,
      },
      options: {
        restartPolicy: "always",
        backoff: { type: "exponential", initialDelayMs: 1000, maxDelayMs: 30000 },
      },
      dependsOn: ["task-install-jaeger"],
    },
  ],
});
