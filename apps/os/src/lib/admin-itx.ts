// React context for the /admin section's root itx handle. Lives outside the
// route files on purpose: route files get code-split and HMR-swapped per
// route, so a context exported from one can resolve to a different module
// instance in the layout vs. a child page — and useContext silently returns
// null across instances.

import { createContext, useContext } from "react";
import type { RpcStub } from "capnweb";
import type { Itx } from "~/itx/handle.ts";

export const AdminItxContext = createContext<RpcStub<Itx> | null>(null);

/** The root itx handle, available to every route under /admin once connected. */
export function useAdminItx(): RpcStub<Itx> {
  const itx = useContext(AdminItxContext);
  if (!itx) throw new Error("useAdminItx must be used inside the /admin layout, once ready.");
  return itx;
}
