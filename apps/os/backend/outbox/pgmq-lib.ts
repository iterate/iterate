// outbox "library" implementation using pgmq. it could be split out into a separate package some day.
// it also has an oRPC middleware for easily registering consumers and sending events from procedures.
// before splitting out we'd probably want to abstract out things like drizzle first

// before using, you should create a table using pgmq, e.g. `select pgmq.create('my_consumer_job_queue')`

import { AsyncLocalStorage } from "node:async_hooks";
import { sql, SQL } from "drizzle-orm";
import { os, type Procedure, type InferSchemaInput, type InferSchemaOutput } from "@orpc/server";
import { z } from "zod/v4";
import * as _drizzleUtils from "drizzle-orm/utils";
import { logger } from "../tag-logger.ts";

const drizzleUtils = _drizzleUtils as typeof import("drizzle-orm/utils") & {
  orderSelectedFields?: (fields: Record<string, unknown>) => string[];
  mapResultRow?: (columns: string[], row: unknown[]) => Record<string, unknown>;
};

if (!drizzleUtils.orderSelectedFields || !drizzleUtils.mapResultRow) {
  throw new Error(
    "drizzle-orm/utils is not compatible with this version of pgmq-lib. We need orderSelectedFields and mapResultRow.",
  );
}

// Tracks the current consumer execution context so that events emitted
// inside a consumer handler automatically get `context.causedBy` populated.
export type OutboxCausation = {
  eventId: number;
  consumerName: string;
  jobId: number | string;
};

export const outboxALS = new AsyncLocalStorage<OutboxCausation>();

// Minimal DB interface - just needs to run raw SQL via drizzle's execute

type RawQueryResult<T> = { rows: T[]; rowCount: number };

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

type TimeUnit = "s" | "m" | "h" | "d";
export type TimePeriod = `${number}${TimeUnit}`;
const periodSeconds = (period: TimePeriod): number => {
  if (!period.match(/^\d+(s|m|h|d)$/))
    throw new Error(`Expected period in seconds, minutes, hours or days e.g. 123s, got ${period}`);
  const lastDigit = period.slice(-1) as TimeUnit;
  const value = Number(period.slice(0, -1));
  switch (lastDigit) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 60 * 60;
    case "d":
      return value * 60 * 60 * 24;
    default: {
      lastDigit satisfies never;
      throw new Error(`Unknown time unit: ${lastDigit}`);
    }
  }
};

export type WhenFn<Payload> = (params: { payload: Payload }) => boolean | null | undefined | "";
export type DelayFn<Payload> = (params: { payload: Payload }) => TimePeriod;

export type DBLike = { execute: (...args: any[]) => Promise<any> };
export type Transactable<D extends DBLike> = DBLike & {
  transaction: <T>(callback: (tx: D) => Promise<T>) => Promise<T>;
};

type RetryFn = (
  job: ConsumerJobQueueMessage,
  error: unknown,
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

export type EnqueueParams = { name: string; payload: { input: unknown; output: unknown } };

export type EnqueueResult = { eventId: string; matchedConsumers: number; delays: TimePeriod[] };

export type QueuerEvent = {
  job: ConsumerJobQueueMessage;
  error?: string;
};

export type QueuerEventMap = {
  statusChange: QueuerEvent;
};

export type DrizzleInsertOrUpdateQuery<T> = PromiseLike<T[]> & {
  getSQL: () => SQL;
  returning?: "If the returning prop is present, the query you are trying to use is not valid. You can only use this method with an insert or update query with a returning clause";
};

export interface Queuer<DBConnection> {
  $types: {
    db: DBConnection;
  };
  enqueueCTE: <D extends DBLike, Q extends DrizzleInsertOrUpdateQuery<unknown>>(
    db: D,
    query: Q,
    params: {
      name: string;
      payload: unknown;
      context?: Record<string, unknown>;
    },
  ) => Promise<Awaited<Q>>;
  enqueue: (db: DBConnection, params: EnqueueParams) => Promise<EnqueueResult>;
  enqueueBatch: (db: DBConnection, params: EnqueueParams[]) => Promise<EnqueueResult[]>;

  consumers: ConsumersRecord;

  /** Process some or all messages in the queue. Call this periodically or when you've just added events. */
  processQueue: (db: DBConnection) => Promise<string>;
  peekQueue: (db: DBConnection, options?: QueuePeekOptions) => Promise<ConsumerJobQueueMessage[]>;
  peekArchive: (db: DBConnection, options?: QueuePeekOptions) => Promise<ConsumerJobQueueMessage[]>;

  on: <K extends keyof QueuerEventMap>(
    event: K,
    listener: (data: QueuerEventMap[K]) => void,
  ) => void;
  off: <K extends keyof QueuerEventMap>(
    event: K,
    listener: (data: QueuerEventMap[K]) => void,
  ) => void;
}

/** Helper to normalize drizzle execute results (postgres.js returns array-like, we need .rows/.rowCount) */
function normalizeResult<T>(result: unknown): RawQueryResult<T> {
  // postgres.js via drizzle returns the rows array directly with additional properties
  if (Array.isArray(result)) {
    return { rows: [...result], rowCount: result.length };
  }
  const r = result as RawQueryResult<T>;
  return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 };
}

