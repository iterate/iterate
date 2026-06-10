// One itx client per tab, created lazily on first render in a browser. React
// never tears it down — the provider sits at the app root, the socket is
// lazy, and a tab's connection dies with the tab. (dispose() exists on the
// client for tests and non-app embeddings.) The singleton itself lives in
// browser-client.ts so non-React code (route loaders) can share it.

import type { ReactNode } from "react";
import { getItxBrowserClient } from "./browser-client.ts";
import { ItxClientContext } from "./context.ts";

export function ItxProvider({ children }: { children: ReactNode }) {
  return <ItxClientContext value={getItxBrowserClient()}>{children}</ItxClientContext>;
}
