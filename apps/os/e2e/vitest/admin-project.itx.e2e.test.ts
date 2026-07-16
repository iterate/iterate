/**
 * Deployment-targeted test for disposable admin projects driven through itx:
 * the admin handle creates a throwaway project and exercises project streams
 * (append/getEvents/subscribe) the same way the dashboard, REPL, and CLI reach
 * them on itx.
 */
import { test } from "vitest";
import type { RpcStub } from "capnweb";
import { createTestProject } from "../test-support/create-test-project.ts";
import { appendEvents } from "../test-support/append-events.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import {
  buildIntegrationRouterCreatedEvent,
  buildIntegrationRouterSubscriptionConfiguredEvent,
} from "../../src/domains/integrations/integration-router-events.ts";
import type { StreamEvent } from "../../src/domains/streams/schemas.ts";
import { appendedOffsets } from "../../src/domains/streams/rpc-types.ts";
import type { WakeableStreamProcessorRpc } from "../../src/itx-api.generated.ts";

test("creates a disposable project and uses project streams through itx", async ({ expect }) => {
  await using handle = await createTestProject({ slugPrefix: "admin-fixture" });
  using itx = handle.itx();

  // Project creation waits for every universally available sibling processor
  // to consume its birth batch. This assertion deliberately goes through the
  // public email capability: the email router shares the Project DO with the
  // project processor, so its relay must select the email processor's own
  // read facade rather than the host's default `processor` property.
  expect((await itx.email.processor.snapshot()).state).toMatchObject({
    birthCertificate: { config: {} },
    threads: {},
    threadByMessageId: {},
  });

  // Slack and Telegram routers have the same multi-processor hosting shape.
  // Build their public birth batches without connecting an external account,
  // then prove each connection handle reads its named router rather than the
  // Project processor sharing that Durable Object instance.
  for (const router of [
    {
      processorSlug: "slack",
      slug: "slack",
      state: { routes: {} },
      processor: (connection: string) => itx.integrations.slack.get(connection).processor,
    },
    {
      processorSlug: "telegram",
      slug: "telegram",
      state: { sentMessages: {}, sessionsByChat: {} },
      processor: (connection: string) => itx.integrations.telegram.get(connection).processor,
    },
  ] as const) {
    const connection = `e2e-${router.slug}-${crypto.randomUUID()}`;
    const committedOffsets = appendedOffsets(
      await itx.streams.get(`/integrations/${router.slug}/${connection}`).append(
        { return: "offsets" },
        buildIntegrationRouterCreatedEvent({ connection, slug: router.slug }),
        buildIntegrationRouterSubscriptionConfiguredEvent({
          connection,
          processorSlug: router.processorSlug,
          projectId: handle.project.id,
          slug: router.slug,
        }),
      ),
    );
    const processor = router.processor(
      connection,
    ) as unknown as RpcStub<WakeableStreamProcessorRpc>;
    await processor.waitUntilProcessed({
      offset: Math.max(...committedOffsets),
    });
    expect((await processor.snapshot()).state).toMatchObject({
      birthCertificate: { config: { connection } },
      ...router.state,
    });
  }

  const streamPath = `/e2e/admin-project/${crypto.randomUUID()}`;
  const eventType = "events.iterate.com/os/e2e-admin-stream-proof";
  const marker = crypto.randomUUID();
  const stream = itx.streams.get(streamPath);

  // The one subscription primitive replays history and tails live appends.
  const seen: StreamEvent[] = [];
  const subscription = await stream.subscribe({
    replayAfterOffset: 0,
    processEventBatch: (batch) => {
      seen.push(...batch.events);
    },
  });

  // append creates the stream on first write and can project committed events.
  const [appended] = await appendEvents(stream, {
    type: eventType,
    payload: { marker },
  });
  expect(appended).toMatchObject({
    offset: expect.any(Number),
    type: eventType,
    payload: { marker },
  });

  const events = await stream.getEvents({});
  expect(events.map((event) => event.type)).toContain(eventType);
  expect(events.find((event) => event.type === eventType)?.payload).toMatchObject({ marker });

  // waitForCondition, not expect.poll: expect.poll loses the test context on
  // vitest retry in the CI-parallel lane and turns any first-attempt flake
  // into a hard "expect.poll() must be called inside a test" failure. The
  // timeouts keep expect.poll's 1s default deadline.
  await waitForCondition(
    () => seen.some((event) => event.type === eventType && event.payload?.marker === marker),
    { description: "the subscription to deliver the appended event", timeoutMs: 1_000 },
  );

  subscription.unsubscribe();

  // The project processor folds the new stream into its reduced state.
  await waitForCondition(
    async () => {
      const snapshot = await itx.processor.snapshot();
      return snapshot.state.streams.some((item) => item.path === streamPath);
    },
    { description: "the project processor to fold the new stream into state", timeoutMs: 1_000 },
  );
});
