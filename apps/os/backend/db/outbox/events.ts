import { randomUUID } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { initTRPC, AnyTRPCRouter, AnyTRPCProcedure } from "@trpc/server";
import { pEvent } from "p-suite/p-event";
import pQueue from "p-suite/p-queue";
import { z } from "zod";
import type { DB } from "../client.ts";
import { logger } from "../../tag-logger.ts";

type ProceduresDef = AnyTRPCRouter["_def"]["procedures"];
type FlatProcedures<P extends ProceduresDef, Prefix extends string = ""> =
  ProcUnion<P, Prefix> extends infer U
    ? {
        // @ts-expect-error ts doesn't know this is ok
        [K in U["path"]]: Extract<U, { path: K }>["proc"];
      }
    : never;

type ProcUnion<P extends ProceduresDef, Prefix extends string = ""> = {
  [K in keyof P]: P[K] extends AnyTRPCProcedure
    ? {
        path: `${Prefix}${Extract<K, string>}`;
        proc: P[K];
      }
    : ProcUnion<P[K], `${Prefix}${Extract<K, string>}.`>;
}[keyof P];

export const createMemoryQueuer = (): Queuer => {
  // simple p-queue implementation - need to think about how to swap in a real queue like redis or whatever
  const q = new pQueue({ concurrency: 10 });

  const consumers = {} as Queuer["consumers"];

  return {
    addToQueue: async (params) => {
      const eventId = randomUUID();
      for (const { when, delay, handler } of consumers[params.path]) {
        if (!when({ payload: params.output })) continue;
        // just enqueue the handler NOW - in a real queueing system we'd persist the outupt - not sure about context though. def need to consider removing ctx or insisting it's serializable
        await q.add(async () => {
          const delaySeconds = delay ? delay({ payload: params.output }) : 0;
          if (delaySeconds)
            await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
          await handler({
            path: params.path,
            payload: params.output,
            eventId,
            idempotencySuffix: "",
          });
        });
      }
      return eventId;
    },
    consumers,
    processQueue: async () => {
      // should be processed automatically - just wait for it to be done
      const { size } = q;
      if (size > 0) await pEvent(q, "empty");
      return `${size} messages processed`;
    },
    purgeQueue: async () => q.clear(),
  };
};

export const ConsumerEvent = z.object({
  path: z.string(),
  consumer_name: z.string(),
  event_id: z.string(),
  event_payload: z.object({}).passthrough(),
  event_context: z.unknown(),
  processing_results: z.array(z.unknown()),
  environment: z.string(),
});

export type ConsumerEvent = z.infer<typeof ConsumerEvent>;

const ConsumerJobQueueMessage = z.object({
  msg_id: z.number(),
  vt: z.instanceof(Date), // visibility timeout datetime
  read_ct: z.number(),
  message: z.object({
    path: z.string(),
    event_id: z.string(),
    consumer_name: z.string(),
    event_context: z.unknown(),
    event_payload: z.object({}).passthrough(),
  }),
});

