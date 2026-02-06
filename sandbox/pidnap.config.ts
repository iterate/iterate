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

const bash = (command: string) => ({
  command: "bash",
  args: ["-c", command.trim()],
});

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
    // Init tasks (run once, sequential)
    {
      name: "task-git-config",
      definition: bash(`
        # Use credential helper instead of insteadOf URL credentials.
        # The insteadOf approach embeds magic strings in the URL, which causes git to use
        # a 401-challenge flow (two requests) that breaks through the mitmproxy proxy chain.
        # A credential helper provides credentials directly, avoiding this issue.
        # The helper script lives in home-skeleton/.git-credential-helper.sh
        chmod +x ~/.git-credential-helper.sh
        git config --global credential.helper '!~/.git-credential-helper.sh'
        # Rewrite git@github.com: SSH URLs to HTTPS so they go through the proxy
        git config --global "url.https://github.com/.insteadOf" "git@github.com:"
      `),
      options: { restartPolicy: "never" },
    },
    {
      name: "task-db-migrate",
      definition: {
        command: "pnpm",
        args: ["db:migrate"],
        cwd: `${iterateRepo}/apps/daemon`,
      },
      options: { restartPolicy: "never" },
      dependsOn: ["task-git-config"],
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
        backoff: { type: "exponential", initialDelayMs: 1000, maxDelayMs: 30000 },
      },
      dependsOn: ["task-build-daemon-client"],
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
      dependsOn: ["task-build-daemon-client"],
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
      dependsOn: ["task-build-daemon-client"],
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
        reloadDelay: 500,
      },
      options: {
        restartPolicy: "always",
        backoff: { type: "exponential", initialDelayMs: 1000, maxDelayMs: 30000 },
      },
      dependsOn: ["task-build-daemon-client"],
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
