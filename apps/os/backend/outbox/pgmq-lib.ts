// outbox "library" implementation using pgmq. it could be split out into a separate package some day.
// it also has an oRPC middleware for easily registering consumers and sending events from procedures.
// before splitting out we'd probably want to abstract out things like drizzle first

// before using, you should create a table using pgmq, e.g. `select pgmq.create('my_consumer_job_queue')`

import { AsyncLocalStorage } from "node:async_hooks";
import { randomInt } from "node:crypto";
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

const groupBy = <T, K>(items: T[], key: (item: T) => K): Map<K, T[]> => {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = map.get(k) ?? [];
    group.push(item);
    map.set(k, group);
  }
  return map;
};

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

export type CTEableQuery<T> = DrizzleInsertOrUpdateQuery<T> | Array<T>;

export type SQLEquivalent<T> =
  T extends Record<string, unknown>
    ? {
        [K in keyof T]: SQL<T[K]> | T[K];
      }
    : T;

export type CTEParams<T, Name extends string, Payload> = {
  query: CTEableQuery<T>;
  name: Name;
  payload: Payload | ((queryResult: T) => Payload);
  context?: Record<string, unknown>;
  /** Optional db/transaction to use instead of the default connection. */
  connection?: DBLike;
};

export interface Queuer<DBConnection> {
  $types: {
    db: DBConnection;
  };
  /** Enqueue an event using a CTE query. */
  enqueueCTE: <D extends DBLike, T>(
    db: D,
    params: CTEParams<T, string, unknown>,
  ) => Promise<T[] & { delays: TimePeriod[] }>;
  enqueue: (
    db: DBConnection,
    params: { name: string; payload: { input: unknown; output: unknown } },
  ) => Promise<{ eventId: string; matchedConsumers: number; delays: TimePeriod[] }>;

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

