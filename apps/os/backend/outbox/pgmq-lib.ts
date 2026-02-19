// outbox "library" implementation using pgmq. it could be split out into a separate package some day.
// it also has a trpc plugin for easily registering consumers and sending events from procedures.
// before splitting out we'd probably want to abstract out things like drizzle first

// before using, you should create a table using pgmq, e.g. `select pgmq.create('my_consumer_job_queue')`

import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { initTRPC, type AnyTRPCRouter, type AnyTRPCProcedure } from "@trpc/server";
import { z } from "zod/v4";
import { logger } from "../tag-logger.ts";

// Tracks the current consumer execution context so that events emitted
// inside a consumer handler automatically get `context.causedBy` populated.
export type OutboxCausation = {
  eventId: number;
  consumerName: string;
  jobId: number | string;
};

export const outboxALS = new AsyncLocalStorage<OutboxCausation>();

// Minimal DB interface - just needs to run raw SQL via drizzle's execute

type RawQueryResult = { rows: any[]; rowCount: number };

export const ConsumerEvent = z.object({
  event_name: z.string(),
  consumer_name: z.string(),
  event_id: z.number(),
  event_payload: z.looseObject({}),
  event_context: z.unknown(),
  processing_results: z.array(z.unknown()),
  environment: z.string(),
  status: z.enum(["pending", "success", "retrying", "failed"]).optional(),
});

export type ConsumerEvent = z.infer<typeof ConsumerEvent>;

export const ConsumerJobQueueMessage = z.object({
  msg_id: z.number().or(z.string()),
  enqueued_at: z.string(),
  vt: z.string(),
  read_ct: z.number(),
  message: ConsumerEvent,
});
export type ConsumerJobQueueMessage = z.infer<typeof ConsumerJobQueueMessage>;

export const InsertedEvent = z.looseObject({
  id: z.string(),
});

export type TimePeriod = `${number}s`;
const periodSeconds = (period: TimePeriod): number => {
  if (!period.match(/^\d+s$/))
    throw new Error(`Expected period in seconds e.g. 123s, got ${period}`);
  return Number(period.replace("s", ""));
};

export type WhenFn<Payload> = (params: { payload: Payload }) => boolean | null | undefined | "";
export type DelayFn<Payload> = (params: { payload: Payload }) => TimePeriod;

export type DBLike = { execute: (...args: any[]) => Promise<any> };
export type Transactable<D extends DBLike> = DBLike & {
  transaction: <T>(callback: (tx: D) => Promise<T>) => Promise<T>;
};

type RetryFn = (
  job: ConsumerJobQueueMessage,
) =>
  | { retry: false; reason: string; delay?: never }
  | { retry: true; reason: string; delay: TimePeriod };

export type ConsumerDefinition<Payload> = {
  /** consumer name */
  name: string;
  when: WhenFn<Payload>;
  /** delay before processing in seconds. if not specified, will process immediately */
  delay: DelayFn<Payload>;
  retry: RetryFn;
  /** visibility timeout in seconds. extend this for long-running handlers
   * to prevent the message from becoming visible again mid-processing.
   * default queue VT is 30s. */
  visibilityTimeout?: TimePeriod;
  /** handler function */
  handler: (params: {
    eventName: string;
    eventId: number;
    payload: Payload;
    job: { id: number | string; attempt: number };
  }) => Promise<void | string>;
};

export type ConsumersForEvent = Record<`consumerName:${string}`, ConsumerDefinition<{}>>;

export type ConsumersRecord = Record<`eventName:${string}`, ConsumersForEvent>;

export type QueuePeekOptions = { limit?: number; offset?: number; minReadCount?: number };

export interface Queuer<DBConnection> {
  $types: {
    db: DBConnection;
  };
  enqueue: (
    db: DBConnection,
    params: { name: string; payload: { input: unknown; output: unknown } },
  ) => Promise<{ eventId: string; matchedConsumers: number; delays: TimePeriod[] }>;

