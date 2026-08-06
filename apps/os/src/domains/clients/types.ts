// Published wire shapes of the itx.clients surface (rpc-targets.ts must not
// declare named types itself — the itx api generator resolves names from the
// domain modules).

import type { ConnectionOpenerDescriptor } from "../streams/core-processor-contract.ts";

/** One roster row from `itx.clients.list()`: last-known presence, not liveness. */
export type ClientListItem = {
  path: string;
  description?: string;
  createdAt: string;
  /** Connections the roster projection currently knows (dormant included). */
  connections: number;
  /** True when any known connection carries a live capabilities target. */
  hasCapabilities: boolean;
};

/** One open client connection, read from the client stream's LIVE runtime table. */
export type ClientConnectionListItem = {
  connectionKey: string;
  startedAt: string;
  description?: string;
  user?: ConnectionOpenerDescriptor["user"];
  hasCapabilities: boolean;
};
