// The browser stream runtime's transport: the capnweb `Stream` stub it dials,
// plus the ability to evict the exact socket that stub rides. Kept apart from
// the runtime so the connection state machine imports a named transport concept
// rather than defining it inline.

import type { Stream } from "../../../../itx-api.generated.ts";

export type StreamBrowserConnectionStatus = "connecting" | "connected" | "closed" | "error";

export type BrowserStreamClient = Disposable &
  Stream & {
    /**
     * Evict the exact transport THIS client rides, bound at creation (see
     * evictItxSocketIfCurrent) — so a late suspicion verdict against this
     * connection can never evict a successor socket, and a genuinely-dead
     * young socket can be evicted without waiting out an age guard. Absent
     * on clients whose factory can't bind identity; the runtime then falls
     * back to the config-level resetTransport (age-guarded).
     */
    evictTransport?: () => void;
  };

export type BrowserStreamClientFactory = (args: {
  projectId: string;
  streamPath: string;
  streamUrl?: string | URL;
  onConnectionStatusChange?: (
    status: StreamBrowserConnectionStatus,
    error: string | undefined,
  ) => void;
}) => Promise<BrowserStreamClient>;

/**
 * How a runtime reaches (and, on suspicion, evicts) the server: the dial and
 * its evictor travel as ONE value so they can never come from two different
 * transports (a factory dialing socket A while timeouts evict socket B would
 * re-arm the wedge the store exists to prevent).
 */
export type BrowserStreamTransport = {
  createStreamClient: BrowserStreamClientFactory;
  resetTransport: (() => void) | undefined;
};

export function asBrowserStreamClient(
  stream: Stream,
  dispose: () => void,
  evictTransport?: () => void,
): BrowserStreamClient {
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.dispose) return dispose;
      if (property === "evictTransport") return evictTransport;
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => Reflect.apply(value, target, args);
    },
  }) as BrowserStreamClient;
}
