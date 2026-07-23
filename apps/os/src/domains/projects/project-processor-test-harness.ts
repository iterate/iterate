// Shared production-shaped harness for the Project processor specs. The real
// runner uses a MemoryStreamNetwork so creation's sibling-stream appends and
// later root-stream reductions are observable through one durable substrate.

import { vi } from "vitest";
import type { ConsumedInput, ProcessorStream, StreamEventInput } from "iterate/processors";
import {
  makeProcessorHarness,
  MemoryStreamNetwork,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import type { ProjectDirectoryRecord } from "../../project-directory.ts";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import {
  ProjectProcessorContract,
  type ProjectCustomDomainCloudflareSnapshot,
} from "./project-processor-contract.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";

export type ProjectEventInput = ConsumedInput<ProjectProcessorContract>;

export const PROJECT_CREATE_REQUESTED = {
  type: "events.iterate.com/project/create-requested",
  payload: {
    config: {
      creatorEmail: "owner@example.com",
      onboardingActive: true,
      slug: "demo",
    },
  },
} satisfies ProjectEventInput;

export const PROJECT_CREATED = {
  type: "events.iterate.com/project/created",
  idempotencyKey: "platform:project-created:prj_test",
  payload: {
    ...PROJECT_CREATE_REQUESTED.payload,
    createRequestedAtOffset: 1,
  },
  source: {
    processor: {
      authority: "platform",
      slug: ProjectProcessorContract.slug,
      version: ProjectProcessorContract.version,
      stream: { path: "/", projectId: "prj_test" },
      whileProcessing: { offset: 2, type: "events.iterate.com/repos/created" },
    },
  },
} satisfies ProjectEventInput;

/** The cross-posted config repo creation certificate as it lands on `/`. */
export const CONFIG_REPO_CREATED = {
  type: "events.iterate.com/repos/created",
  payload: {
    request: { type: "empty" },
    artifactName: "prj_test--L3JlcG9zL2NvbmZpZw",
    defaultBranch: "main",
    remote: "https://example.artifacts.cloudflare.net/git/ns/x.git",
  },
  source: {
    crossPostedFrom: [
      {
        subscriptionKey: "cross-post:/",
        createdAt: new Date(2).toISOString(),
        offset: 4,
        path: "/repos/config",
        projectId: "prj_test",
        type: "events.iterate.com/repos/created",
      },
    ],
  },
} satisfies ProjectEventInput;

/** The cross-posted config repo terminal failure as it lands on `/`. */
export const CONFIG_REPO_CREATE_FAILED = {
  type: "events.iterate.com/repos/create-failed",
  payload: {
    error: "The backing repository could not be created.",
    request: { type: "empty" },
  },
  source: {
    crossPostedFrom: [
      {
        subscriptionKey: "cross-post:/",
        createdAt: new Date(2).toISOString(),
        offset: 4,
        path: "/repos/config",
        projectId: "prj_test",
        type: "events.iterate.com/repos/create-failed",
      },
    ],
  },
} satisfies ProjectEventInput;

export const PROJECT: ProjectDirectoryRecord = {
  id: "prj_garple",
  name: "Garple",
  organizationId: "org_1",
  slug: "garple",
};

export function customDomainSnapshot(
  input: Partial<ProjectCustomDomainCloudflareSnapshot> = {},
): ProjectCustomDomainCloudflareSnapshot {
  return {
    cloudflareHostnameId: "custom-hostname-1",
    error: null,
    hostname: "garple.com",
    hostnameStatus: "active",
    ownershipVerification: null,
    sslStatus: "active",
    status: "active",
    validationRecords: [],
    wildcard: true,
    ...input,
  };
}

type SiblingName = "capability-host" | "scheduler" | "repo" | "email";
const SIBLINGS = ["capability-host", "scheduler", "repo", "email"] as const;

/** Mirror the production Project DO's trusted processor-host append boundary. */
function platformProcessorStream(stream: ProcessorStream): ProcessorStream {
  return {
    append: (...events: StreamEventInput[]) =>
      stream.append(
        ...events.map((event) => {
          const processor = event.source?.processor;
          return processor === undefined
            ? event
            : {
                ...event,
                source: {
                  ...event.source,
                  processor: { ...processor, authority: "platform" as const },
                },
              };
        }),
      ),
    at: (path) => platformProcessorStream(stream.at(path)),
    getEvent: (input) => stream.getEvent(input),
    getEvents: (input) => stream.getEvents(input),
    readEvents: (input) => stream.readEvents(input),
  };
}

/** The generic harness plus the Project processor's external dependencies. */
export function makeProjectHarness(
  options: {
    substrate?: HarnessSubstrate;
    /** Served/thrown by successive worker probes; a 204 after the list runs out. */
    workerOutcomes?: (Response | Error)[];
    /** Parks the named sibling's waitUntilProcessed until the promise resolves. */
    siblingWaitBarriers?: Partial<Record<SiblingName, Promise<void>>>;
    /** Advances the virtual clock inside the named sibling's wait. */
    clockAdvanceBySibling?: Partial<Record<SiblingName, number>>;
    /** Parks the exact project-worker delivery fence until this resolves. */
    subscriptionDeliveryBarrier?: Promise<void>;
    /** Errors from successive delivery waits; later waits succeed. */
    subscriptionDeliveryErrors?: Error[];
    /** Overrides the worker probe's retry pause. */
    workerRetrySleep?: () => Promise<void>;
    processorClass?: typeof ProjectProcessor;
  } = {},
) {
  let workerFetchCalls = 0;
  const subscriptionDeliveryWaits: {
    configuredAtOffset: number;
    eventType: string;
    expression: ["processEventBatch"];
    subscriptionKey: string;
    targetOffset: number;
    timeoutMs: number;
  }[] = [];
  const subscriptionDeliveryWaitStarted = Promise.withResolvers<void>();
  const siblingWaits: { processor: SiblingName; offset: number; timeoutMs?: number }[] = [];
  const siblingWaitStarted = {} as Record<SiblingName, Promise<void>>;
  const resolveSiblingWaitStarted = {} as Record<SiblingName, () => void>;
  for (const sibling of SIBLINGS) {
    siblingWaitStarted[sibling] = new Promise<void>((resolve) => {
      resolveSiblingWaitStarted[sibling] = resolve;
    });
  }
  const clockBox = { advance: (_ms: number) => {} };
  const waitUntilProcessed =
    (sibling: SiblingName) => async (input: { offset: number; timeoutMs?: number }) => {
      siblingWaits.push({ processor: sibling, offset: input.offset, timeoutMs: input.timeoutMs });
      resolveSiblingWaitStarted[sibling]();
      clockBox.advance(options.clockAdvanceBySibling?.[sibling] ?? 0);
      await options.siblingWaitBarriers?.[sibling];
    };
  const customDomains = {
    ensure: vi.fn(async () =>
      customDomainSnapshot({
        hostnameStatus: "pending",
        sslStatus: "pending_validation",
        status: "pending_validation",
      }),
    ),
    readProject: vi.fn(async (): Promise<ProjectDirectoryRecord | null> => PROJECT),
    refresh: vi.fn(async () => customDomainSnapshot()),
    remove: vi.fn(async () => {}),
  };
  const itx = {
    capabilityHost: { processor: { waitUntilProcessed: waitUntilProcessed("capability-host") } },
    email: { processor: { waitUntilProcessed: waitUntilProcessed("email") } },
    projectId: "prj_test",
    repo: { processor: { waitUntilProcessed: waitUntilProcessed("repo") } },
    scheduler: { processor: { waitUntilProcessed: waitUntilProcessed("scheduler") } },
    worker: {
      fetch: async () => {
        const outcome = options.workerOutcomes?.[workerFetchCalls];
        workerFetchCalls += 1;
        if (outcome instanceof Error) throw outcome;
        return outcome ?? new Response(null, { status: 204 });
      },
    },
  } as unknown as ProjectRpcTarget;
  const Processor = options.processorClass ?? ProjectProcessor;
  const harness = makeProcessorHarness<ProjectProcessorContract>({
    path: "/",
    ...(options.substrate === undefined ? {} : { substrate: options.substrate }),
    createProcessor: (deps) =>
      new Processor({
        ...deps,
        projectId: "prj_test",
        stream: platformProcessorStream(deps.stream),
        sleep: options.workerRetrySleep ?? (() => new Promise((resolve) => setTimeout(resolve, 0))),
        itx,
        customDomains,
        waitUntilSubscriptionDelivered: async (input) => {
          subscriptionDeliveryWaits.push(input);
          subscriptionDeliveryWaitStarted.resolve();
          await options.subscriptionDeliveryBarrier;
          const error = options.subscriptionDeliveryErrors?.[subscriptionDeliveryWaits.length - 1];
          if (error !== undefined) throw error;
        },
      }),
  });
  clockBox.advance = (ms) => {
    harness.clock.now += ms;
  };
  const network = new MemoryStreamNetwork(() => harness.clock.now);
  network.streams.set("/", harness.stream);
  harness.stream.network = network;
  return {
    ...harness,
    network,
    customDomains,
    siblingWaits,
    siblingWaitStarted,
    subscriptionDeliveryWaitStarted: subscriptionDeliveryWaitStarted.promise,
    subscriptionDeliveryWaits,
    workerFetchCalls: () => workerFetchCalls,
  };
}