export const createPgmqQueuer = (client: DB): Queuer => {
  const processQueue: Queuer["processQueue"] = async () => {
    const messages = await client.execute<z.infer<typeof ConsumerJobQueueMessage>>(
      sql<z.infer<typeof ConsumerJobQueueMessage>>`
        select * from pgmq.read(
          queue_name => 'consumer_job_queue',
          vt         => 30,
          qty        => 2
        )
      `,
    );
    if (messages.length) logger.info(`processing ${messages.length} messages`);
    const results: Array<string | void> = [];
    for (const job of messages) {
      const matchingConsumers = consumers[job.message.path]?.filter(
        (c) => c.name === job.message.consumer_name,
      );
      if (!matchingConsumers?.length) {
        logger.warn(
          `no consumer found for ${JSON.stringify(job, null, 2)}. It may have been deleted? Consumers: ${JSON.stringify(consumers, null, 2)}`,
        );
        continue;
      }
      if (matchingConsumers.length > 1) {
        // maybe this should be a warning too? I think we really shouldn't have multiple consumers with the same name
        throw new Error(`Multiple consumers found for ${JSON.stringify(job)}`, {
          cause: matchingConsumers,
        });
      }
      const consumer = matchingConsumers[0];
      await logger.run([`msg_id=${job.msg_id}`, `consumer=${consumer.name}`], async () => {
        try {
          logger.info(`START`);
          const result = await consumer.handler({
            eventId: job.message.event_id,
            path: job.message.path,
            payload: job.message.event_payload,
            idempotencySuffix: `msg_id_${job.msg_id}`,
          });
          results.push(result);
          await client.execute(sql`
            update pgmq.q_consumer_job_queue
            set message = jsonb_set(
              message,
              '{processing_results}',
              message->'processing_results' || jsonb_build_array(${`success: ${String(result)}`})
            )
          `);
          await client.execute(sql`
            --typegen-ignore
            select pgmq.archive(queue_name => 'consumer_job_queue', msg_id => ${job.msg_id})
          `);
          logger.info(`DONE. Result: ${result!}`);
        } catch (e) {
          logger.error(`FAILED`, e);
          // bit of a hack - put stringified error into processing_errors array as a hint for debugging
          await client.execute(sql`
            update pgmq.q_consumer_job_queue
            set message = jsonb_set(
              message,
              '{processing_results}',
              message->'processing_results' || jsonb_build_array(${`error: ${String(e)}`})
            )
          `);
          if (job.read_ct > 5) {
            logger.warn(
              `giving up on ${job.msg_id} after ${job.read_ct} attempts. Archiving - note that "DLQ" is just archive + read_ct>5`,
            );
            const [archived] = await client.execute(sql`
              select * from pgmq.archive(queue_name => 'consumer_job_queue', msg_id => ${job.msg_id})
            `);
            if (!archived) throw new Error(`Failed to archive message ${job.msg_id}`);
          } else {
            const vt = 2 ** Math.max(0, job.read_ct - 1);
            logger.info(`setting to visible in ${vt} seconds`);
            // useful reference https://github.com/Muhammad-Magdi/pgmq-js/blob/8b041fe7f3cd30aff1c71d00dd88abebfeb31ce7/src/msg-manager/index.ts#L68
            await client.execute(sql`
              --typegen-ignore
              select pgmq.set_vt(queue_name => 'consumer_job_queue', msg_id => ${job.msg_id}, vt => ${vt})
            `);
          }
        }
      });
    }

    return `${messages.length} messages processed:\n\n${results.join("\n")}`.replace(/:\n\n$/, "");
  };

  const consumers: Queuer["consumers"] = {};

  const addToQueue: Queuer["addToQueue"] = async (params) => {
    logger.info(`adding to pgmq:${params.path}`);
    const [eventInsertion] = await client.execute(sql`
      insert into procedure_events (path, output)
      values (${params.path}, ${JSON.stringify(params.output)})
      returning id
    `);
    const consumersForPath = consumers[params.path] || [];
    const filteredConsumers = consumersForPath.filter((c) => c.when({ payload: params.output }));

    logger.info(
      `Path: ${params.path}. Consumers: ${consumersForPath.length}. Filtered: ${filteredConsumers.map((c) => c.name).join(",")}`,
    );

    for (const consumer of filteredConsumers) {
      await client.execute(sql`
        --typegen-ignore
        select from pgmq.send(
          queue_name  => 'consumer_job_queue',
          msg         => ${JSON.stringify({
            path: params.path,
            consumer_name: consumer.name,
            event_id: eventInsertion.id,
            event_payload: params.output,
            event_context: {},
            processing_results: [],
            environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
          } satisfies ConsumerEvent)},
          delay => ${consumer.delay({ payload: params.output })}
        )
      `);
    }
    if (filteredConsumers.length) {
      // disable this for now - it's useful but want to control the queue a bit manually at first
      after(logger.run(["processQueue", "afterAdding"], processQueue));
      // await processQueue() // we added stuff, let's process the queue now
    }
    return eventInsertion.id;
  };

  const purgeQueue: Queuer["purgeQueue"] = async () => {
    await client.execute(sql`
      --typegen-ignore
      select pgmq.drop_queue('consumer_job_queue');
      select pgmq.create('consumer_job_queue');
    `);
  };

  return {
    consumers,
    addToQueue,
    processQueue: () => logger.run("processQueue", processQueue),
    purgeQueue,
  };
};

export type WhenFn<Payload> = (params: { payload: Payload }) => boolean | null | undefined | "";
export type DelayFn<Payload> = (params: { payload: Payload }) => number;

