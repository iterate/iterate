import alchemy from "alchemy";
import { spawn } from "node:child_process";
import { Tunnel, Worker } from "alchemy/cloudflare";

/**
 * Minimal repro for Alchemy Tunnel wildcard behavior.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... tsx apps/os/scripts/alchemy-wildcard-tunnel-repro.ts cli --dev
 *
 * Notes:
 * - `--stage` is optional (Alchemy defaults stage from USER/USERNAME).
 * - Doppler is optional; only requirement is `CLOUDFLARE_API_TOKEN` in env.
 */
const app = await alchemy("os-tunnel-wildcard-repro", {
  phase: "up",
  destroyOrphans: false,
});

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const ITERATE_ZONE_NAME = "iterate.com";

type CloudflareApiResponse<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ message: string }>;
};
type CloudflareZone = { id: string; name: string };
type CloudflareDnsRecord = { id: string; name: string; content: string; proxied: boolean };

async function cloudflareRequest<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json()) as CloudflareApiResponse<T>;
  if (!response.ok || !payload.success) {
    const errors = payload.errors?.map((error) => error.message).join(", ") || "unknown error";
    throw new Error(`Cloudflare API ${init?.method ?? "GET"} ${path} failed: ${errors}`);
  }
  return payload.result;
}

const baseHostname = "boop.dev.iterate.com";
const wildcardHostname = "*.boop.dev.iterate.com";
const workerPort = Number(process.env.REPRO_WORKER_PORT ?? "8788");

const echoWorker = await Worker("boop-echo-worker", {
  name: "boop-echo-worker",
  adopt: true,
  delete: false,
  dev: { port: workerPort },
  script: `
export default {
  async fetch(request) {
    const host = (request.headers.get("host") ?? "").split(":")[0].toLowerCase();
    const suffix = ".boop.dev.iterate.com";
    const raw = host.endsWith(suffix) ? host.slice(0, -suffix.length) : "";
    const subdomain = raw.endsWith(".") ? raw.slice(0, -1) : raw;
    return new Response(
      "host=" + host + "\\n" + "subdomain=" + (subdomain || "(root)") + "\\n",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
};
  `,
});

if (!echoWorker.url) {
  throw new Error("Expected local dev URL for echo worker");
}
const tunnelService = new URL(echoWorker.url).origin;

const tunnel = await Tunnel("boop-wildcard-repro", {
  name: "boop-wildcard-repro",
  adopt: true,
  delete: false,
  ingress: [
    { hostname: baseHostname, service: tunnelService },
    { hostname: wildcardHostname, service: tunnelService },
    { service: "http_status:404" },
  ],
});

const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
if (!cloudflareApiToken) {
  throw new Error(
    "CLOUDFLARE_API_TOKEN is required. Example: CLOUDFLARE_API_TOKEN=... tsx apps/os/scripts/alchemy-wildcard-tunnel-repro.ts cli --dev",
  );
}

const zones = await cloudflareRequest<CloudflareZone[]>(
  cloudflareApiToken,
  `/zones?name=${encodeURIComponent(ITERATE_ZONE_NAME)}&status=active&per_page=1`,
);
const zoneId = zones[0]?.id;
if (!zoneId) {
  throw new Error(`Could not find active Cloudflare zone ${ITERATE_ZONE_NAME}`);
}

const wildcardRecords = await cloudflareRequest<CloudflareDnsRecord[]>(
  cloudflareApiToken,
  `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(wildcardHostname)}&per_page=1`,
);

const wildcardTarget = `${tunnel.tunnelId}.cfargotunnel.com`;
const recordBody = {
  type: "CNAME",
  name: wildcardHostname,
  content: wildcardTarget,
  proxied: true,
  ttl: 1,
  comment: "Managed by alchemy-wildcard-tunnel-repro.ts",
};

if (wildcardRecords[0]) {
  await cloudflareRequest<CloudflareDnsRecord>(
    cloudflareApiToken,
    `/zones/${zoneId}/dns_records/${wildcardRecords[0].id}`,
    { method: "PUT", body: JSON.stringify(recordBody) },
  );
} else {
  await cloudflareRequest<CloudflareDnsRecord>(cloudflareApiToken, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify(recordBody),
  });
}

// Why we do this manually: Alchemy Tunnel currently skips wildcard ingress hostnames
// when auto-creating DNS records:
// https://github.com/alchemy-run/alchemy/blob/main/alchemy/src/cloudflare/tunnel.ts#L614-L616
// Total TLS is one-time zone config:
// PATCH /zones/{zone_id}/acm/total_tls with {"enabled":true,...}
// After that, creating this proxied wildcard DNS record triggers auto wildcard cert issuance.

console.log("repro_worker_url", echoWorker.url);
console.log("repro_tunnel_service", tunnelService);
console.log("repro_tunnel_name", tunnel.name);
console.log("repro_tunnel_id", tunnel.tunnelId);
console.log(
  "repro_cloudflared_cmd",
  `cloudflared tunnel run --token '${tunnel.token.unencrypted}'`,
);
console.log("repro_base_hostname", baseHostname);
console.log("repro_wildcard_hostname", wildcardHostname);
console.log("repro_wildcard_target", wildcardTarget);
console.log(
  "repro_note",
  "Tunnel + local echo worker up. Wildcard DNS CNAME has been created/updated. Starting cloudflared...",
);

await app.finalize();

if (app.local) {
  const cloudflared = spawn(
    "cloudflared",
    [
      "tunnel",
      "--loglevel",
      "warn",
      "--protocol",
      "http2",
      "--no-autoupdate",
      "run",
      "--token",
      tunnel.token.unencrypted,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );

  cloudflared.on("error", (error) => {
    console.error("Failed to start cloudflared:", error.message);
    console.error("Install with: brew install cloudflared");
  });

  cloudflared.on("spawn", () => {
    console.log(`repro_cloudflared_pid ${cloudflared.pid}`);
  });

  process.on("exit", () => cloudflared.kill());
  process.on("SIGINT", () => {
    cloudflared.kill();
    process.exit(0);
  });
}

if (!app.local) process.exit(0);
