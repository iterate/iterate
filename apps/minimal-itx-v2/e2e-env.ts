// Shared environment plumbing for the Node e2e suite. The suite NEVER starts a
// server; it points at one that is already running (`pnpm dev` or a deployed
// worker).

import {
  DEFAULT_ITX_BASE_URL,
  withItx,
  withRoot,
  type ProjectItxRpc,
  type RootRpc,
  type RpcStub,
  type WithItxInput,
} from "./src/client.ts";

/** The running worker the suite talks to. ITX_BASE wins (iterate against a
 *  long-lived `npm run dev`), then APP_CONFIG_BASE_URL (a deployed worker),
 *  else the wrangler dev default. */
export function baseUrl(): string {
  return (
    process.env.ITX_BASE?.trim().replace(/\/+$/, "") ||
    process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "") ||
    DEFAULT_ITX_BASE_URL
  );
}

/** The bearer token naming the demo principal (see auth.ts). Defaults to alice,
 *  who can reach projects ["prj_alice", "prj_ref"]. */
export function token(): string {
  return process.env.ITX_TOKEN?.trim() || "alice-token";
}

/** Connect to the prj_ref project ITX unless overridden. */
export function connect<T extends ProjectItxRpc = ProjectItxRpc>(
  input: Partial<WithItxInput> = {},
): RpcStub<T> {
  return withItx<T>({
    baseUrl: baseUrl(),
    projectId: "prj_ref",
    token: token(),
    ...input,
  });
}

/** The admin token for the Root ITX (auth.ts `access: "all"`). */
export function adminToken(): string {
  return process.env.ITX_ADMIN_TOKEN?.trim() || "root-token";
}

/** Connect to the admin-only platform root (`/api/itx`). */
export function connectRoot<T extends RootRpc = RootRpc>(): RpcStub<T> {
  return withRoot<T>({ baseUrl: baseUrl(), token: adminToken() });
}

export async function ensureProject(projectId = "prj_ref"): Promise<void> {
  using root = connectRoot();
  await root.projects.create(projectId);
}
