// Context + hooks for the browser itx client. The provider component lives in
// provider.tsx (fast-refresh wants component-only files); React 19 idioms:
// use(Context) rather than useContext, useSyncExternalStore for the
// connection status (it IS an external store).

import { createContext, use, useSyncExternalStore } from "react";
import type { ItxBrowserClient, ItxConnectionStatus } from "./connection.ts";

export const ItxClientContext = createContext<ItxBrowserClient | null>(null);

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
