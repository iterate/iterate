import { implement } from "@orpc/server";
import { registryContract } from "@iterate-com/registry-contract";
import type { RegistryContext } from "../context.ts";
import { getEventOperations } from "./singleton.ts";

const os = implement(registryContract).$context<RegistryContext>();

export const streamsRouter = {
  append: os.streams.append.handler(async ({ input, context }) => {
    const ops = await getEventOperations(context.env);
    await ops.appendEvents(input);
  }),

  registerSubscription: os.streams.registerSubscription.handler(async ({ input, context }) => {
    const ops = await getEventOperations(context.env);
    await ops.appendSubscriptionRegistration(input);
  }),

  ackOffset: os.streams.ackOffset.handler(async ({ input, context }) => {
    const ops = await getEventOperations(context.env);
    await ops.acknowledgeOffset(input);
  }),

  stream: os.streams.stream.handler(async function* ({ input, context, signal }) {
    const ops = await getEventOperations(context.env);
    yield* ops.streamEvents(input, signal);
  }),

  firehose: os.streams.firehose.handler(async function* ({ context, signal }) {
    const ops = await getEventOperations(context.env);
    yield* ops.firehoseEvents(signal);
  }),

  list: os.streams.list.handler(async ({ context }) => {
    const ops = await getEventOperations(context.env);
    return await ops.listStreams();
  }),
};
