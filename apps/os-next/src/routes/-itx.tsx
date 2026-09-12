// routes/-itx.tsx (the `-` prefix: not a route) — the authenticated app's itx PROVIDER + hook.
//
// The `_auth` layout is a CLIENT COMPONENT (`ssr: false`) whose `beforeLoad` suspends the whole
// subtree until the `/api` WebSocket is established (client/browser.ts `authenticate` — it opens the
// socket and resolves once the session answers). So by the time anything under `_auth` renders, the
// live session is up: `useItx()` returns it synchronously, no half-open socket, no per-route context
// threading. LiveState hooks (client/react.tsx) take a handle off `useItx()` and are client-only by
// nature — exactly what a live WebSocket view wants.
import { createContext, useContext, type ReactNode } from "react";
import type { AuthenticatedApp } from "../client/browser.ts";

const ItxContext = createContext<AuthenticatedApp | null>(null);

/** The established itx session: `api` (the authenticated `/api` capnweb session) and `info`. Throws
 *  if used outside the `_auth` app, where the socket is guaranteed up. */
export function useItx(): AuthenticatedApp {
  const app = useContext(ItxContext);
  if (!app) throw new Error("useItx() must be used within the authenticated app (_auth)");
  return app;
}

/** Provides the session the `_auth` layout resolved to the whole authenticated subtree. */
export function ItxProvider({ app, children }: { app: AuthenticatedApp; children: ReactNode }) {
  return <ItxContext.Provider value={app}>{children}</ItxContext.Provider>;
}
