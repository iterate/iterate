import type { ProcessorProgressStore } from "iterate/processors";

type ProcessorCacheDescription = {
  slug: string;
  schemaVersion: number;
  resetOnSchemaVersionChange?: boolean;
};

type ProcessorCacheActions<Processor extends ProcessorCacheDescription> = {
  readRecordedStreamId(processorSlug: string): Promise<string | undefined>;
  recordStreamId(processorSlug: string, streamId: string): Promise<void>;
  readRecordedSchemaVersion(processorSlug: string): Promise<number | undefined>;
  recordSchemaVersion(processorSlug: string, schemaVersion: number): Promise<void>;
  /** Delete this processor's projection tables and rewind its progress atomically. */
  clearProcessorData(processor: Processor, streamId: string): Promise<void>;
  /** Notify readers, compact SQLite, and refresh the visible database summary. */
  finishDiscard(): Promise<void>;
};

/**
 * Check each browser processor's persisted cursor and projection before a
 * writer opens the live callback. Every awaited operation is bracketed by the
 * writer-election check. An operation already posted to the SQLite worker may
 * finish after supersession, but no later operation from that election starts.
 */
export async function reconcileBrowserProcessorCache<
  Processor extends ProcessorCacheDescription,
>(args: {
  streamPath: string;
  serverState: { streamId?: string; maxOffset: number };
  processors: readonly {
    processor: Processor;
    progress: ProcessorProgressStore<unknown>;
  }[];
  isCurrentWriter: () => boolean;
  actions: ProcessorCacheActions<Processor>;
}): Promise<{ serverMaxOffset: number; serverStreamId: string }> {
  const assertCurrentWriter = () => {
    if (!args.isCurrentWriter()) {
      throw new Error("browser stream writer election was superseded during cache reconciliation");
    }
  };
  const whileCurrentWriter = async <T>(work: () => Promise<T> | T): Promise<T> => {
    assertCurrentWriter();
    const result = await work();
    assertCurrentWriter();
    return result;
  };

  assertCurrentWriter();
  const serverStreamId = args.serverState.streamId;
  if (serverStreamId === undefined) {
    throw new Error("stream runtime state has no stream ID after stream creation");
  }
  let discardedAny = false;

  for (const { processor, progress } of args.processors) {
    // Reading progress also ensures this processor's projection schema. That
    // reset must happen before its cursor is trusted.
    const localMaxOffset =
      (await whileCurrentWriter(() => progress.read()))?.processing.acknowledgedThroughOffset ?? 0;
    const localStreamId = await whileCurrentWriter(() =>
      args.actions.readRecordedStreamId(processor.slug),
    );
    const localSchemaVersion = processor.resetOnSchemaVersionChange
      ? await whileCurrentWriter(() => args.actions.readRecordedSchemaVersion(processor.slug))
      : processor.schemaVersion;

    // No recorded schema and no checkpoint is a genuinely empty cache, not a
    // schema change. Avoid clearing/VACUUMing a new OPFS database.
    const hasNoLocalProcessorData = localMaxOffset <= 0 && localSchemaVersion === undefined;

    if (!hasNoLocalProcessorData && localSchemaVersion !== processor.schemaVersion) {
      console.warn(
        `[stream ${args.streamPath} ${processor.slug}] local schema version changed; rebuilding processor cache.`,
        { localSchemaVersion, schemaVersion: processor.schemaVersion },
      );
      await whileCurrentWriter(() => args.actions.clearProcessorData(processor, serverStreamId));
      discardedAny = true;
      await whileCurrentWriter(() =>
        args.actions.recordSchemaVersion(processor.slug, processor.schemaVersion),
      );
      await whileCurrentWriter(() => args.actions.recordStreamId(processor.slug, serverStreamId));
      continue;
    }

    if (localMaxOffset <= 0) {
      if (processor.resetOnSchemaVersionChange) {
        await whileCurrentWriter(() =>
          args.actions.recordSchemaVersion(processor.slug, processor.schemaVersion),
        );
      }
      await whileCurrentWriter(() => args.actions.recordStreamId(processor.slug, serverStreamId));
      continue;
    }

    if (localStreamId !== serverStreamId) {
      console.warn(
        `[stream ${args.streamPath} ${processor.slug}] local rows belong to a different or unrecorded stream ID; rebuilding processor cache.`,
        { localStreamId, serverStreamId, localMaxOffset },
      );
      await whileCurrentWriter(() => args.actions.clearProcessorData(processor, serverStreamId));
      discardedAny = true;
      await whileCurrentWriter(() => args.actions.recordStreamId(processor.slug, serverStreamId));
      continue;
    }

    if (args.serverState.maxOffset < localMaxOffset) {
      console.warn(
        `[stream ${args.streamPath} ${processor.slug}] server has fewer events than the local cache; rebuilding processor cache.`,
        { serverMaxOffset: args.serverState.maxOffset, localMaxOffset },
      );
      await whileCurrentWriter(() => args.actions.clearProcessorData(processor, serverStreamId));
      discardedAny = true;
    }
    if (processor.resetOnSchemaVersionChange) {
      await whileCurrentWriter(() =>
        args.actions.recordSchemaVersion(processor.slug, processor.schemaVersion),
      );
    }
    await whileCurrentWriter(() => args.actions.recordStreamId(processor.slug, serverStreamId));
  }

  if (discardedAny) await whileCurrentWriter(() => args.actions.finishDiscard());
  return { serverMaxOffset: args.serverState.maxOffset, serverStreamId };
}