  consumers: ConsumersRecord;

  /** Process some or all messages in the queue. Call this periodically or when you've just added events. */
  processQueue: (db: DBConnection) => Promise<string>;
  peekQueue: (db: DBConnection, options?: QueuePeekOptions) => Promise<ConsumerJobQueueMessage[]>;
  peekArchive: (db: DBConnection, options?: QueuePeekOptions) => Promise<ConsumerJobQueueMessage[]>;
}

/** Helper to normalize drizzle execute results (postgres.js returns array-like, we need .rows/.rowCount) */
function normalizeResult(result: unknown): RawQueryResult {
  // postgres.js via drizzle returns the rows array directly with additional properties
  if (Array.isArray(result)) {
    return { rows: [...result], rowCount: result.length };
  }
  const r = result as RawQueryResult;
  return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 };
}

export const createPgmqQueuer = (queueOptions: { queueName: string }): Queuer<DBLike> => {
  const { queueName } = queueOptions;
  const pgmqQueueTableName = `q_${queueName}`;
  const pgmqArchiveTableName = `a_${queueName}`;
  const processQueue: Queuer<DBLike>["processQueue"] = async (db) => {
    const raw = await db.execute(
      sql`
        select * from pgmq.read(
          queue_name => ${queueName}::text,
          vt         => 30,
          qty        => 10
        )
      `,
    );
    const jobQueueMessages = normalizeResult(raw);
    if (jobQueueMessages.rowCount)
      logger.info(`[outbox] processing ${jobQueueMessages.rowCount} messages`);
    const results: Array<string | void> = [];
    for (const _job of jobQueueMessages.rows) {
      const parsed = ConsumerJobQueueMessage.safeParse(_job);
      let job: ConsumerJobQueueMessage | undefined;
      let consumer: ConsumerDefinition<{}> | undefined;
      try {
        if (!parsed.success) {
          throw new Error(`[outbox] invalid message: ${z.prettifyError(parsed.error)}`);
        }
        job = parsed.data;
        consumer =
          consumers[`eventName:${job.message.event_name}`]?.[
            `consumerName:${job.message.consumer_name}`
          ];
        if (!consumer) {
          throw new Error(
            `[outbox] no consumer found for event=${job.message.event_name} consumer=${job.message.consumer_name}`,
          );
        }
        logger.info(`[outbox] START msg_id=${job.msg_id} consumer=${consumer.name}`);
        if (consumer.visibilityTimeout) {
          await db.execute(sql`
            select pgmq.set_vt(
              queue_name => ${queueName}::text,
              msg_id => ${job.msg_id}::bigint,
              vt => ${periodSeconds(consumer.visibilityTimeout)}::integer
            )
          `);
        }
        const causation: OutboxCausation = {
          eventId: job.message.event_id,
          consumerName: consumer.name,
          jobId: job.msg_id,
        };
        // Bind to const so TS narrows inside the closure
        const _consumer = consumer;
        const _job = job;
        const result = await outboxALS.run(causation, () =>
          _consumer.handler({
            eventId: _job.message.event_id,
            eventName: _job.message.event_name,
            payload: _job.message.event_payload as { input: unknown; output: unknown },
            job: { id: _job.msg_id, attempt: _job.read_ct },
          }),
        );
        results.push(result);
        await db.execute(sql`
          update pgmq.${sql.identifier(pgmqQueueTableName)}
          set message = jsonb_set(
            message,
            '{processing_results}',
            message->'processing_results' || jsonb_build_array(${`#${job.read_ct} success: ${String(result)}`}::text)
          ) || '{"status": "success"}'::jsonb
          where msg_id = ${job.msg_id}::bigint
        `);
        await db.execute(sql`
          select pgmq.archive(queue_name => ${queueName}::text, msg_id => ${job.msg_id}::bigint)
        `);
        logger.info(`[outbox] DONE msg_id=${job.msg_id}. Result: ${result}`);
      } catch (e) {
        if (!job) {
          logger.error(`[outbox] unparseable message, skipping`, { job: _job, error: e });
          continue;
        }
        const retry = (consumer?.retry ?? defaultRetryFn)(job);
        const retryMessage = Object.entries(retry)
          .map(([k, v]) => `${k}: ${v}`)
          .join(". ");
        logger.error(`[outbox] FAILED msg_id=${job.msg_id}. ${retryMessage}`, e);

        const statusObj = JSON.stringify({ status: retry.retry ? "retrying" : "failed" });

        await db.execute(sql`
          update pgmq.${sql.identifier(pgmqQueueTableName)}
          set message = jsonb_set(
            message,
            '{processing_results}',
            message->'processing_results' || jsonb_build_array(${`#${job.read_ct} error: ${String(e)}. ${retryMessage}`}::text)
          ) || ${statusObj}::jsonb
          where msg_id = ${job.msg_id}::bigint
        `);
        if (!retry.retry) {
          logger.warn(
            `[outbox] giving up on ${job.msg_id} after ${job.read_ct} attempts. Archiving (DLQ = archive + status=failed)`,
          );
          const archived = normalizeResult(
            await db.execute(sql`
              select * from pgmq.archive(queue_name => ${queueName}::text, msg_id => ${job.msg_id}::bigint)
            `),
          );
          if (!archived.rows[0]) throw new Error(`Failed to archive message ${job.msg_id}`);
        } else {
          logger.info(`[outbox] Setting msg_id=${job.msg_id} to visible in ${retry.delay}`);
          await db.execute(sql`
            select pgmq.set_vt(
              queue_name => ${queueName}::text,
              msg_id => ${job.msg_id}::bigint,
              vt => ${periodSeconds(retry.delay)}::integer
            )
          `);
        }
      }
    }

    return `${jobQueueMessages.rowCount} messages processed:\n\n${results.join("\n")}`.replace(
      /:\n\n$/,
      "",
    );
  };

  const consumers: Queuer<DBLike>["consumers"] = {};

  const enqueue: Queuer<DBLike>["enqueue"] = async (db, params) => {
    logger.info(`[outbox] adding to pgmq:${params.name}`);
    const causation = outboxALS.getStore();
    const context = causation ? { causedBy: causation } : {};
    const insertResult = normalizeResult(
      await db.execute(sql`
        insert into outbox_event (name, payload, context)
        values (${params.name}, ${JSON.stringify(params.payload)}, ${JSON.stringify(context)}::jsonb)
        returning id
      `),
    );
    const eventInsertion = InsertedEvent.parse(insertResult.rows[0]);

    const consumersForPath = Object.values(consumers[`eventName:${params.name}`] || {});
    const filteredConsumers = consumersForPath.filter((c) => c.when({ payload: params.payload }));

    logger.info(
      `[outbox] Path: ${params.name}. Consumers: ${consumersForPath.length}. Filtered: ${filteredConsumers.map((c) => c.name).join(",")}`,
    );

    const delays: TimePeriod[] = [];
    for (const consumer of filteredConsumers) {
      const delay = consumer.delay({ payload: params.payload });
      delays.push(delay);
      await db.execute(sql`
        select from pgmq.send(
          queue_name  => ${queueName}::text,
          msg         => ${JSON.stringify({
            consumer_name: consumer.name,
            status: "pending",
            event_name: params.name,
            event_id: Number(eventInsertion.id satisfies string),
            event_payload: params.payload,
            event_context: context,
            processing_results: [],
            environment: process.env.APP_STAGE || process.env.NODE_ENV || "unknown",
          } satisfies ConsumerEvent)}::jsonb,
          delay => ${periodSeconds(delay)}::integer
        )
      `);
    }
    return { eventId: eventInsertion.id, matchedConsumers: filteredConsumers.length, delays };
  };

  return {
    $types: { db: {} as DBLike },
    consumers,
    enqueue,
    processQueue: (db) => processQueue(db),
    peekQueue: async (db, options = {}) => {
      const result = normalizeResult(
        await db.execute(sql`
          select * from pgmq.${sql.identifier(pgmqQueueTableName)}
          where read_ct >= ${options.minReadCount || 0}
          order by enqueued_at desc
          limit ${options.limit || 10}
          offset ${options.offset || 0}
        `),
      );
      return ConsumerJobQueueMessage.array().parse(result.rows);
    },
    peekArchive: async (db, options = {}) => {
      const result = normalizeResult(
        await db.execute(sql`
          select * from pgmq.${sql.identifier(pgmqArchiveTableName)}
          where read_ct >= ${options.minReadCount || 0}
          order by archived_at desc
          limit ${options.limit || 10}
          offset ${options.offset || 0}
        `),
      );
      return ConsumerJobQueueMessage.array().parse(result.rows);
    },
  };
};

export type ConsumerPluginCtx = {
  calls?: Record<string, string[]>;
};

/** A function that instructs the runtime/platform to not die until the promise is completed. */
export type WaitUntilFn = (promise: Promise<unknown>) => undefined | void;

/**
 * Creates a tRPC middleware that injects a `sendTrpc` helper into context.
 * Use `ctx.sendTrpc(tx, output)` in a mutation to enqueue an outbox event.
 */
export const createPostProcedureConsumerPlugin = <
  EventTypes extends Record<string, {}>,
  DBConnection,
>(
  ...args: Parameters<typeof createConsumerClient<EventTypes, DBConnection>>
) => {
  const consumerClient = createConsumerClient(...args);
  const pluginTrpc = initTRPC.context<{ db: DBConnection }>().create();

  return pluginTrpc.procedure.use(async ({ getRawInput, next, ctx: _ctx, path }) => {
    return next({
      ctx: {
        sendTrpc: async <T extends {}>(db: DBConnection, output: T) => {
          const input = await getRawInput();
          const payload = { input, output };
          await consumerClient.send(
            { transaction: db as DBLike, parent: _ctx.db as DBLike },
            `trpc:${path}`,
            payload,
          );

          return output as T & { $enqueued: true };
        },
      },
    });
  });
};

export const defaultRetryFn: RetryFn = (job) => {
  if (job.read_ct > 5) {
    return { retry: false, reason: "max retries reached" };
  }
  const delaySeconds = Math.ceil(2 ** Math.max(0, job.read_ct - 1) * (0.9 + Math.random() * 0.2));
  const delay: TimePeriod = `${delaySeconds}s`;
  return {
    retry: true,
    reason: `attempt ${job.read_ct} setting to visible in ${delay}`,
    delay,
  };
};

/** Extract the procedures from a trpc router def */
export type FlattenProcedures<P, Prefix extends string = ""> =
  ProcUnion<P, Prefix> extends infer U
    ? {
        [K in U extends { path: string } ? U["path"] : never]: U extends {
          path: K;
          proc: infer Proc;
        }
          ? Proc
          : never;
      }
    : never;

type ProcUnion<P, Prefix extends string = ""> = {
  [K in keyof P]: P[K] extends AnyTRPCProcedure
    ? {
        path: `${Prefix}${Extract<K, string>}`;
        proc: P[K];
      }
    : ProcUnion<P[K], `${Prefix}${Extract<K, string>}.`>;
}[keyof P];

/**
 * Create a typed consumer client for registering consumers and sending events.
 */
export const createConsumerClient = <EventTypes extends Record<string, {}>, DBConnection>(
  queuer: Queuer<DBConnection>,
  { waitUntil = ((promise) => void promise) as WaitUntilFn } = {},
) => {
  type EventName = Extract<keyof EventTypes, string>;
  const registerConsumer = <P extends EventName>(options: {
    name: string;
    on: P;
    when?: WhenFn<EventTypes[P]>;
    delay?: DelayFn<EventTypes[P]>;
    retry?: RetryFn;
    /** visibility timeout in seconds for long-running handlers (default: 30s from pgmq.read) */
    visibilityTimeout?: TimePeriod;
    handler: (params: {
      eventName: P;
      eventId: number;
      payload: EventTypes[P];
      job: { id: string | number; attempt: number };
    }) => string | void | Promise<string | void>;
  }) => {
    queuer.consumers[`eventName:${options.on}`] ||= {};
    const consumersForEvent: ConsumersForEvent = queuer.consumers[`eventName:${options.on}`];
    const def: ConsumerDefinition<EventTypes[P]> = {
      name: options.name,
      when: options.when || (() => true),
      delay: options.delay || (() => "0s"),
      retry: options.retry || defaultRetryFn,
      visibilityTimeout: options.visibilityTimeout,
      handler: async (params) => {
        return options.handler({
          eventName: options.on,
          eventId: params.eventId,
          job: params.job,
          payload: params.payload as EventTypes[P],
        });
      },
    };
    consumersForEvent[`consumerName:${options.name}`] = def as ConsumerDefinition<{}>;
  };

  const send = async <Name extends EventName>(
    connections: {
      /** the transaction reference for inserting the event record */
      transaction: DBLike;
      /** the parent db connection for processing consumers after commit */
      parent: DBLike;
    },
    eventName: Name,
    payload: EventTypes[Name],
  ) => {
    const addResult = await queuer.enqueue(connections.transaction as DBConnection, {
      name: eventName,
      payload: payload as never,
    });
    for (const delay of new Set(addResult.delays)) {
      // as a convenience, we'll process the queue automatically after the delay + a 10% buffer
      let delayMs = periodSeconds(delay) * 1000;
      delayMs = Math.max(20, delayMs * 1.1); // add 10% buffer to avoid race conditions, add 20ms minimum to let transactions complete
      if (delayMs > 120_000) continue; // don't bother with super long delays
      waitUntil(
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return queuer.processQueue(connections.parent as DBConnection);
        })(),
      );
    }
    return addResult;
  };

  /** Send an event in a db transaction. The outbox event is inserted in the same transaction as the callback. */
  async function sendTx<
    D extends DBLike,
    Name extends EventName,
    T extends { payload: EventTypes[Name] },
  >(parent: Transactable<D>, eventName: Name, callback: (db: D) => Promise<T>): Promise<T> {
    const { addResult, result } = await parent.transaction(async (tx) => {
      const result = await callback(tx);
      const addResult = await queuer.enqueue(tx as {} as DBConnection, {
        name: eventName,
        payload: result.payload as never,
      });
      return { addResult, result };
    });

    if (addResult.matchedConsumers > 0) {
      waitUntil(
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return queuer.processQueue(parent as DBConnection);
        })(),
      );
    }

    return result;
  }

  return {
    registerConsumer,
    send,
    sendTx,
  };
};

/** Types-only helper to extract event types from a tRPC router */
export const getTrpcEventTypes = <R extends AnyTRPCRouter>() => {
  type FlatProcedures = FlattenProcedures<R["_def"]["procedures"]>;
  type ProcedureTypes<P extends keyof FlatProcedures> = FlatProcedures[P] extends {
    _def: { $types: { input: infer I; output: infer O } };
  }
    ? { input: I; output: O }
    : never;

  type EventableProcedureName = {
    [K in keyof FlatProcedures]: ProcedureTypes<K>["output"] extends { $enqueued?: true }
      ? Extract<K, string>
      : never;
  }[keyof FlatProcedures];

  type EventTypes = {
    [K in EventableProcedureName as `trpc:${K}`]: ProcedureTypes<K>;
  };

  return { EventTypes: {} as EventTypes };
};

export type TrpcEventTypes<R extends AnyTRPCRouter> = ReturnType<
  typeof getTrpcEventTypes<R>
>["EventTypes"];
