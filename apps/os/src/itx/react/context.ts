// Context + hook for the browser itx client. The provider component lives in
// provider.tsx (fast-refresh wants component-only files); React 19 idiom:
// use(Context) rather than useContext.

import { createContext, use } from "react";
import type { ItxBrowserClient } from "./connection.ts";

export const ItxClientContext = createContext<ItxBrowserClient | null>(null);

export function useItxClient(): ItxBrowserClient {
  const client = use(ItxClientContext);
  if (client === null) {
    throw new Error("useItxClient must be used inside <ItxProvider>.");
  }
  return client;
}
