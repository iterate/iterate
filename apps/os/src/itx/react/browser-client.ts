// The per-tab itx client singleton, importable without React. Route loaders
// (itx/loader.ts) run outside the component tree but must share the SAME
// socket and project-handle cache as the hooks — otherwise a loader prefetch
// would dial a second WebSocket per tab. provider.tsx hands this exact
// instance to the React layer, so both faces are one client.
//
// Creating the client is side-effect free (connection.ts dials lazily on
// first use), so importing this module during SSR is harmless — calling
// `.itx()`/`.project()` there is not; server code uses getServerItx instead.

import { createItxBrowserClient, type ItxBrowserClient } from "./connection.ts";

let browserClient: ItxBrowserClient | null = null;

/** The shared per-tab client; created on first call, lives until the tab dies. */
export function getItxBrowserClient(): ItxBrowserClient {
  browserClient ??= createItxBrowserClient();
  return browserClient;
}
