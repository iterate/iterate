// The browser stream runtime's transport: the capnweb `Stream` stub it opens,
// plus the ability to REPORT that the shared session socket looks half-open (the
// socket-owned verifier decides whether to retire it). Kept apart from the
// runtime so the connection state machine imports a named transport concept
// rather than defining it inline.

import type { Stream } from "../../../../itx-api.generated.ts";

export type StreamBrowserConnectionStatus = "connecting" | "connected" | "closed" | "error";

export type BrowserStreamClient = Disposable &
  Stream & {
    /**
     * Report that this client's transport looks half-open (see
     * reportTransportSuspicion) — NEVER a direct socket teardown: the browser database
     * shares the one session socket with the page's reads, so only the
     * socket-owned verifier may retire it, and only after two failed probes
     * against the same generation. Absent on clients whose factory doesn't wire
     * it; the runtime then falls back to the config-level resetTransport.
     */
    reportTransportSuspicion?: () => void;
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
 * How a runtime opens (and, on suspicion, evicts) a server connection: the factory and
 * its evictor travel as ONE value so they can never come from two different
 * transports (a factory opening socket A while timeouts evict socket B would
 * re-arm the wedge the store exists to prevent).
 */
export type BrowserStreamTransport = {
  createStreamClient: BrowserStreamClientFactory;
  resetTransport: (() => void) | undefined;
};

export function asBrowserStreamClient(
  stream: Stream,
  dispose: () => void,
  reportTransportSuspicion?: () => void,
): BrowserStreamClient {
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.dispose) return dispose;
      if (property === "reportTransportSuspicion") return reportTransportSuspicion;
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => Reflect.apply(value, target, args);
    },
  }) as BrowserStreamClient;
}
