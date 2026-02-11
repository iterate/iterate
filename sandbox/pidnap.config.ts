import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "pidnap";

const home = homedir();
const iterateRepo = process.env.ITERATE_REPO ?? join(home, "src/github.com/iterate/iterate");
const sandboxDir = join(iterateRepo, "sandbox");
const envFile = join(home, ".iterate/.env");
const mitmproxyDir = join(home, ".mitmproxy");
const caCert = join(mitmproxyDir, "mitmproxy-ca-cert.pem");
const proxyPort = "8888";
const githubMagicToken = encodeURIComponent("getIterateSecret({secretKey: 'github.access_token'})");
const cloudflareTunnelHostname = process.env.CLOUDFLARE_TUNNEL_HOSTNAME?.trim();
const cloudflareTunnelUrl = process.env.CLOUDFLARE_TUNNEL_URL?.trim() || "http://127.0.0.1:3000";

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
      GITHUB_MAGIC_TOKEN: githubMagicToken,
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
        reloadDelay: false,
      },
    },
    {
      name: "daemon-discord",
      definition: {
        command: "tsx",
        args: ["discord/index.ts"],
        cwd: `${iterateRepo}/apps/daemon`,
        env: {
          NODE_ENV: "production",
        },
      },
      options: {
        restartPolicy: "on-failure",
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
    },
    ...(cloudflareTunnelHostname
      ? [
          {
            name: "cloudflare-tunnel",
            definition: {
              command: "cloudflared",
              args: [
                "tunnel",
                "--no-autoupdate",
                "--url",
                cloudflareTunnelUrl,
                "--hostname",
                cloudflareTunnelHostname,
              ],
            },
            options: {
              restartPolicy: "always" as const,
              backoff: {
                type: "exponential" as const,
                initialDelayMs: 1000,
                maxDelayMs: 30000,
              },
            },
            dependsOn: ["daemon-frontend"],
          },
        ]
      : []),
  ],
});
