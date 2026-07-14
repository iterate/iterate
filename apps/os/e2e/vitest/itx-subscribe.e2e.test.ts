import { expect, test } from "vitest";
import type { StreamProcessorSnapshot } from "../../src/domains/streams/stream-processor.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import {
  PROJECT_WORKER_FORWARDED_EVENT_TYPE,
  ProjectWorkerForwardingProbeProcessor,
  type ProjectWorkerForwardingProbeState,
} from "./itx-test-support.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// These are hand written tests - they MUST pass
test("Project stream subscribe can observe project worker processEventBatch forwarding", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  const marker = crypto.randomUUID();
  const outputPath = `/worker-forwarding-output-${marker}`;
  const triggerPath = `/worker-forwarding-trigger-${marker}`;

  using project = itx.projects.create({ slug: `worker-forwarding-${marker}` });

  await project.repo.commitFiles({
    changes: [
      {
        path: "worker.ts",
        content: `
            import { WorkerEntrypoint } from "cloudflare:workers";

            const OUTPUT_PATH = ${JSON.stringify(outputPath)};
            const TRIGGER_PATH = ${JSON.stringify(triggerPath)};
            const MARKER = ${JSON.stringify(marker)};
            const FORWARDED_EVENT_TYPE = ${JSON.stringify(PROJECT_WORKER_FORWARDED_EVENT_TYPE)};

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch(req) {
                return new Response(\`forwarding test worker fetched \${new URL(req.url).pathname}\`);
              }

              async processEventBatch(batch) {
                for (const event of batch.events) await this.processEvent(event);
              }

              async processEvent(event) {
                if (event.path !== "/") return;
                if (event.type !== "events.iterate.com/stream/child-stream-created") return;
                if (event.payload.childPath !== TRIGGER_PATH) return;

                const project = await this.env.ITX.get();
                await project.streams.get(OUTPUT_PATH).append({
                  type: FORWARDED_EVENT_TYPE,
                  payload: {
                    childPath: event.payload.childPath,
                    marker: MARKER,
                    originalType: event.type,
                  },
                });
              }
            }
          `,
      },
    ],
    message: "Add forwarding test worker",
  });

  const outputStream = project.streams.get(outputPath);
  let storedSnapshot: StreamProcessorSnapshot<ProjectWorkerForwardingProbeState> | undefined;
  const processor = new ProjectWorkerForwardingProbeProcessor({
    readState: () => storedSnapshot,
    stream: outputStream as never,
    path: outputPath,
    projectId: null,
    writeState: (snapshot) => {
      storedSnapshot = snapshot;
    },
  });

  const initial = await processor.snapshot();
  using subscription = await outputStream.subscribe({
    eventTypes: [PROJECT_WORKER_FORWARDED_EVENT_TYPE],
    processEventBatch: (batch) => processor.ingest(batch),
    replayAfterOffset: initial.offset,
    subscriber: {
      description: "minimal-itx-v4 e2e local project worker forwarding probe",
    },
  });

  await project.streams.get(triggerPath).append({
    type: "events.iterate.test/project-worker-forwarding-trigger",
    payload: { marker },
  });

  await processor.waitUntilEvent({
    predicate: (event) =>
      event.type === PROJECT_WORKER_FORWARDED_EVENT_TYPE && event.payload?.marker === marker,
    timeoutMs: 8_000,
  });
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exhaustive equality: state must be exactly these keys, and the receiver is a live processor instance, not a data object
  expect(processor.state).toEqual({
    childPaths: [triggerPath],
    markers: [marker],
  });
  expect(storedSnapshot).toEqual({
    offset: expect.any(Number),
    state: {
      childPaths: [triggerPath],
      markers: [marker],
    },
  });

  await subscription.unsubscribe();
  const stateAtUnsubscribe = processor.state;
  await outputStream.append({
    type: PROJECT_WORKER_FORWARDED_EVENT_TYPE,
    payload: {
      childPath: outputPath,
      marker: `after-${marker}`,
      originalType: "manual",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 750));
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exhaustive equality: asserts state is frozen after unsubscribe; toMatchObject subset-matching would weaken the check
  expect(processor.state).toEqual(stateAtUnsubscribe);
});

