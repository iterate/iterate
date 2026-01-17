/**
 * Main entry point for the kiterate server
 */
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { serve } from "@hono/node-server";
import { Effect, Layer } from "effect";
import { createApi } from "./api.ts";
import { PlainFactory, Storage, StreamManagerService } from "./event-stream/index.ts";

const DATA_DIR = process.env.KITERATE_DATA_DIR ?? ".kiterate";
const PORT = parseInt(process.env.KITERATE_PORT ?? "3456", 10);

const main = Effect.gen(function* () {
  const streamManager = yield* StreamManagerService;

  const api = createApi(streamManager);

  console.log(`Starting kiterate server on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);

  serve({
    fetch: api.fetch,
    port: PORT,
  });

  console.log(`Server running at http://localhost:${PORT}`);

  // Keep the server running
  yield* Effect.never;
});

// Create the storage layer using FileSystem
const StorageLayer = Storage.FileSystem({ dataDir: DATA_DIR }).pipe(
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(NodePath.layer),
);

// Build full layer stack
const MainLayer = StreamManagerService.Live.pipe(
  Layer.provide(PlainFactory),
  Layer.provide(StorageLayer),
);

// Run the server
Effect.runPromise(main.pipe(Effect.provide(MainLayer))).catch(console.error);
