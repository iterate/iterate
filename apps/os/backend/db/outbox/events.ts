import { sql } from "drizzle-orm";
import { initTRPC, AnyTRPCRouter, AnyTRPCProcedure } from "@trpc/server";
import { z } from "zod";
import type { DB } from "../client.ts";
import { logger } from "../../tag-logger.ts";

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

export type WhenFn<Payload> = (params: { payload: Payload }) => boolean | null | undefined | "";
export type DelayFn<Payload> = (params: { payload: Payload }) => number;

export type DBLike = Pick<DB, "execute">;

type RetryFn = (
  job: ConsumerJobQueueMessage,
) =>
  | { retry: false; reason: string; delay?: never }
  | { retry: true; reason: string; delay: number };

export type ConsumersForEvent = Record<
  `consumerName:${string}`,
  {
    /** consumer name */
    name: string;
    when: WhenFn<{ input: unknown; output: unknown }>;
    /** delay before processing in seconds. if not specified, will process immediately */
    delay: DelayFn<{ input: unknown; output: unknown }>;
    retry: RetryFn;
    /** handler function */
    handler: (params: {
      eventName: string;
      eventId: number;
      payload: { input: unknown; output: unknown };
      job: { id: number | string; attempt: number };
    }) => Promise<void | string>;
  }
>;

export type ConsumersRecord = Record<`eventName:${string}`, ConsumersForEvent>;

export type QueuePeekOptions = { limit?: number; offset?: number; minReadCount?: number };

export interface Queuer<DBConnection> {
  $types: {
    db: DBConnection;
  };
  addToQueue: (
    db: DBConnection,
    params: { name: string; payload: { input: unknown; output: unknown } },
  ) => Promise<{ eventId: string; matchedConsumers: number }>;

  consumers: ConsumersRecord;

  /** Process some or all messages in the queue. Call this periodically or when you've just added events. */
  processQueue: (db: DBConnection) => Promise<string>;
  peekQueue: (db: DBConnection, options?: QueuePeekOptions) => Promise<ConsumerJobQueueMessage[]>;
  peekArchive: (db: DBConnection, options?: QueuePeekOptions) => Promise<ConsumerJobQueueMessage[]>;
  // todo: allow requeueing of messages by moving from archive to main queue directly
  // requeue: (db: DBConnection, msgIds: number[]) => Promise<void>;
}