const getExec = <D extends DBLike>(db: D) => {
  const exec = async <T>(sql: SQL<T>) => normalizeResult<T>(await db.execute(sql));
  const rows = async <T>(sql: SQL<T>) => (await exec(sql)).rows;
  return Object.assign(exec, { rows });
};

export const createPgmqQueuer = (queueOptions: { queueName: string }): Queuer<DBLike> => {
  const { queueName } = queueOptions;
  const pgmqQueueTableName = `q_${queueName}`;
  const pgmqArchiveTableName = `a_${queueName}`;

  const listeners: { [K in keyof QueuerEventMap]?: Set<(data: QueuerEventMap[K]) => void> } = {};
  const emit = <K extends keyof QueuerEventMap>(event: K, data: QueuerEventMap[K]) => {
    for (const fn of listeners[event] ?? []) {
      try {
        fn(data);
      } catch (e) {
        logger.error(`[outbox] listener error for ${event}`, e);
      }
    }
  };

  const processQueue: Queuer<DBLike>["processQueue"] = async (db) => {
    const exec = getExec(db);
    const jobQueueMessages = await exec(
      sql`
        select * from pgmq.read(
          queue_name => ${queueName}::text,
          vt         => 30,
          qty        => 10
        )
      `,
    );
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
          await exec(sql`
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
        const [updated] = await exec.rows(sql<typeof job>`
          update pgmq.${sql.identifier(pgmqQueueTableName)}
          set message = jsonb_set(
            message,
            '{processing_results}',
            message->'processing_results' || jsonb_build_array(${`#${job.read_ct} success: ${String(result)}`}::text)
          ) || '{"status": "success"}'::jsonb
          where msg_id = ${job.msg_id}::bigint
          returning *
        `);
        await exec(sql`
          select pgmq.archive(queue_name => ${queueName}::text, msg_id => ${job.msg_id}::bigint)
        `);
        emit("statusChange", { job: updated });
        logger.info(`[outbox] DONE msg_id=${job.msg_id}. Result: ${result}`);
      } catch (e) {
        if (!job) {
          logger.error(`[outbox] unparseable message, skipping`, e, { job: _job });
          continue;
        }
        let retryFn = consumer?.retry ?? defaultRetryFn;
        if ((e as Record<string, unknown>)?.retryable === false) {
          retryFn = () => ({ retry: false, reason: "Error marked non-retryable." });
        }
        const retry = retryFn(job, e);
        const retryMessage = Object.entries(retry)
          .map(([k, v]) => `${k}: ${v}`)
          .join(". ");
        logger.error(`[outbox] FAILED msg_id=${job.msg_id}. ${retryMessage}`, e);

        const statusObj = JSON.stringify({ status: retry.retry ? "retrying" : "failed" });

        const [updated] = await exec.rows(sql<typeof job>`
          update pgmq.${sql.identifier(pgmqQueueTableName)}
          set message = jsonb_set(
            message,
            '{processing_results}',
            message->'processing_results' || jsonb_build_array(${`#${job.read_ct} error: ${String(e)}. ${retryMessage}`}::text)
          ) || ${statusObj}::jsonb
          where msg_id = ${job.msg_id}::bigint
          returning *
        `);
        const eventData: QueuerEvent = { job: updated, error: String(e) };
        if (!retry.retry) {
          logger.warn(
            `[outbox] giving up on ${job.msg_id} after ${job.read_ct} attempts. Archiving (DLQ = archive + status=failed)`,
          );
          const archived = await exec(sql`
            select * from pgmq.archive(queue_name => ${queueName}::text, msg_id => ${job.msg_id}::bigint)
          `);
          if (!archived.rows[0]) throw new Error(`Failed to archive message ${job.msg_id}`);
        } else {
          logger.info(`[outbox] Setting msg_id=${job.msg_id} to visible in ${retry.delay}`);
          await exec(sql`
            select pgmq.set_vt(
              queue_name => ${queueName}::text,
              msg_id => ${job.msg_id}::bigint,
              vt => ${periodSeconds(retry.delay)}::integer
            )
          `);
        }
        emit("statusChange", eventData);
      }
    }

    return `${jobQueueMessages.rowCount} messages processed:\n\n${results.join("\n")}`.replace(
      /:\n\n$/,
      "",
    );
  };

  const consumers: Queuer<DBLike>["consumers"] = {};

  const sendConsumerMessages = async (
    db: DBLike,
    messages: Array<{ message: ConsumerEvent; delay: TimePeriod }>,
  ) => {
    if (messages.length === 0) return;

    const exec = getExec(db);
    const messagesByDelay = new Map<TimePeriod, ConsumerEvent[]>();
    for (const entry of messages) {
      const group = messagesByDelay.get(entry.delay) ?? [];
      group.push(entry.message);
      messagesByDelay.set(entry.delay, group);
    }

    for (const [delay, batchedMessages] of messagesByDelay) {
      if (batchedMessages.length === 1) {
        await exec(sql`
          select from pgmq.send(
            queue_name  => ${queueName}::text,
            msg         => ${JSON.stringify(batchedMessages[0])}::jsonb,
            delay => ${periodSeconds(delay)}::integer
          )
        `);
        continue;
      }

      const pgMessages = sql.join(
        batchedMessages.map((message) => sql`${JSON.stringify(message)}::jsonb`),
        sql`, `,
      );

      await exec(sql`
        select * from pgmq.send_batch(
          queue_name => ${queueName}::text,
          msgs => array[${pgMessages}]::jsonb[],
          delay => ${periodSeconds(delay)}::integer
        )
      `);
    }
  };

  const buildConsumerMessages = (
    params: EnqueueParams,
    eventId: number,
    context: Record<string, unknown>,
  ) => {
    const consumersForPath = Object.values(consumers[`eventName:${params.name}`] || {});
    const filteredConsumers = consumersForPath.filter((c) => c.when({ payload: params.payload }));

    logger.info(
      `[outbox] Path: ${params.name}. Consumers: ${consumersForPath.length}. Filtered: ${filteredConsumers.map((c) => c.name).join(",")}`,
    );

    const delays: TimePeriod[] = [];
    const messages = filteredConsumers.map((consumer) => {
      const delay = consumer.delay({ payload: params.payload });
      delays.push(delay);
      return {
        delay,
        message: {
          consumer_name: consumer.name,
          status: "pending",
          event_name: params.name,
          event_id: eventId,
          event_payload: params.payload,
          event_context: context,
          processing_results: [],
          environment: process.env.APP_STAGE || process.env.NODE_ENV || "unknown",
        } satisfies ConsumerEvent,
      };
    });

    return { delays, matchedConsumers: filteredConsumers.length, messages };
  };

  const enqueue: Queuer<DBLike>["enqueue"] = async (db, params) => {
    return (await enqueueBatch(db, [params]))[0];
  };

  const enqueueCTE: Queuer<DBLike>["enqueueCTE"] = async (
    db,
    query,
    params,
  ): Promise<Awaited<typeof query>> => {
    const { name, payload, context = {} } = params;
    const exec = getExec(db);
    const cteSql = sql`with query as (`.append(query.getSQL()).append(sql`)`).append(sql`
      insert into outbox_event (name, payload, context)
      select ${name}, ${JSON.stringify(payload)}::jsonb, ${JSON.stringify(context)}::jsonb
      from query
      returning query.*
    `);
    const result = await exec(cteSql);
    const config = (query as { config?: { returningFields: Record<string, unknown> } }).config;
    const columns = drizzleUtils.orderSelectedFields!(config!.returningFields);
    const mapped = result.rows.map((row) =>
      drizzleUtils.mapResultRow!(columns, Object.values(row as {})),
    );
    return mapped as Awaited<typeof query>;
  };

  const enqueueBatch: Queuer<DBLike>["enqueueBatch"] = async (db, paramsList) => {
    if (paramsList.length === 0) return [];

    const causation = outboxALS.getStore();
    const context = causation ? { causedBy: causation } : {};
    const exec = getExec(db);
    const allMessages: Array<{ message: ConsumerEvent; delay: TimePeriod }> = [];

    logger.info(`[outbox] adding ${paramsList.length} events to pgmq:${queueName}`);
    const insertValues = sql.join(
      paramsList.map(
        (params) =>
          sql`(${params.name}, ${JSON.stringify(params.payload)}, ${JSON.stringify(context)}::jsonb)`,
      ),
      sql`, `,
    );
    const insertResult = await exec(sql<typeof InsertedEvent>`
      insert into outbox_event (name, payload, context)
      values ${insertValues}
      returning id
    `);
    const insertedEvents = z.array(InsertedEvent).parse(insertResult.rows);
    const results = paramsList.map((params, index) => {
      const eventInsertion = insertedEvents[index];
      if (!eventInsertion) {
        throw new Error(`Expected inserted event at index ${index}`);
      }
      const eventId = Number(eventInsertion.id satisfies string);
      const { delays, matchedConsumers, messages } = buildConsumerMessages(
        params,
        eventId,
        context,
      );
      allMessages.push(...messages);
      return { eventId: eventInsertion.id, matchedConsumers, delays };
    });

    await sendConsumerMessages(db, allMessages);

    return results;
  };

  return {
    $types: { db: {} as DBLike },
    consumers,
    enqueue,
    enqueueBatch,
    enqueueCTE,
    processQueue: (db) => processQueue(db),
    peekQueue: async (db, options = {}) => {
      const exec = getExec(db);
      const result = await exec(sql`
        select * from pgmq.${sql.identifier(pgmqQueueTableName)}
        where read_ct >= ${options.minReadCount || 0}
        order by enqueued_at desc
        limit ${options.limit || 10}
        offset ${options.offset || 0}
      `);
      return ConsumerJobQueueMessage.array().parse(result.rows);
    },
    peekArchive: async (db, options = {}) => {
      const exec = getExec(db);
      const result = await exec(sql`
        select * from pgmq.${sql.identifier(pgmqArchiveTableName)}
        where read_ct >= ${options.minReadCount || 0}
        order by archived_at desc
        limit ${options.limit || 10}
        offset ${options.offset || 0}
      `);
      return ConsumerJobQueueMessage.array().parse(result.rows);
    },
    on: (event, listener) => {
      (listeners[event] ??= new Set()).add(listener as (data: QueuerEvent) => void);
    },
    off: (event, listener) => {
      listeners[event]?.delete(listener as (data: QueuerEvent) => void);
    },
  };
};

export type ConsumerPluginCtx = {
  calls?: Record<string, string[]>;
};

/** A function that instructs the runtime/platform to not die until the promise is completed. */
export type WaitUntilFn = (promise: Promise<unknown>) => undefined | void;

/**
 * Creates an oRPC middleware that injects a `sendEvent` helper into context.
 * Use `context.sendEvent(tx, output)` in a handler to enqueue an outbox event.
 */
export const createPostProcedureConsumerPlugin = <
  EventTypes extends Record<string, {}>,
  DBConnection,
>(
  ...args: Parameters<typeof createConsumerClient<EventTypes, DBConnection>>
) => {
  const consumerClient = createConsumerClient(...args);

  return os.$context<{ db: DBConnection }>().middleware(async ({ context, next, path }, input) => {
    return next({
      context: {
        sendEvent: async <T extends {}>(db: DBConnection, output: T) => {
          const payload = { input, output };
          await consumerClient.send(
            { transaction: db as DBLike, parent: context.db as DBLike },
            `rpc:${path.join(".")}`,
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

/** Extract the procedures from an oRPC router (plain object of nested procedures) */
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
  [K in Exclude<keyof P, "~orpc">]: P[K] extends { "~orpc": object }
    ? {
        path: `${Prefix}${Extract<K, string>}`;
        proc: P[K];
      }
    : ProcUnion<P[K], `${Prefix}${Extract<K, string>}.`>;
}[Exclude<keyof P, "~orpc">];

const defaultWaitUntil: WaitUntilFn = (promise) => void promise;

/**
 * Create a typed consumer client for registering consumers and sending events.
 */
export const createConsumerClient = <EventTypes extends Record<string, {}>, DBConnection>(
  queuer: Queuer<DBConnection>,
  { waitUntil = defaultWaitUntil, getDb }: { waitUntil?: WaitUntilFn; getDb: () => DBLike },
) => {
  type EventName = Extract<keyof EventTypes, string>;
  type SendBatchItem = { [K in EventName]: { eventName: K; payload: EventTypes[K] } }[EventName];
  const scheduleQueueProcessing = (db: DBConnection, delays: TimePeriod[]) => {
    for (const delay of new Set(delays)) {
      // as a convenience, we'll process the queue automatically after the delay + a 10% buffer
      let delayMs = periodSeconds(delay) * 1000;
      delayMs = Math.max(20, delayMs * 1.1); // add 10% buffer to avoid race conditions, add 20ms minimum to let transactions complete
      if (delayMs > 120_000) continue; // don't bother with super long delays
      waitUntil(
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return queuer.processQueue(db);
        })(),
      );
    }
  };

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
    scheduleQueueProcessing(connections.parent as DBConnection, addResult.delays);
    return addResult;
  };

  const sendCTE = async <Name extends EventName, T>(
    query: DrizzleInsertOrUpdateQuery<T>,
    params: { name: Name; payload: EventTypes[Name] },
  ) => {
    const addResult = await queuer.enqueueCTE(getDb(), query, {
      name: params.name,
      payload: params.payload as never,
    });
    // scheduleQueueProcessing(db, addResult);
    return addResult;
  };

  const sendBatch = async (
    connections: {
      transaction: DBLike;
      parent: DBLike;
    },
    events: SendBatchItem[],
  ) => {
    if (events.length === 0) return [];

    const addResults = await queuer.enqueueBatch(
      connections.transaction as DBConnection,
      events.map((event) => ({
        name: event.eventName,
        payload: event.payload as never,
      })),
    );
    scheduleQueueProcessing(
      connections.parent as DBConnection,
      addResults.flatMap((result) => result.delays),
    );
    return addResults;
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

    scheduleQueueProcessing(parent as DBConnection, addResult.delays);

    return result;
  }

  return {
    registerConsumer,
    send,
    sendBatch,
    sendTx,
    sendCTE,
  };
};

/** Extract input/output from an oRPC Procedure type */
type ProcedureIO<P> =
  P extends Procedure<any, any, infer TInputSchema, infer TOutputSchema, any, any>
    ? { input: InferSchemaInput<TInputSchema>; output: InferSchemaOutput<TOutputSchema> }
    : never;

/**
 * Extract typed event map from an oRPC router.
 * Only includes procedures whose output has `$enqueued` (i.e. procedures that emit outbox events).
 */
export type RouterEventTypes<R extends Record<string, any>> = {
  [K in keyof FlattenProcedures<R> as ProcedureIO<FlattenProcedures<R>[K]>["output"] extends {
    $enqueued?: true;
  }
    ? `rpc:${Extract<K, string>}`
    : never]: ProcedureIO<FlattenProcedures<R>[K]>;
};
