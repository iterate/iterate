import { ProjectSlug, StreamPath } from "@iterate-com/events-contract";
import { getAgentByName } from "agents";
import type { ChildStreamAutoSubscriber } from "~/durable-objects/child-stream-auto-subscriber.ts";
import { AUTO_SUBSCRIBER_INSTANCE } from "~/durable-objects/child-stream-auto-subscriber.ts";
import { buildStreamComposerUrl } from "~/lib/events-urls.ts";
import { os } from "~/orpc/orpc.ts";

type CloudflareEnv = import("~/lib/worker-env.d.ts").CloudflareEnv;

/**
 * Resolve a typed RPC stub for the singleton `ChildStreamAutoSubscriber` DO.
 *
 * The Agents SDK's base class throws on every method call until `.setName()`
 * has been invoked on the stub at least once (see partyserver's `getServerByName`).
 * `getAgentByName` does that for us, so always go through it rather than calling
 * `namespace.get(idFromName(...))` directly.
 *
 * The binding is declared without a class type parameter in `alchemy.run.ts`
 * to break a TS recursion cycle, so we cast here.
 */
async function getAutoSubscriberStub(
  env: CloudflareEnv,
): Promise<DurableObjectStub<ChildStreamAutoSubscriber>> {
  const namespace =
    env.CHILD_STREAM_AUTO_SUBSCRIBER as DurableObjectNamespace<ChildStreamAutoSubscriber>;
  return getAgentByName(namespace, AUTO_SUBSCRIBER_INSTANCE);
}

export const basePathDefaultsRouter = {
  configureBasePathDefaults: os.configureBasePathDefaults.handler(async ({ input, context }) => {
    const stub = await getAutoSubscriberStub(context.env);
    const result = await stub.setBasePathDefaults({
      basePath: input.basePath,
      events: input.events,
    });
    return { basePath: result.basePath, eventCount: result.eventCount };
  }),
  clearBasePathDefaults: os.clearBasePathDefaults.handler(async ({ input, context }) => {
    const stub = await getAutoSubscriberStub(context.env);
    const result = await stub.clearBasePathDefaults({ basePath: input.basePath });
    return { basePath: input.basePath, existed: result.existed };
  }),
  listBasePathDefaults: os.listBasePathDefaults.handler(async ({ context }) => {
    const stub = await getAutoSubscriberStub(context.env);
    const configs = await stub.listBasePathDefaults();
    return { configs };
  }),
  listAgents: os.listAgents.handler(async ({ input, context }) => {
    const stub = await getAutoSubscriberStub(context.env);
    const projectSlug = ProjectSlug.parse(context.config.eventsProjectSlug);
    const eventsBaseUrl = context.config.eventsBaseUrl;
    const records = await stub.listAgents({ prefix: input.prefix });
    // Build the viewer URL server-side so the client doesn't need to know
    // about events-host construction (project-slug subdomain rewriting etc.).
    const agents = records.map((record) => ({
      streamPath: record.streamPath,
      streamViewerUrl: buildStreamComposerUrl({
        eventsBaseUrl,
        projectSlug,
        streamPath: StreamPath.parse(record.streamPath),
      }),
      discoveredAt: record.discoveredAt,
    }));
    return { agents };
  }),
};