export const createPgmqQueuer = (queueOptions: { queueName: string }): Queuer<DBLike> => {
  const { queueName } = queueOptions;
  const pgmqQueueTableName = `q_${queueName}`;
  const pgmqArchiveTableName = `a_${queueName}`;
  const processQueue: Queuer<DBLike>["processQueue"] = async (db) => {
    const jobQueueMessages = await db.execute<{}>(
      sql`
        select * from pgmq.read(
          queue_name => ${queueName}::text,
          vt         => 30,
          qty        => 2
        )
      `,
    );
    if (jobQueueMessages.length) logger.info(`processing ${jobQueueMessages.length} messages`);
    const results: Array<string | void> = [];
    for (const _job of jobQueueMessages) {
      const parsed = ConsumerJobQueueMessage.safeParse(_job);
      if (!parsed.success) {
        const err = z.prettifyError(parsed.error);
        logger.warn(`invalid message: ${err}`, { job: _job });
        continue;
      }
      const job = parsed.data;
      const matchingConsumer =
        consumers[`eventName:${job.message.event_name}`]?.[
          `consumerName:${job.message.consumer_name}`
        ];
      if (!matchingConsumer) {
        logger.warn(
          `no consumer found for ${JSON.stringify(job, null, 2)}. It may have been deleted? Consumers: ${JSON.stringify(consumers, null, 2)}`,
        );
        continue;
      }
      const consumer = matchingConsumer;
      await logger.run([`msg_id=${job.msg_id}`, `consumer=${consumer.name}`], async () => {
        try {
          logger.info(`START`);
          const result = await consumer.handler({
            eventId: job.message.event_id,
            eventName: job.message.event_name,
            payload: job.message.event_payload as { input: unknown; output: unknown },
            job: { id: job.msg_id, attempt: job.read_ct },
          });
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
          logger.info(`DONE. Result: ${result}`);
        } catch (e) {
          const retry = consumer.retry(job);
          const retryMessage = Object.entries(retry)
            .map(([k, v]) => `${k}: ${v}`)
            .join(". ");
          logger.error(`FAILED. ${retryMessage}`, e);

          const statusObj = JSON.stringify({ status: retry.retry ? "retrying" : "failed" });

          // bit of a hack - put stringified error into processing_errors array as a hint for debugging
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
              `giving up on ${job.msg_id} after ${job.read_ct} attempts. Archiving - note that "DLQ" is just archive + status=failed`,
            );
            const [archived] = await db.execute(sql`
              select * from pgmq.archive(queue_name => ${queueName}::text, msg_id => ${job.msg_id}::bigint)
            `);
            if (!archived) throw new Error(`Failed to archive message ${job.msg_id}`);
          } else {
            logger.info(`Setting to visible in ${retry.delay} seconds`);
            // useful reference https://github.com/Muhammad-Magdi/pgmq-js/blob/8b041fe7f3cd30aff1c71d00dd88abebfeb31ce7/src/msg-manager/index.ts#L68
            await db.execute(sql`
              select pgmq.set_vt(
                queue_name => ${queueName}::text,
                msg_id => ${job.msg_id}::bigint,
                vt => ${retry.delay}::integer
              )
            `);
          }
        }
      });
    }

    return `${jobQueueMessages.length} messages processed:\n\n${results.join("\n")}`.replace(
      /:\n\n$/,
      "",
    );
  };

  const consumers: Queuer<DBLike>["consumers"] = {};

  const addToQueue: Queuer<DBLike>["addToQueue"] = async (db, params) => {
    logger.info(`adding to pgmq:${params.name}`);
    const [_eventInsertion] = await db.execute(sql`
      insert into outbox_event (name, payload)
      values (${params.name}, ${JSON.stringify(params.payload)})
      returning id
    `);
    const eventInsertion = InsertedEvent.parse(_eventInsertion);

    const consumersForPath = Object.values(consumers[`eventName:${params.name}`] || {});
    const filteredConsumers = consumersForPath.filter((c) => c.when({ payload: params.payload }));

    logger.info(
      `Path: ${params.name}. Consumers: ${consumersForPath.length}. Filtered: ${filteredConsumers.map((c) => c.name).join(",")}`,
    );

    for (const consumer of filteredConsumers) {
      await db.execute(sql`
        select from pgmq.send(
          queue_name  => ${queueName}::text,
          msg         => ${JSON.stringify({
            consumer_name: consumer.name,
            status: "pending",
            event_name: params.name,
            event_id: Number(eventInsertion.id satisfies string), // todo: make drizzle return a number? according to https://orm.drizzle.team/docs/column-types/pg#bigserial that's fine?
            event_payload: params.payload,
            event_context: {},
            processing_results: [],
            environment: process.env.APP_STAGE || process.env.NODE_ENV || "unknown",
          } satisfies ConsumerEvent)}::jsonb,
          delay => ${consumer.delay({ payload: params.payload })}::integer
        )
      `);
    }
    return { eventId: eventInsertion.id, matchedConsumers: filteredConsumers.length };
  };

  return {
    $types: { db: {} as DBLike },
    consumers,
    addToQueue,
    processQueue: (db) => logger.run("processQueue", () => processQueue(db)),
    peekQueue: async (db, options = {}) => {
      // just a basic query, go to drizzle studio to filter based on read count, visibility time, event name, consumer name, etc.
      const rows = await db.execute(sql`
        select * from pgmq.${sql.identifier(pgmqQueueTableName)}
        where read_ct >= ${options.minReadCount || 0}
        order by enqueued_at desc
        limit ${options.limit || 10}
        offset ${options.offset || 0}
      `);
      return ConsumerJobQueueMessage.array().parse(rows);
    },
    peekArchive: async (db, options = {}) => {
      const rows = await db.execute(sql`
        select * from pgmq.${sql.identifier(pgmqArchiveTableName)}
        where read_ct >= ${options.minReadCount || 0}
        order by archived_at desc
        limit ${options.limit || 10}
        offset ${options.offset || 0}
      `);
      return ConsumerJobQueueMessage.array().parse(rows);
    },
  };
};

export type ConsumerPluginCtx = {
  calls?: Record<string, string[]>;
};

/**
 example usage:

```ts
const t = initTRPC.context<MyContext>().create();

const queuer = createPgmqQueuer({ queueName: "consumer_job_queue" });

// `concat`-ing the plugin just injects a `sendToOutbox` helper function into the context, which is used to send events to the outbox
// note that you should always use this helper function on the return value of the procedure, otherwise you won't be able to subscribe to the event
const publicProcedure = t.procedure.concat(
  createPostProcedureConsumerPlugin(queuer, {
    waitUntil: cloudflareWorkers.waitUntil, // can use `import {waitUntil} from 'cloudflare:workers'` or `import {after} from 'next/server'` or whatever
  }),
);

const appRouter = t.router({
  users: {
    createUser: publicProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input, ctx }) => {
      return ctx.db.transaction(async tx => {
        const [user] = await tx
          .insert(schema.user)
          .values({ name: input.name })
          .returning();

        return ctx.sendToOutbox(tx, { user });
      });
    }),
  }
})

const consumer = createTrpcConsumer<typeof appRouter, typeof queuer.$types.db>(queuer);

consumer.registerConsumer({
name: "sendWelcomeEmail",
on: "users.createUser",
handler: async ({ eventName, eventId, payload, job }) => {
    await myEmailService.sendEmail({
      to: payload.input.user.email,
      subject: "Welcome to our app",
      body: "We think you will like it here",
    });
},
});
```
 */
