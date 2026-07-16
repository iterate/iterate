// itx from the phone: the app-side binding of the transport seam in
// itx-core.ts (which holds the actual dial + the one auth-shaped retry) to
// the OAuth token store in auth.ts.
//
// Ported from the voice-ios-app branch (PR #1605) apps/mobile/src/lib/itx.ts.
// Divergences: dials `/api` — on main the capnweb surface is served at
// exactly that path (apps/os/src/worker.ts); that branch's `/api/itx` is
// specific to its voice-itx-bridge base. The dial itself moved to itx-core.ts
// so the live e2e can run it from Node with an injected credential.
//
// Lifecycle mirrors the browser client (apps/os/src/itx/itx-react.tsx): one
// cached session per server, dropped on failure so the next call re-dials.
// No 401-driven retries mid-RPC — the retry lives at connection setup only.

import { getAccessToken } from "./auth.ts";
import { dialItx, type ItxSession } from "./itx-core.ts";

export type { ItxSession, Session } from "./itx-core.ts";

let cached: { baseUrl: string; session: Promise<ItxSession> } | null = null;

export function getItxSession(baseUrl: string): Promise<ItxSession> {
  if (cached?.baseUrl === baseUrl) return cached.session;
  const session = dialItx(baseUrl, (options) => getAccessToken(baseUrl, options));
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
