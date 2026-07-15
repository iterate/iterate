import { useCallback, useMemo, useReducer, useSyncExternalStore } from "react";
import type { Stream } from "../../../../../itx-api.generated.ts";
import type { SqlClient } from "../stream-browser-db.ts";
import {
  acquireStreamRuntime,
  type BrowserProcessorConfig,
  type BrowserStreamClientFactory,
  type StreamBrowserSnapshot,
  type StreamBrowserStore,
} from "../stream-browser-store.ts";

/**
 * What every browser-hosted processor's constructor receives: the stream
 * connection and the local SQLite client. Having one canonical shape is what
 * lets {@link useStreamProcessorStore} construct any processor class. The
 * runtime drives the processor with a StreamProcessorRunner whose progress
 * lives in the transactional browser progress store, not in the processor
 * instance — so there is no checkpoint wiring here.
 */
type BrowserProcessorConstructorArgs = {
  stream: Stream;
  /** The mirrored stream's identity (StreamProcessor base deps). */
  path: string;
  projectId: string;
  sql: SqlClient;
};

/**
 * Mount a browser-hosted stream processor and subscribe this component to its
 * runtime: acquires (or joins) the per-(project, path, slug) runtime, wires
 * the processor's checkpoint storage, and — crucially — subscribes via
 * `useSyncExternalStore`, which is what STARTS the store's connection
 * (stream-browser-store refcounts listeners; an unsubscribed processor never
 * folds). Returns the store for imperative calls (queries, appends, nudges)
 * and the live connection snapshot.
 *
 * `acquireStreamRuntime` dedupes by (projectId, streamPath, slug), so
 * remounts and re-renders join the existing runtime instead of re-replaying.
 */
export function useStreamProcessorStore(input: {
  createStreamClient: BrowserStreamClientFactory;
  /** See BrowserStreamConnectionConfig.resetTransport — evict a dead-but-never-closed transport. */
  resetTransport?: () => void;
  projectId: string;
  streamPath: string;
  slug: string;
  schemaVersion: number;
  /** Tables this processor owns in the shared per-path SQLite mirror. */
  tables: string[];
  resetOnSchemaVersionChange?: boolean;
  Processor: new (
    args: BrowserProcessorConstructorArgs,
  ) => ReturnType<BrowserProcessorConfig["createProcessor"]>;
}): { store: StreamBrowserStore; snapshot: StreamBrowserSnapshot } {
  const {
    createStreamClient,
    resetTransport,
    projectId,
    streamPath,
    slug,
    schemaVersion,
    tables,
    resetOnSchemaVersionChange,
    Processor,
  } = input;
  // `tables` is passed as a literal at every callsite; key the memo on its
  // content. (Even a spurious re-run is safe — acquire dedupes by key — this
  // just keeps the memo honest.) JSON, not join(","): a table name containing
  // a comma must not silently split into two.
  const tablesKey = JSON.stringify(tables);
  // Self-heal for the acquire-to-subscribe gap: React can yield between the
  // render that acquired the runtime and the commit that subscribes (Suspense,
  // lazy chunks — seconds, longer than any idle grace), and a runtime disposed
  // inside that window is a corpse the memo would cache forever. Bumping this
  // epoch re-runs the acquire, which creates a FRESH runtime (the registry
  // entry is gone by then), and useSyncExternalStore resubscribes to it.
  const [reacquireEpoch, reacquire] = useReducer((epoch: number) => epoch + 1, 0);
  const store = useMemo(
    () =>
      acquireStreamRuntime({
        createStreamClient,
        resetTransport,
        projectId,
        streamPath,
        slug,
        schemaVersion,
        tables: JSON.parse(tablesKey) as string[],
        ...(resetOnSchemaVersionChange == null ? {} : { resetOnSchemaVersionChange }),
        createProcessor({ stream, path, projectId, sql }) {
          return new Processor({ stream, path, projectId, sql });
        },
      }),
    [
      createStreamClient,
      resetTransport,
      projectId,
      streamPath,
      slug,
      schemaVersion,
      tablesKey,
      resetOnSchemaVersionChange,
      Processor,
      reacquireEpoch,
    ],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      if (store.isDisposed()) {
        reacquire();
        return () => {};
      }
      return store.subscribe(listener);
    },
    [store],
  );
  const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
  return { store, snapshot };
}
