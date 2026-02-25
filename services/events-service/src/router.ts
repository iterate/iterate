import {
  eventBusContract,
  serviceManifest,
  type EventsServiceEnv,
} from "@iterate-com/events-contract";
import { implement } from "@orpc/server";
import {
  disposeEventOperations,
  getEventOperations,
  type EventOperations,
} from "../effect-stream-manager/singleton.ts";

export interface EventsContext {
  requestId: string;
  serviceName: string;
  log?: unknown;
}

const os = implement(eventBusContract).$context<EventsContext>();
const runtimeEnv: EventsServiceEnv = serviceManifest.envVars.parse(process.env);

let operationsPromise: Promise<EventOperations> | undefined;

async function getOps(): Promise<EventOperations> {
  operationsPromise ??= getEventOperations(runtimeEnv);
  return await operationsPromise;
}

export const eventsRouter = os.router({
  service: {
    health: os.service.health.handler(async ({ context }) => ({
      ok: true,
      service: context.serviceName,
      version: serviceManifest.version,
    })),
  },
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

  listStreams: os.listStreams.handler(async () => {
    const ops = await getOps();
    return await ops.listStreams();
  }),
});

export async function disposeEventsRouterOperations(): Promise<void> {
  await disposeEventOperations(runtimeEnv);
  operationsPromise = undefined;
}