export const createPostProcedureConsumerPlugin = <DBConnection>(
  queuer: Queuer<DBConnection>,
  {
    /** A function that instructs the runtime/platform to not die until the promise is completed. e.g. `waitUntil` from `cloudflare:workers` or `after` from 'next/server' */
    waitUntil = (promise: Promise<unknown>): undefined | void => void promise,
  } = {},
) => {
  const pluginTrpc = initTRPC.context<{ db: DBConnection }>().create();

  return (
    // note that this is just a cast: it's purely for type inference. It ensures that that at compile-time, you can only define consumers
    // for event-ready procedures. At runtime, we rely on the context instead.
    pluginTrpc.procedure.use(async ({ getRawInput, next, ctx: _ctx, path }) => {
      return next({
        ctx: {
          sendToOutbox: async <T extends {}>(db: DBConnection, output: T) => {
            const input = await getRawInput();
            const payload = { input, output };
            return logger.run({ consumerPlugin: "true", path }, async () => {
              const queueResult = await queuer.addToQueue(db, { name: `trpc:${path}`, payload });

              if (queueResult.matchedConsumers > 0) {
                waitUntil(
                  logger.run({ queuedEventId: queueResult.eventId }, async () => {
                    // technically we're still inside the transaction here, but it _should_ be the last thing that's done in it
                    // so wait a few milliseconds to decrease the likelihood of the event not being visible to the parent connection yet
                    // if it is missed, we need to rely on the queue processor cron job so not that big of a deal
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    return queuer.processQueue(_ctx.db);
                  }),
                );
              }

              return output as T & { $enqueued: true };
            });
          },
        },
      });
    })
  );
};

export const defaultRetryFn: RetryFn = (job) => {
  if (job.read_ct > 5) {
    return { retry: false, reason: "max retries reached" };
  }
  const delay = Math.ceil((2 ** Math.max(0, job.read_ct - 1)) * (0.9 + Math.random() * 0.2)); // add/subtract a random jitter of up to 10%
  return {
    retry: true,
    reason: `attempt ${job.read_ct} setting to visible in ${delay} seconds`,
    delay,
  };
};

/** Extract the procedures from a trpc router def (pass in typeof appRouter._def.procedures) */
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

/** A union all the procedures in a router def (pass in typeof appRouter._def.procedures). Useful for extrac the path types */
type ProcUnion<P, Prefix extends string = ""> = {
  [K in keyof P]: P[K] extends AnyTRPCProcedure
    ? {
        path: `${Prefix}${Extract<K, string>}`;
        proc: P[K];
      }
    : ProcUnion<P[K], `${Prefix}${Extract<K, string>}.`>;
}[keyof P];

export const createTrpcConsumer = <R extends AnyTRPCRouter, DBConnection>(
  queuer: Queuer<DBConnection>,
) => {
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

  const registerConsumer = <P extends EventableProcedureName>(options: {
    name: string;
    on: `trpc:${P}`;
    when?: WhenFn<ProcedureTypes<P>>;
    delay?: DelayFn<ProcedureTypes<P>>;
    retry?: RetryFn;
    handler: (params: {
      eventName: `trpc:${P}`;
      eventId: number;
      payload: ProcedureTypes<P>;
      job: { id: string | number; attempt: number };
    }) => void | string | Promise<void | string>;
  }) => {
    queuer.consumers[`eventName:${options.on}`] ||= {};

    // for some reason without the explicit type annotation you get "Type 'ConsumersRecord[`eventName:${P}`]' is generic and can only be indexed for reading"
    const consumersForEvent: ConsumersForEvent = queuer.consumers[`eventName:${options.on}`];
    consumersForEvent[`consumerName:${options.name}`] = {
      name: options.name,
      when: (options.when as WhenFn<{ input: unknown; output: unknown }>) ?? (() => true),
      delay: (options.delay as DelayFn<{ input: unknown; output: unknown }>) ?? (() => 0),
      retry: options.retry ?? defaultRetryFn,
      handler: async (params) => {
        return logger.run({ consumer: options.name, eventId: String(params.eventId) }, async () => {
          return options.handler({
            eventName: options.on,
            eventId: params.eventId,
            job: params.job,
            payload: params.payload as ProcedureTypes<P>,
          });
        });
      },
    };
  };

  return {
    /** compile-time only helper types */
    $types: {
      /** flattened object shape of all procedures in the router */
      FlatProcedures: {} as FlatProcedures,
      /** record whose keys are the names of all "eventable" procedures in the router (procedure paths which can be subscribed to by consumers) */
      EventableProcedureName: {} as Record<EventableProcedureName, true>,
    },
    registerConsumer,
    queuer,
  };
};
