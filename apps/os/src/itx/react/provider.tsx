// One <ItxProvider> per app owns one lazy itx connection per tab.
//
// StrictMode-safe lifecycle: the client is created once in a state
// initializer; the effect only arms/disarms it, and connecting is lazy, so
// the dev-mode mount→unmount→mount cycle costs nothing.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createItxBrowserClient } from "./connection.ts";
import { ItxClientContext } from "./context.ts";

export function ItxProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => createItxBrowserClient());

  useEffect(() => {
    client.activate();
    return () => client.deactivate();
  }, [client]);

  return <ItxClientContext value={client}>{children}</ItxClientContext>;
}
