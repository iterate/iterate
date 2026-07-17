import { LiveState } from "iterate/live-state";
import type { ProcessorStream, StreamEvent } from "iterate/processors";
import { StreamProcessorRunner } from "iterate/processors";
import type { CoreProcessorState } from "../core-processor-contract.ts";
import type { StreamFeedContract } from "./contract.ts";
import { initialStreamFeedState } from "./projector.ts";
import { ProjectionWriteBuffer } from "./projection-write-buffer.ts";
import { StreamFeedProcessor } from "./processor.ts";
import { StreamFeedStorage } from "./storage.ts";
import type { StreamFeedSqlClient } from "./sql.ts";
import type {
  StreamFeedLiveState,
  StreamFeedPage,
  StreamFeedProjectionStatus,
  StreamFeedReadInput,
} from "./types.ts";

const CATCH_UP_PAGE_SIZE = 500;
const CATCH_UP_FRAMES_PER_TURN = 10;
const RECENT_ITEM_LIMIT = 100;
const CATCH_UP_ALARM_DELAY_MS = 50;

type RawRead = (input: {
  afterOffset: number;
  limit: number;
  includeEphemeral: true;
}) => StreamEvent[];

/**
 * The Stream DO's local feed host. StreamProcessorRunner remains the sole
 * owner of reduction/processing cursors; this class only delivers bounded
 * scan frames from the co-located log and publishes the resulting read model.
 */
export class StreamFeedHost {
  readonly live: LiveState<StreamFeedLiveState>;
  readonly #storage: StreamFeedStorage;
  readonly #processor: StreamFeedProcessor;
  readonly #runner: StreamProcessorRunner<StreamFeedContract, { sql: StreamFeedSqlClient }>;
  readonly #readRaw: RawRead;
  readonly #getCoreState: () => CoreProcessorState;
  readonly #armAlarm: (atMs: number) => Promise<void>;
  #acknowledgedThroughOffset = 0;
  #activated = false;
  #chain: Promise<void> = Promise.resolve();

