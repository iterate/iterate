import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "@playwright/test";
import { mintAdminBrowserTokens } from "./auth.ts";

export const STORAGE_STATE_PATH = "test-results/.auth/storage-state.json";

/**
 * Signs the browser suite in against a DEPLOYED playground: forge-mints an
 * admin access+id pair, exchanges it for the normal session cookie via
 * `/api/iterate-auth/session-from-token`, and saves the storage state every
 * test reuses. Local dev is auth-less — no WORKER_URL, nothing to do.
 */
export default async function globalSetup() {
  const workerUrl = process.env.WORKER_URL;
  const tokens = await mintAdminBrowserTokens(workerUrl);
  if (!tokens) return;

  mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });
  const context = await request.newContext({ baseURL: workerUrl });
  const response = await context.get(
    `/api/iterate-auth/session-from-token?${new URLSearchParams({
      access_token: tokens.accessToken,
      id_token: tokens.idToken,
      return_to: "/",
    })}`,
  );
  if (!response.ok()) {
    throw new Error(`session-from-token failed (${response.status()}): ${await response.text()}`);
  }
  await context.storageState({ path: STORAGE_STATE_PATH });
  await context.dispose();
}
