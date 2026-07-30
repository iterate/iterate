/*
 * This ledger is deliberately executable data, not a prose list of features
 * that somebody must remember to avoid. A constrained peer is useful only
 * when its compatibility boundary is falsifiable: every unsupported shape is
 * sent to the C process and must fail in the declared way. Adding support
 * means deleting the entry only after an ordinary green interop case replaces
 * it.
 */
export type CInteropKnownFailure =
  | {
      readonly id: string;
      readonly kind: "terminal-wire-status";
      readonly upstreamBehavior: string;
      readonly frames: readonly string[];
      readonly expectedStatus: "CAPNWEB_E_UNSUPPORTED";
      readonly expectedAbortReason:
        | "CAPNWEB_E_UNSUPPORTED_IMPORT"
        | "CAPNWEB_E_UNSUPPORTED_PIPE"
        | "CAPNWEB_E_UNSUPPORTED_STREAM";
    }
  | {
      readonly id: string;
      readonly kind: "rpc-rejection";
      readonly upstreamBehavior: string;
      readonly invoke: (remote: any) => Promise<unknown>;
      readonly expectedMessage: "CAPNWEB_E_UNSUPPORTED_PIPELINE";
    };

export const cInteropKnownFailures = [
  {
    id: "stream-message",
    kind: "terminal-wire-status",
    upstreamBehavior:
      "The full runtime accepts top-level stream messages for implicit pull/release.",
    frames: ['["stream",0]'],
    expectedStatus: "CAPNWEB_E_UNSUPPORTED",
    expectedAbortReason: "CAPNWEB_E_UNSUPPORTED_STREAM",
  },
  {
    id: "readable-pipe",
    kind: "terminal-wire-status",
    upstreamBehavior:
      "The full runtime creates a pipe before serializing ReadableStream or Blob values.",
    frames: ['["pipe"]'],
    expectedStatus: "CAPNWEB_E_UNSUPPORTED",
    expectedAbortReason: "CAPNWEB_E_UNSUPPORTED_PIPE",
  },
  {
    id: "inbound-import-expression",
    kind: "terminal-wire-status",
    upstreamBehavior: "The full protocol permits an inbound push rooted at an imported stub.",
    frames: ['["push",["import",0,[]]]'],
    expectedStatus: "CAPNWEB_E_UNSUPPORTED",
    expectedAbortReason: "CAPNWEB_E_UNSUPPORTED_IMPORT",
  },
  {
    id: "call-queued-on-unresolved-result",
    kind: "rpc-rejection",
    upstreamBehavior:
      "The full runtime queues a pipelined call until an unresolved result settles.",
    invoke: async (remote: any) => await remote.makeDeferredCounter().increment(1),
    expectedMessage: "CAPNWEB_E_UNSUPPORTED_PIPELINE",
  },
  {
    id: "property-on-returned-plain-value",
    kind: "rpc-rejection",
    upstreamBehavior:
      "The full runtime evaluates a property path after a plain-value result resolves.",
    invoke: async (remote: any) => await remote.makeValue(7).value,
    expectedMessage: "CAPNWEB_E_UNSUPPORTED_PIPELINE",
  },
] as const satisfies readonly CInteropKnownFailure[];
