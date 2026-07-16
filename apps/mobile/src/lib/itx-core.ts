// The transport seam, kept free of Expo imports so the live e2e can drive the
// EXACT code the phone runs from Node (docs/testing.md: dependency-inject the
// credential, don't mock the transport). itx.ts binds this to the app's OAuth
// token store; the e2e binds it to a forge-minted token.
//
// One capnweb WebSocket to `<server>/api`, authenticated with a bearer access
// token (the `bearer` credential lane in apps/os/src/auth.ts). React Native's
// global WebSocket satisfies capnweb; so does Node's.

import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { Session, UnauthenticatedOs } from "../../../os/src/itx-api.generated.ts";

// What `authenticate()` actually resolves to on a capnweb stub (property
// chains stay stubs rather than promises) — `RpcStub<Session>` directly would
// promise-wrap every member.
export type ItxSession = Awaited<ReturnType<RpcStub<UnauthenticatedOs>["authenticate"]>>;
// Session is what the stub is *of*; keep the import so the contract file is
// the single source of truth for what a session can do.
export type { Session };

export type AccessTokenGetter = (options?: { forceRefresh?: boolean }) => Promise<string>;

export async function dialItx(baseUrl: string, getToken: AccessTokenGetter): Promise<ItxSession> {
  const url = new URL("/api", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const root = newWebSocketRpcSession<UnauthenticatedOs>(url.toString());
  try {
    return await root.authenticate({
      type: "bearer",
      token: await getToken(),
    });
  } catch (error) {
    const authShaped = error instanceof Error && /auth|token|unauthorized|401/i.test(error.message);
    if (!authShaped) throw error;
    // One forced refresh + re-authenticate, then give up to the caller.
    return await root.authenticate({
      type: "bearer",
      token: await getToken({ forceRefresh: true }),
    });
  }
}
