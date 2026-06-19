// Shared environment plumbing for the Node e2e suite. The suite NEVER starts a
// server; it points at one that is already running (`pnpm dev` or a deployed
// worker).

import {
  connectItx,
  DEFAULT_ITX_BASE_URL,
  type ConnectItxInput,
  type ItxAuth,
  type RootRpc,
  type RpcStub,
  type UnauthenticatedItxRpc,
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

export function tokenAuth(): ItxAuth {
  return { type: "token", token: token() };
}

export function connectUnauthenticated(
  input: ConnectItxInput = {},
): RpcStub<UnauthenticatedItxRpc> {
  return connectItx({
    baseUrl: baseUrl(),
    ...input,
  });
}

/** The admin token for the authenticated global ITX (auth.ts `access: "all"`). */
export function adminToken(): string {
  return process.env.ITX_ADMIN_TOKEN?.trim() || "root-token";
}

export function adminAuth(): ItxAuth {
  return { type: "token", token: adminToken() };
}

const ensuredProjects = new Map<string, Promise<void>>();

export async function ensureProject(projectId = "prj_ref"): Promise<void> {
  let setup = ensuredProjects.get(projectId);
  if (!setup) {
    setup = (async () => {
      using unauthenticated = connectUnauthenticated();
      using root = unauthenticated.authenticate({ auth: adminAuth() }) as RpcStub<RootRpc>;
      await root.projects.create(projectId);
    })();
    ensuredProjects.set(projectId, setup);
  }
  await setup;
}
