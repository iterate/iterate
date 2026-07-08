import { useMemo, useSyncExternalStore } from "react";
import type { Stream } from "../../../../../itx-api.generated.ts";
import type { StreamProcessorStateStorage } from "../../../stream-processor.ts";
import { browserProcessorStateStorage } from "../processor-state-storage.ts";
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
 * connection, the local SQLite client, and checkpoint storage scoped to the
 * processor's (slug, subscription) row. Having one canonical shape is what
 * lets {@link useStreamProcessorStore} construct any processor class.
 */
type BrowserProcessorConstructorArgs<State> = {
  stream: Stream;
  sql: SqlClient;
} & Required<StreamProcessorStateStorage<State>>;

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
export function useStreamProcessorStore<State>(input: {
  createStreamClient: BrowserStreamClientFactory;
  projectId: string;
  streamPath: string;
  slug: string;
  schemaVersion: number;
  /** Tables this processor owns in the shared per-path SQLite mirror. */
  tables: string[];
  resetOnSchemaVersionChange?: boolean;
  Processor: new (
    args: BrowserProcessorConstructorArgs<State>,
  ) => ReturnType<BrowserProcessorConfig["createProcessor"]>;
}): { store: StreamBrowserStore; snapshot: StreamBrowserSnapshot } {
  const {
    createStreamClient,
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
  // just keeps the memo honest.)
  const tablesKey = tables.join(",");
  const store = useMemo(
    () =>
      acquireStreamRuntime({
        createStreamClient,
        projectId,
        streamPath,
        slug,
        schemaVersion,
        tables: tablesKey === "" ? [] : tablesKey.split(","),
        ...(resetOnSchemaVersionChange == null ? {} : { resetOnSchemaVersionChange }),
        createProcessor({ stream, sql, subscriptionKey }) {
          const storage = browserProcessorStateStorage<State>({
            sql,
            processorSlug: slug,
            subscriptionKey,
          });
          return new Processor({
            stream,
            sql,
            readState: storage.readState,
            writeState: storage.writeState,
          });
        },
      }),
    [
      createStreamClient,
      projectId,
      streamPath,
      slug,
      schemaVersion,
      tablesKey,
      resetOnSchemaVersionChange,
      Processor,
    ],
  );
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  return { store, snapshot };
}
