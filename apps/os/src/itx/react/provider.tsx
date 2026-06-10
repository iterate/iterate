// One itx client per tab, created lazily on first render in a browser. React
// never tears it down — the provider sits at the app root, the socket is
// lazy, and a tab's connection dies with the tab. (dispose() exists on the
// client for tests and non-app embeddings.)

import type { ReactNode } from "react";
import { createItxBrowserClient, type ItxBrowserClient } from "./connection.ts";
import { ItxClientContext } from "./context.ts";

let browserClient: ItxBrowserClient | null = null;

function getBrowserClient(): ItxBrowserClient {
  browserClient ??= createItxBrowserClient();
  return browserClient;
}

export function ItxProvider({ children }: { children: ReactNode }) {
  return <ItxClientContext value={getBrowserClient()}>{children}</ItxClientContext>;
}
