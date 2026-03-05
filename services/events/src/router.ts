import {
  eventBusContract,
  serviceManifest,
  type EventsServiceEnv,
} from "@iterate-com/events/contract";
import {
  createServiceSubRouterHandlers,
  type ServiceRequestLogger,
} from "@iterate-com/shared/jonasland";
import { implement } from "@orpc/server";
import {
  disposeEventOperations,
  getEventOperations,
  type EventOperations,
} from "../effect-stream-manager/singleton.ts";
import { executeEventsSql } from "./db.ts";

export interface EventsContext {
  requestId: string;
  serviceName: string;
  log: ServiceRequestLogger;
}

const os = implement(eventBusContract).$context<EventsContext>();
const runtimeEnv: EventsServiceEnv = serviceManifest.envVars.parse(process.env);
const serviceSubRouter = createServiceSubRouterHandlers(os, {
  manifest: serviceManifest,
  executeSql: executeEventsSql,
  logPrefix: "events.service",
}) as {
  health: ReturnType<typeof os.service.health.handler>;
  sql: ReturnType<typeof os.service.sql.handler>;
  debug: ReturnType<typeof os.service.debug.handler>;
};

let operationsPromise: Promise<EventOperations> | undefined;

async function getOps(): Promise<EventOperations> {
  operationsPromise ??= getEventOperations(runtimeEnv);
  return await operationsPromise;
}

export const eventsRouter = os.router({
  service: serviceSubRouter,
  append: os.append.handler(async ({ input }) => {
    const ops = await getOps();
    await ops.appendEvents(input);
  }),

  registerSubscription: os.registerSubscription.handler(async ({ input }) => {
    const ops = await getOps();
    await ops.appendSubscriptionRegistration(input);
  }),

  ackOffset: os.ackOffset.handler(async ({ input }) => {
    const ops = await getOps();
    await ops.acknowledgeOffset(input);
  }),

  stream: os.stream.handler(async function* ({ input, signal }) {
    const ops = await getOps();
    yield* ops.streamEvents(input, signal);
  }),

  firehose: os.firehose.handler(async function* ({ signal }) {
    const ops = await getOps();
    yield* ops.firehoseEvents(signal);
  }),

  listStreams: os.listStreams.handler(async () => {
    const ops = await getOps();
    return await ops.listStreams();
  }),
});

export async function disposeEventsRouterOperations(): Promise<void> {
  await disposeEventOperations(runtimeEnv);
  operationsPromise = undefined;
}