  constructor(args: {
    storage: DurableObjectStorage;
    sql: SqlStorage;
    stream: ProcessorStream;
    path: string;
    projectId: string | null;
    readRaw: RawRead;
    getCoreState: () => CoreProcessorState;
    armAlarm: (atMs: number) => Promise<void>;
    keepAlive: (work: () => Promise<unknown>) => void;
  }) {
    this.#readRaw = args.readRaw;
    this.#getCoreState = args.getCoreState;
    this.#armAlarm = args.armAlarm;
    const projectionBuffer = new ProjectionWriteBuffer();
    this.#storage = new StreamFeedStorage(args.storage, args.sql, projectionBuffer);
    this.#processor = new StreamFeedProcessor({
      sql: this.#storage.sqlClient,
      stream: args.stream,
      path: args.path,
      projectId: args.projectId,
      projectionBuffer,
    });
    this.#runner = new StreamProcessorRunner({
      processor: this.#processor,
      stream: args.stream,
      durability: { progress: this.#storage.progress },
      keepAlive: args.keepAlive,
      readPageSize: CATCH_UP_PAGE_SIZE,
    });
    this.live = new LiveState<StreamFeedLiveState>({
      agent: initialStreamFeedState().agent,
      recentItems: [],
      itemCount: 0,
      paused: { paused: false, reason: null },
      projection: {
        acknowledgedThroughOffset: 0,
        streamMaxOffset: 0,
        caughtUp: true,
      },
    });
    this.#runner.observeStateChanges(({ offset }) => {
      this.#acknowledgedThroughOffset = offset;
    });
  }

  /** Cold live-state door: bounded catch-up, then publish committed state. */
  loadAndRefreshLive(): Promise<void> {
    this.#activated = true;
    return this.#enqueue(async () => {
      await this.#catchUpChunk();
      this.#refreshLive();
    });
  }

  getFeedItems(input: StreamFeedReadInput = {}): Promise<StreamFeedPage> {
    this.#activated = true;
    return this.#enqueue(async () => {
      await this.#catchUpChunk();
      const page = this.#storage.read(input);
      return { ...page, projection: this.#projectionStatus() };
    });
  }

  /** Post-commit handoff from Stream.append; never part of append success. */
  onAppended(input: {
    events: readonly StreamEvent[];
    scannedAfterOffset: number;
    scannedThroughOffset: number;
  }): Promise<void> {
    // The prototype must not put a second projector on every stream's hot
    // append path merely because the capability exists. A feed is activated
    // by its first finite read/live subscription and otherwise rebuilds from
    // the runner cursor when next opened.
    if (!this.#activated) return Promise.resolve();
    this.#storage.setCatchUpScheduled(true);
    return this.#enqueue(async () => {
      const opened = await this.#runner.openDelivery();
      this.#acknowledgedThroughOffset = opened.checkpointOffset;
      if (opened.checkpointOffset !== input.scannedAfterOffset) {
        // A cold/lagging projection rebuilds from its own runner checkpoint.
        // Live ephemeral overlays are intentionally discarded while behind:
        // transient chunks are live-only and may never be replayed as truth.
        this.#processor.clearVolatileState();
        await this.#catchUpChunk(opened);
        this.#refreshLive();
        return;
      }

      const volatile = this.#processor.prepareVolatileFrame({
        events: input.events,
        persistedState: this.#runner.currentState,
        persistedThroughOffset: opened.checkpointOffset,
        scannedThroughOffset: input.scannedThroughOffset,
      });
      await opened.sink({
        events: input.events.filter((event) => event.ephemeral !== true),
        scannedAfterOffset: input.scannedAfterOffset,
        scannedThroughOffset: input.scannedThroughOffset,
        // The host owns bounded continuation. Stamping this local frame at its
        // own scan tail prevents the runner's generic unbounded self-pull.
        streamMaxOffset: input.scannedThroughOffset,
      });
      this.#acknowledgedThroughOffset = input.scannedThroughOffset;
      this.#processor.commitVolatileFrame(volatile);
      this.#refreshLive();
      await this.#armIfBehind();
    });
  }

  /** One alarm slice: bounded work and an explicit re-arm while still behind. */
  onAlarm(): Promise<void> {
    // One Durable Object alarm is shared by delivery retries, idle teardown,
    // core checkpointing, and this prototype. Only consume an alarm as feed
    // work when a prior bounded feed turn durably asked for continuation.
    if (!this.#storage.catchUpScheduled()) return Promise.resolve();
    this.#activated = true;
    return this.#enqueue(async () => {
      await this.#catchUpChunk();
      this.#refreshLive();
    });
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work);
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #catchUpChunk(
    existing?: Awaited<ReturnType<StreamProcessorRunner<StreamFeedContract>["openDelivery"]>>,
  ): Promise<void> {
    const opened = existing ?? (await this.#runner.openDelivery());
    let acknowledged = opened.checkpointOffset;
    this.#acknowledgedThroughOffset = acknowledged;
    if (acknowledged < this.#getCoreState().maxOffset) {
      this.#storage.setCatchUpScheduled(true);
      this.#processor.clearVolatileState();
    }

    for (let frame = 0; frame < CATCH_UP_FRAMES_PER_TURN; frame += 1) {
      const streamMaxOffset = this.#getCoreState().maxOffset;
      if (acknowledged >= streamMaxOffset) break;
      const scanned = this.#readRaw({
        afterOffset: acknowledged,
        limit: CATCH_UP_PAGE_SIZE + 1,
        includeEphemeral: true,
      });
      const hasLookahead = scanned.length > CATCH_UP_PAGE_SIZE;
      const events = hasLookahead ? scanned.slice(0, CATCH_UP_PAGE_SIZE) : scanned;
      const scannedThroughOffset = hasLookahead ? events.at(-1)!.offset : streamMaxOffset;
      await opened.sink({
        events: events.filter((event) => event.ephemeral !== true),
        scannedAfterOffset: acknowledged,
        scannedThroughOffset,
        // See onAppended: bounded host continuation owns the real head.
        streamMaxOffset: scannedThroughOffset,
      });
      acknowledged = scannedThroughOffset;
      this.#acknowledgedThroughOffset = acknowledged;
    }
    await this.#armIfBehind();
  }

  async #armIfBehind(): Promise<void> {
    const behind = this.#acknowledgedThroughOffset < this.#getCoreState().maxOffset;
    this.#storage.setCatchUpScheduled(behind);
    if (behind) {
      await this.#armAlarm(Date.now() + CATCH_UP_ALARM_DELAY_MS);
    }
  }

  #projectionStatus(): StreamFeedProjectionStatus {
    const streamMaxOffset = this.#getCoreState().maxOffset;
    return {
      acknowledgedThroughOffset: this.#acknowledgedThroughOffset,
      streamMaxOffset,
      caughtUp: this.#acknowledgedThroughOffset >= streamMaxOffset,
    };
  }

  #refreshLive(): void {
    if (!this.#runner.isLoaded) return;
    const history = this.#storage.read({ limit: RECENT_ITEM_LIMIT });
    const state = this.#runner.currentState;
    const core = this.#getCoreState();
    this.live.setState({
      agent: this.#processor.volatileAgentUiState ?? state.agent,
      recentItems: history.items,
      itemCount: history.total,
      paused: { paused: core.paused, reason: core.pauseReason },
      projection: this.#projectionStatus(),
    });
  }
}
