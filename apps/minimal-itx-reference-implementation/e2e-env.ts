// Shared environment plumbing for the itx e2e suites (Node side): which running
// worker to talk to and which demo principal to authenticate as. Mirrors
// apps/os/src/itx/e2e/e2e-env.ts — like apps/os, the suite NEVER starts a
// server; it points at one that is already running (`npm run dev`, or a
// deployed worker). The browser suite cannot read process.env, so
// vitest.config.ts injects the same values there via `define`
// (__ITX_BROWSER_E2E__) instead of importing this file.

import { withItx, withRoot, type WithItxInput } from "./src/client.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:8788";

/** The running worker the suite talks to. ITX_BASE wins (iterate against a
 *  long-lived `npm run dev`), then APP_CONFIG_BASE_URL (a deployed worker),
 *  else the wrangler dev default. */
export function baseUrl(): string {
  return (
    process.env.ITX_BASE?.trim().replace(/\/+$/, "") ||
    process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "") ||
    DEFAULT_BASE_URL
  );
}

/** The bearer token naming the demo principal (see auth.ts). Defaults to alice,
 *  who can reach projects ["prj_alice", "prj_ref"]. */
export function token(): string {
  return process.env.ITX_TOKEN?.trim() || "alice-token";
}

/** Connect a context handle on the running worker. Defaults to the demo
 *  principal and the prj_ref project root; pass overrides for agent paths or
 *  other projects. */
export function connect<T = unknown>(input: Partial<WithItxInput> = {}): T {
  return withItx<T>({
    baseUrl: baseUrl(),
    projectId: "prj_ref",
    path: "/",
    token: token(),
    ...input,
  });
}

/** The admin token for the Root ITX (auth.ts `access: "all"`). */
export function adminToken(): string {
  return process.env.ITX_ADMIN_TOKEN?.trim() || "root-token";
}

/** Connect to the admin-only platform root (`/api/itx`). */
export function connectRoot<T = unknown>(): T {
  return withRoot<T>({ baseUrl: baseUrl(), token: adminToken() });
}

export async function ensureProject(projectId = "prj_ref"): Promise<void> {
  using root = connectRoot();
  await root.projects.create(projectId);
}