test("Cap'n Web stream subscribe callback survives the stateless Worker proxy", async () => {
  const marker = crypto.randomUUID();
  const eventType = "events.iterate.test/capnweb-subscribe-callback-forwarded";
  const streamPath = `/capnweb-subscribe-callback-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `capnweb-subscribe-callback-${marker}` });
  using stream = project.streams.get(streamPath);
  const delivered: number[] = [];

  using subscription = await stream.subscribe({
    eventTypes: [eventType],
    processEventBatch: (batch) => {
      for (const event of batch.events) {
        if (event.type === eventType && event.payload?.marker === marker) {
          delivered.push(event.payload.sequence as number);
        }
      }
    },
    subscriber: {
      description: "minimal-itx-v4 e2e direct Cap'n Web callback forwarding probe",
    },
    subscriptionKey: `capnweb-callback-${marker}`,
  });
  const openedSubscriptionKey = await subscription.subscriptionKey;
  expect(openedSubscriptionKey).toBe(`capnweb-callback-${marker}`);

  await waitForCondition(
    async () => {
      const runtimeState = await stream.runtimeState();
      return runtimeState.runtime.connections[openedSubscriptionKey] !== undefined;
    },
    { description: "stream runtime to show the direct Cap'n Web callback connection" },
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  await stream.append({
    type: eventType,
    payload: { marker, sequence: 1 },
  });
  await stream.append({
    type: eventType,
    payload: { marker, sequence: 2 },
  });

  await waitForCondition(() => delivered.includes(1) && delivered.includes(2), {
    description: "Cap'n Web callback deliveries after subscribe returned",
  });
  expect(delivered).toEqual([1, 2]);

  await subscription.unsubscribe();
  await waitForCondition(
    async () => {
      const runtimeState = await stream.runtimeState();
      return runtimeState.runtime.connections[openedSubscriptionKey] === undefined;
    },
    { description: "stream runtime to remove the direct Cap'n Web callback connection" },
  );
  await stream.append({
    type: eventType,
    payload: { marker, sequence: 3 },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(delivered).toEqual([1, 2]);
});

test("Cap'n Web stream subscribe with the same key replaces the old callback", async () => {
  const marker = crypto.randomUUID();
  const eventType = "events.iterate.test/capnweb-subscribe-callback-replaced";
  const streamPath = `/capnweb-subscribe-replaced-${marker}`;
  const subscriptionKey = `capnweb-replaced-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `capnweb-subscribe-replaced-${marker}` });
  using stream = project.streams.get(streamPath);
  const first: number[] = [];
  const second: number[] = [];

  using firstSubscription = await stream.subscribe({
    eventTypes: [eventType],
    processEventBatch: (batch) => {
      first.push(
        ...batch.events
          .filter((event) => event.type === eventType && event.payload?.marker === marker)
          .map((event) => event.payload!.sequence as number),
      );
    },
    subscriptionKey,
  });
  using secondSubscription = await stream.subscribe({
    eventTypes: [eventType],
    processEventBatch: (batch) => {
      second.push(
        ...batch.events
          .filter((event) => event.type === eventType && event.payload?.marker === marker)
          .map((event) => event.payload!.sequence as number),
      );
    },
    subscriptionKey,
  });
  expect(await firstSubscription.subscriptionKey).toBe(subscriptionKey);
  expect(await secondSubscription.subscriptionKey).toBe(subscriptionKey);

  await firstSubscription.unsubscribe();
  await stream.append({
    type: eventType,
    payload: { marker, sequence: 1 },
  });

  await waitForCondition(() => second.includes(1), {
    description: "replacement subscriber delivery",
  });
  expect(first).toEqual([]);
  expect(second).toEqual([1]);

  await secondSubscription.unsubscribe();
});

test("Cap'n Web subscriber runtime-state callbacks survive the stateless Worker proxy", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/capnweb-subscribe-nested-${marker}`;
  const subscriptionKey = `capnweb-nested-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `capnweb-subscribe-nested-${marker}` });
  using stream = project.streams.get(streamPath);
  using subscription = await stream.subscribe({
    processEventBatch: () => {},
    // The live callback rides as a SIBLING of the descriptor: `subscriber`
    // is validated, serialized data (the presence fact) and cannot carry
    // functions. The probe still crosses session → stateless Worker proxy →
    // stream DO as a function-valued member of a plain-object argument.
    getRuntimeState: () => ({
      runtime: { marker },
      snapshot: { offset: 123, state: { marker } },
    }),
    subscriber: {
      description: "minimal-itx-v4 e2e nested subscriber callback forwarding probe",
      processor: {
        announcement: {
          consumes: ["*"],
          description: "Nested callback forwarding probe",
          emits: [],
          ownedEvents: [],
          slug: "minimal-itx-v4.e2e.nested-callback-probe",
          version: "0.1.0",
        },
      },
    },
    subscriptionKey,
  });

  await waitForCondition(
    async () => {
      const state = await stream.getProcessorRuntimeState({ subscriptionKey });
      return state?.runtime?.marker === marker && state.snapshot.offset === 123;
    },
    { description: "getRuntimeState callback after subscribe returned" },
  );

  await subscription.unsubscribe();
});
