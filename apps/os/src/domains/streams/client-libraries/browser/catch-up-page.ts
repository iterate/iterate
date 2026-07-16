const SERIALIZED_RPC_VALUE_TOO_LARGE = "Serialized RPC arguments or return values are limited";

/**
 * Read one catch-up page, reducing only an RPC-oversized page until it fits.
 * A single oversized event and every unrelated failure still fail closed.
 */
export async function readCatchUpPage<T>(
  limit: number,
  read: (limit: number) => Promise<T[]>,
): Promise<{ limit: number; page: T[] }> {
  let nextLimit = limit;
  for (;;) {
    try {
      return { limit: nextLimit, page: await read(nextLimit) };
    } catch (error) {
      if (
        nextLimit <= 1 ||
        !(error instanceof Error) ||
        !error.message.includes(SERIALIZED_RPC_VALUE_TOO_LARGE)
      ) {
        throw error;
      }
      nextLimit = Math.max(1, Math.floor(nextLimit / 2));
    }
  }
}

/**
 * Repeatedly catch a browser mirror up to a captured head until the remaining
 * atomic live replay fits the server's admitted gap. The head is re-read after
 * every pass because a busy stream can move substantially while SQLite applies
 * history. A stream recreation aborts the attempt: history from two
 * incarnations must never be combined in one local projection.
 */
export async function catchUpToLiveReplayBoundary(args: {
  afterOffset: number;
  throughOffset: number;
  pageLimit: number;
  maxReplayOffsetGap: number;
  expectedIncarnation: string | undefined;
  catchUp: (input: {
    afterOffset: number;
    throughOffset: number;
    pageLimit: number;
  }) => Promise<{ pageLimit: number; replayAfterOffset: number } | undefined>;
  readHead: () => Promise<{ createdAt?: string; maxOffset: number }>;
  shouldContinue?: () => boolean;
}): Promise<{ pageLimit: number; replayAfterOffset: number } | undefined> {
  const shouldContinue = args.shouldContinue ?? (() => true);
  let replayAfterOffset = args.afterOffset;
  let catchUpThroughOffset = args.throughOffset;
  let pageLimit = args.pageLimit;

  for (;;) {
    if (!shouldContinue()) return undefined;
    const catchUp = await args.catchUp({
      afterOffset: replayAfterOffset,
      throughOffset: catchUpThroughOffset,
      pageLimit,
    });
    if (catchUp === undefined || !shouldContinue()) return undefined;
    replayAfterOffset = catchUp.replayAfterOffset;
    pageLimit = catchUp.pageLimit;

    const latest = await args.readHead();
    if (!shouldContinue()) return undefined;
    if (latest.createdAt !== args.expectedIncarnation) {
      throw new Error(
        `stream incarnation changed during catch-up (${args.expectedIncarnation} -> ${latest.createdAt})`,
      );
    }
    if (latest.maxOffset - replayAfterOffset <= args.maxReplayOffsetGap) {
      return { pageLimit, replayAfterOffset };
    }
    catchUpThroughOffset = latest.maxOffset;
  }
}

/**
 * Pull the durable history that existed when a browser connection began.
 *
 * Range reads omit ephemeral rows by default. Once every durable survivor at
 * or below `throughOffset` has been applied, the caller opens its live
 * subscription AFTER that captured head. That boundary is load-bearing: old
 * streaming chunks are never replayed, while anything appended after the
 * connection began (ephemeral or durable) still arrives on the live lane.
 */
export async function catchUpDurableHistory<T extends { offset: number }>(args: {
  afterOffset: number;
  throughOffset: number;
  pageLimit: number;
  read: (input: { afterOffset: number; beforeOffset: number; limit: number }) => Promise<T[]>;
  ingest: (input: {
    events: readonly T[];
    scannedAfterOffset: number;
    scannedThroughOffset: number;
  }) => Promise<void>;
  shouldContinue?: () => boolean;
  onPageLimitReduced?: (previousLimit: number, nextLimit: number) => void;
}): Promise<{ pageLimit: number; replayAfterOffset: number } | undefined> {
  const shouldContinue = args.shouldContinue ?? (() => true);
  let cursor = args.afterOffset;
  let pageLimit = args.pageLimit;
  const beforeOffset = args.throughOffset + 1;

  while (cursor < args.throughOffset) {
    if (!shouldContinue()) return undefined;
    const result = await readCatchUpPage(pageLimit, (limit) =>
      args.read({ afterOffset: cursor, beforeOffset, limit }),
    );
    if (!shouldContinue()) return undefined;
    if (result.limit < pageLimit) args.onPageLimitReduced?.(pageLimit, result.limit);
    pageLimit = result.limit;
    if (result.page.length === 0) {
      await args.ingest({
        events: [],
        scannedAfterOffset: cursor,
        scannedThroughOffset: args.throughOffset,
      });
      cursor = args.throughOffset;
      break;
    }

    const nextCursor = result.page.at(-1)!.offset;
    if (nextCursor <= cursor || nextCursor > args.throughOffset) {
      throw new Error(
        `historical catch-up returned invalid final offset ${nextCursor}; expected (${cursor}, ${args.throughOffset}]`,
      );
    }
    // A short page proves there are no more durable survivors in the bounded
    // range, so its scan also covers any trailing ephemeral-only suffix.
    const scannedThroughOffset =
      result.page.length < result.limit ? args.throughOffset : nextCursor;
    await args.ingest({
      events: result.page,
      scannedAfterOffset: cursor,
      scannedThroughOffset,
    });
    if (!shouldContinue()) return undefined;
    cursor = scannedThroughOffset;
  }

  return { pageLimit, replayAfterOffset: args.throughOffset };
}
