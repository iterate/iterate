// Shared plumbing for apps/mobile's live e2e lanes (chat-roundtrip,
// approval-roundtrip): resolving the target deployment and its auth
// resource. Extracted once a second e2e file needed the exact same few
// functions — see docs/testing.md's philosophy that these lanes run
// against any environment via ambient Doppler config.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Deployed targets set APP_CONFIG_BASE_URL in Doppler; a local dev server
 * runs on a random port and publishes itself to the discovery file instead
 * (apps/os/scripts/lib/dev-server-info.ts).
 */
export function resolveBaseUrl(): string {
  const fromEnv = process.env.APP_CONFIG_BASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const discoveryFile = resolve(import.meta.dirname, "../../os/.dev-server/dev-server.json");
  if (existsSync(discoveryFile)) {
    const info = JSON.parse(readFileSync(discoveryFile, "utf8")) as { baseUrl?: string };
    if (info.baseUrl) return info.baseUrl;
  }
  throw new Error(
    "No target deployment: set APP_CONFIG_BASE_URL (doppler config for a deployed env) " +
      "or start the local dev server (`pnpm dev start --detach`).",
  );
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required — run under a Doppler config for the target deployment, e.g. ` +
        `doppler run --config dev -- pnpm --dir apps/mobile test:e2e`,
    );
  }
  return value;
}

/**
 * The RFC 8707 resource for an OS deployment — port-stripped loopback for
 * local dev, matching the auth worker's audience list. Mirrors osResource()
 * in src/lib/auth.ts (which is welded to expo imports).
 */
export function portlessOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return `http://${url.hostname}`;
  }
  return url.origin;
}
