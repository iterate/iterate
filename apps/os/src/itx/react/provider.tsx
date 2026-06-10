// The React 19 face of the browser itx client: one <ItxProvider> per app
// owns one lazy connection per tab; components read it with use(Context).
//
// React 19 idioms, deliberately:
//   - context rendered directly as a provider (<ItxClientContext value={…}>)
//   - use(Context) instead of useContext in the hooks
//   - useSyncExternalStore for the connection status (it IS an external store)
//   - StrictMode-safe lifecycle: the client is created once in a state
//     initializer; the effect only arms/disarms it, and connecting is lazy,
//     so the dev-mode mount→unmount→mount cycle costs nothing.

import { createContext, use, useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { createItxBrowserClient } from "./connection.ts";
import type { ItxBrowserClient, ItxConnectionStatus } from "./connection.ts";

const ItxClientContext = createContext<ItxBrowserClient | null>(null);

export function ItxProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => createItxBrowserClient());

  useEffect(() => {
    client.activate();
    return () => client.deactivate();
  }, [client]);

  return <ItxClientContext value={client}>{children}</ItxClientContext>;
}

export function useItxClient(): ItxBrowserClient {
  const client = use(ItxClientContext);
  if (client === null) {
    throw new Error("useItxClient must be used inside <ItxProvider>.");
  }
  return client;
}

const serverSnapshot = (): ItxConnectionStatus => "idle";

/** Live connection status — "connected" | "connecting" | "reconnecting" | "idle". */
export function useItxStatus(): ItxConnectionStatus {
  const client = useItxClient();
  return useSyncExternalStore(client.subscribeStatus, client.getStatus, serverSnapshot);
}
