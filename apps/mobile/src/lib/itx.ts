// itx from the phone: one capnweb WebSocket to `<server>/api/itx`,
// authenticated with a bearer access token (the `bearer` credential lane in
// apps/os/src/auth.ts). React Native's global WebSocket satisfies capnweb.
//
// Lifecycle mirrors the browser client (apps/os/src/itx/itx-react.tsx): one
// cached session per server, dropped on failure so the next call re-dials.
// The one auth-shaped retry lives HERE, at connection setup — a clean seam —
// and nowhere else (no 401-driven retries mid-RPC).

import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { Session, UnauthenticatedItx } from "../../../os/src/types.ts";
import { getAccessToken } from "./auth.ts";

// What `authenticate()` actually resolves to on a capnweb stub (property
// chains stay stubs rather than promises) — `RpcStub<Session>` directly would
// promise-wrap every member.
export type ItxSession = Awaited<ReturnType<RpcStub<UnauthenticatedItx>["authenticate"]>>;
// Session is what the stub is *of*; keep the import so the contract file is
// the single source of truth for what a session can do.
export type { Session };

let cached: { baseUrl: string; session: Promise<ItxSession> } | null = null;

export function getItxSession(baseUrl: string): Promise<ItxSession> {
  if (cached?.baseUrl === baseUrl) return cached.session;
  const session = dial(baseUrl);
  cached = { baseUrl, session };
  session.catch(() => {
    if (cached?.session === session) cached = null;
  });
  return session;
}

/** Drop the cached session (call after an RPC fails) so the next use re-dials. */
export function resetItxSession(): void {
  cached = null;
}

async function dial(baseUrl: string): Promise<ItxSession> {
  const url = new URL("/api/itx", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const root = newWebSocketRpcSession<UnauthenticatedItx>(url.toString());
  try {
    return await root.authenticate({
      type: "bearer",
      token: await getAccessToken(baseUrl),
    });
  } catch (error) {
    const authShaped = error instanceof Error && /auth|token|unauthorized|401/i.test(error.message);
    if (!authShaped) throw error;
    // One forced refresh + re-authenticate, then give up to the caller.
    return await root.authenticate({
      type: "bearer",
      token: await getAccessToken(baseUrl, { forceRefresh: true }),
    });
  }
}
