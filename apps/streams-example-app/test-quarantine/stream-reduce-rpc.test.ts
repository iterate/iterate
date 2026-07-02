// QUARANTINED (see README.md in this directory).
//
// This test exercised the LEGACY engine's public `stream.reduce({ event })`
// RPC, which let a client dry-run the core reducer against an arbitrary event.
// The next engine's public `Stream` capability has no reducer RPC (core
// reduction is internal to the Stream Durable Object), so there is no surface
// to adapt this test to. Not part of the vitest include glob and excluded from
// tsconfig; kept verbatim for the path back described in the README.

import { describe, it } from "vitest";
import { e2eStreamPathLabel, toStreamWebSocketUrl } from "../e2e/helpers.ts";
import { withStreamConnectionFromNode } from "../src/lib/node-stream-connection.ts";

const e2eIt = it.skip;

describe("legacy stream reducer RPC (quarantined)", () => {
  e2eIt("exposes the stream reducer as an RPC method", async () => {
    const path = e2eStreamPathLabel("stream-capnweb-reduce");
    using stream = withStreamConnectionFromNode({ url: toStreamWebSocketUrl({ path }) });

    // Legacy surface (no longer typechecks against the next Stream capability):
    const state = await (
      stream.stream as unknown as {
        reduce(args: { event: unknown }): Promise<{
          config: { simulatedStorageSyncDelayMs: number };
        }>;
      }
    ).reduce({
      event: {
        type: "events.iterate.com/stream/configured",
        offset: 3,
        createdAt: new Date().toISOString(),
        payload: {
          config: {
            simulatedStorageSyncDelayMs: 25,
          },
        },
      },
    });

    void state;
  });
});
