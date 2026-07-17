import type { ItxAuthCredentials } from "../itx-api.generated.ts";
import { readConfig } from "../config.ts";

/**
 * Resolve itx credentials for the TUI, in priority order: an admin API secret
 * from the environment (doppler / e2e lanes), an explicit bearer token, then
 * the stored `iterate login` session for the named config. The launcher
 * (`iterate chat`) refreshes the stored session before spawning the TUI, so a
 * plain bearer read is enough here.
 */
export function resolveItxAuth(input: { configName: string | undefined }): ItxAuthCredentials {
  const adminSecret = readEnv("APP_CONFIG_ADMIN_API_SECRET");
  if (adminSecret) return { type: "admin-secret", secret: adminSecret };

  const bearerToken = readEnv("ITERATE_BEARER_TOKEN");
  if (bearerToken) return { type: "bearer", token: bearerToken };

  if (input.configName) {
    const config = readConfig(input.configName, { throw: true });
    if (config.session?.token) return { type: "bearer", token: config.session.token };
  }

  throw new Error(
    "No credentials: run `iterate login`, or set an admin API secret " +
      "(APP_CONFIG_ADMIN_API_SECRET) or a bearer token (ITERATE_BEARER_TOKEN).",
  );
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