  const enqueue: Queuer<DBLike>["enqueue"] = async (db, params) => {
    logger.info(`[outbox] adding to pgmq:${params.name}`);
    const causation = outboxALS.getStore();
    const context = causation ? { causedBy: causation } : {};
    const exec = getExec(db);
    const insertResult = await exec(sql<typeof InsertedEvent>`
      insert into outbox_event (name, payload, context)
      values (${params.name}, ${JSON.stringify(params.payload)}, ${JSON.stringify(context)}::jsonb)
      returning id
    `);
    const eventInsertion = InsertedEvent.parse(insertResult.rows[0]);

    const consumersForPath = Object.values(consumers[`eventName:${params.name}`] || {});
    const filteredConsumers = consumersForPath.filter((c) => c.when({ payload: params.payload }));

    logger.info(
      `[outbox] Path: ${params.name}. Consumers: ${consumersForPath.length}. Filtered: ${filteredConsumers.map((c) => c.name).join(",")}`,
    );

    const delays: TimePeriod[] = [];
    // TODO: batch the `pgmq.send` calls below when we add a bulk enqueue path.
    for (const consumer of filteredConsumers) {
      const delay = consumer.delay({ payload: params.payload });
      delays.push(delay);
      await exec(sql`
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

  const enqueueCTE: Queuer<DBLike>["enqueueCTE"] = async (
    db,
    params,
  ): Promise<Awaited<(typeof params)["query"]> & { delays: TimePeriod[] }> => {
    const causation = outboxALS.getStore();
    const { query } = params;

    const { name, payload: payloadOrFn } = params;
    let context = params.context || {};
    if (causation) context = { ...context, causedBy: causation };

    let payload = payloadOrFn;
    if (typeof payloadOrFn === "function") {
      // if a function is passed, replace usage like `result => ({ foo: result.bar })` with `{ foo: sql`query.bar` }`
      const proxy = new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (typeof prop !== "string")
              throw new Error(`Property name must be a string, got ${String(prop)}`);
            if (!prop.match(/^\w+$/))
              throw new Error(`Property name must be a valid SQL identifier, got ${prop}`);
            prop = prop.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
            return sql.raw(`query.${prop}`);
          },
        },
      );
      payload = payloadOrFn(proxy);
    }
    const exec = getExec(db);
    const getSQL = () => {
      if (Array.isArray(query)) {
        return sql`select x.* from jsonb_array_elements(${JSON.stringify(query)}) as x`;
      }
      return query.getSQL();
    };

    /** take an object value that has some sql`...` values in it, possibly deeply-nested, and gives you a valid jsonb object for it with the evaluated values */
    const jsonbify = (val: unknown) => {
      const placeholders: Array<[string, SQL]> = [];
      const random = randomInt(1_000_000_000);
      const json = JSON.stringify(val, (_key, value) => {
        if (typeof (value as any)?.getSQL === "function") {
          const placeholder = `____PGMQ_LIB_SQL_PLACEHOLDER_${random}_${placeholders.length}____`;
          placeholders.push([placeholder, value]);
          return placeholder;
        }
        return value;
      });
      const text = placeholders.reduce(
        (acc, [placeholder, value]) =>
          sql`replace(${acc}, ${JSON.stringify(placeholder)}, coalesce(to_jsonb(${value})::text, 'null'))`,
        sql`${json}`,
      );
      return text.append(sql`::jsonb`);
    };

    const cteSql = sql`
      with query as (
        ${getSQL()}
      ),
      insertion as (
        insert into outbox_event (name, payload, context)
        select
          ${name},
          ${jsonbify(payload)},
          ${jsonbify(context)}
        from query
        returning *
      )
      select
        q.*,
        i.id as outbox_event_id,
        i.name as outbox_event_name,
        i.payload as outbox_event_payload,
        i.context as outbox_event_context
      from (select *, row_number() over () as _rn from query) q
      join (select *, row_number() over () as _rn from insertion) i on q._rn = i._rn
    `;
    const result = await exec(cteSql);
    const camelCaseOutboxFields = (row: Record<string, unknown>) => {
      const { outbox_event_id, outbox_event_name, outbox_event_payload, outbox_event_context } =
        row;
      return {
        outboxEventId: outbox_event_id,
        outboxEventName: outbox_event_name,
        outboxEventPayload: outbox_event_payload,
        outboxEventContext: outbox_event_context,
      };
    };

    // Build all consumer messages
    const allMessages = result.rows.flatMap((row) => {
      const r = row as Record<string, unknown>;
      const eventId = Number(r.outbox_event_id);
      const eventPayload = r.outbox_event_payload as Record<string, unknown>;
      const eventContext = (r.outbox_event_context ?? {}) as Record<string, unknown>;

      const consumersForPath = Object.values(consumers[`eventName:${name}`] || {});
      const filteredConsumers = consumersForPath.filter((c) => c.when({ payload: eventPayload }));

      logger.info(
        `[outbox] CTE Path: ${name}. Consumers: ${consumersForPath.length}. Filtered: ${filteredConsumers.map((c) => c.name).join(",")}`,
      );

      return filteredConsumers.map((consumer) => {
        const delay = consumer.delay({ payload: eventPayload });
        return {
          delay,
          msg: {
            consumer_name: consumer.name,
            status: "pending",
            event_name: name,
            event_id: eventId,
            event_payload: eventPayload,
            event_context: eventContext,
            processing_results: [],
            environment: process.env.APP_STAGE || process.env.NODE_ENV || "unknown",
          } satisfies ConsumerEvent,
        };
      });
    });

    const allDelays = allMessages.map((m) => m.delay);

    // Send all messages using pgmq.send_batch, one call per delay group
    await Promise.all(
      [...groupBy(allMessages, (m) => m.delay)].map(([delay, messages]) => {
        const pgMessages = sql.join(
          messages.map((m) => sql`${JSON.stringify(m.msg)}::jsonb`),
          sql`, `,
        );
        return exec(sql`
          select * from pgmq.send_batch(
            queue_name => ${queueName}::text,
            msgs => array[${pgMessages}]::jsonb[],
            delay => ${periodSeconds(delay)}::integer
          )
        `);
      }),
    );

    let mapped: unknown[];
    if (Array.isArray(query)) {
      mapped = result.rows.map((row) => {
        const r = row as Record<string, unknown>;
        const { value, ...rest } = r;
        return { ...(value as {}), ...camelCaseOutboxFields(rest) };
      });
    } else {
      const config = (query as { config?: { returningFields?: {}; fields: {} } }).config;
      const columns = drizzleUtils.orderSelectedFields!(config!.returningFields || config!.fields);
      mapped = result.rows.map((row: any) => ({
        ...drizzleUtils.mapResultRow!(columns, Object.values(row)),
        ...camelCaseOutboxFields(row),
      }));
    }

    return Object.assign(mapped, { delays: allDelays }) as never;
  };

  return {
    $types: { db: {} as DBLike },
    consumers,
    enqueue,
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
  {
    waitUntil = defaultWaitUntil,
    getDb,
  }: { waitUntil?: WaitUntilFn; getDb: () => Promise<DBLike> },
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
    // TODO: add a batch send API here, and batch pgmq job enqueueing in `enqueue`,
    // so fanout consumers don't need to insert one event/job at a time.
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

    for (const delay of new Set(addResult.delays)) {
      let delayMs = periodSeconds(delay) * 1000;
      delayMs = Math.max(20, delayMs * 1.1); // add 10% buffer to avoid race conditions, add 20ms minimum to let transactions complete
      if (delayMs > 120_000) continue; // don't bother with super long delays
      waitUntil(
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return queuer.processQueue(parent as DBConnection);
        })(),
      );
    }

    return result;
  }

  /**
   * Send an event using a CTE query. The outbox event is inserted in a single query with the passed-in query.
   * Valid queries you can use are:
   * - insert with returning e.g. `db.insert(schema.myTable).values({...}).returning()`
   * - update with returning e.g. `db.update(schema.myTable).set({...}).where(eq(schema.myTable.id, 1)).returning()`
   * - simple select queries e.g. `db.select().from(schema.myTable).limit(1)`
   *
   * NOTE: one outbox event is created for each row in the result set. This means:
   * - if you return a single row, you'll get one outbox event
   * - if your query returns zero rows (e.g. you use on conflict do nothing, or your where clause excludes all rows), you'll get no outbox events
   * - if your query returns multiple rows, you'll get one outbox event for each row
   */
  const sendCTE = async <Name extends EventName, T>(
    params: CTEParams<T, Name, SQLEquivalent<EventTypes[Name]>>,
  ) => {
    const connection = params.connection || (await getDb());
    const addResult = await queuer.enqueueCTE(connection, {
      query: params.query,
      name: params.name,
      payload: params.payload as never,
    });

    for (const delay of new Set(addResult.delays)) {
      let delayMs = periodSeconds(delay) * 1000;
      delayMs = Math.max(20, delayMs * 1.1);
      if (delayMs > 120_000) continue;
      waitUntil(
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return queuer.processQueue((await getDb()) as DBConnection);
        })(),
      );
    }

    return addResult;
  };

  return {
    registerConsumer,
    send,
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