export interface Queuer {
  addToQueue: (params: { path: string; output: {}; ctx: {} }) => Promise<string>;

  // addHandler: (params: {path: string; eventId: string; handler: Function}) => Promise<void>
  // _handlers: Record<string, readonly Function[]>
  consumers: Record<
    string /* procedure path */,
    Array<{
      when: WhenFn<unknown>;
      /** consumer name */
      name: string;
      /** delay before processing in seconds. if not specified, will process immediately */
      delay: DelayFn<unknown>;
      /** handler function */
      handler: (params: {
        path: string;
        eventId: string;
        payload: {};
        idempotencySuffix: string;
      }) => Promise<void | string>;
    }>
  >;

  /** Process some or all messages in the queue. Call this periodically. */
  processQueue: () => Promise<string>;
  purgeQueue: () => Promise<void>;
}

export type ConsumerPluginCtx = {
  calls?: Record<string, string[]>;
};

export const createPostProcedureConsumerPlugin = (queuer: Queuer) => {
  const pluginTrpc = initTRPC.create();

  const _eventableProcedure = pluginTrpc.procedure.input(z.object({ eventable: z.literal(true) }));

  return (
    // note that this is just a cast: it's purely for type inference. It ensures that that at compile-time, you can only define consumers
    // for event-ready procedures. At runtime, we rely on the context instead.
    (pluginTrpc.procedure as {} as typeof _eventableProcedure)
      // .output(value => value as {noop: boolean}) // would be nice if trpc let me say "any procedure using this plugin must return something extending {noop: boolean}"
      .use(async ({ next, ctx: _ctx, path }) => {
        logger.setTag("consumerPlugin");
        const ctx = _ctx as typeof _ctx & ConsumerPluginCtx;
        if (ctx.calls?.[path]?.length) {
          throw new Error(`Path ${path} has been called: ${JSON.stringify(ctx.calls[path])}`);
        }
        const result = await next();
        if (result.ok) {
          const noop = (result.data as undefined | { noop?: boolean })?.noop;
          if (noop) return result; // short-cut/convention: don't add to queue if noop? not sure about this.

          logger.info(`adding to queue: ${path}`, { output: result.data });
          await queuer.addToQueue({ path, output: result.data as {}, ctx });
        }
        return result;
      })
  );
};

export const createConsumerClient = <R extends AnyTRPCRouter>(router: R, queuer: Queuer) => {
  type _FlatProcedures = FlatProcedures<R["_def"]["procedures"]>;
  type ProcedureTypes<P extends keyof _FlatProcedures> = _FlatProcedures[P] extends {
    _def: { $types: { input: infer I; output: infer O } };
  }
    ? { input: I; output: O }
    : never;

  type EventableProcedureName = {
    [K in keyof _FlatProcedures]: ProcedureTypes<K>["input"] extends { eventable?: true }
      ? Extract<K, string>
      : never;
  }[keyof _FlatProcedures];

  type OutputOf<P extends EventableProcedureName> = ProcedureTypes<P>["output"];

  const defineConsumer = <P extends EventableProcedureName>(
    name: string,
    trigger: {
      on: P;
      when?: WhenFn<OutputOf<P>>;
      delay?: DelayFn<OutputOf<P>>;
    },
    handler: (params: {
      path: P;
      eventId: string;
      payload: OutputOf<P>;
      idempotencySuffix: string;
    }) => void | string | Promise<void | string>,
  ) => {
    // const pathHandlers = (queuer.handlers[trigger.on as string] ??= [])
    const pathConsumers = (queuer.consumers[trigger.on] ??= []);
    pathConsumers.push({
      name,
      when: trigger.when ?? (() => true),
      delay: trigger.delay ?? (() => 0),
      handler: async (params) => {
        logger.setTag(`consumer=${name}`, `eventId=${params.eventId}`);
        return handler({
          path: trigger.on,
          eventId: params.eventId,
          payload: params.payload as never,
          idempotencySuffix: params.idempotencySuffix,
        });
      },
    });
  };

  return {
    $types: {
      _FlatProcedures: {} as _FlatProcedures,
      EventableProcedureName: {} as Record<EventableProcedureName, true>,
    },
    defineConsumer,
    queuer,
  };
};
