// Shared production-shaped harness for the Project processor specs. The real
// runner uses a MemoryStreamNetwork so creation's sibling-stream appends and
// later root-stream reductions are observable through one durable substrate.

import { vi } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import {
  makeProcessorHarness,
  MemoryStreamNetwork,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import type { ProjectDirectoryRecord } from "../../project-directory.ts";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import { WORKER_BUILDING_HEADER } from "../workers/worker-fetch-dispatch.ts";
import { withWorkerCommit } from "../workers/worker-serve-info.ts";
import { internalStreamId } from "../streams/stream-delivery-utils.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
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
  idempotencyKey: internalStreamId("project-creation-terminal", "prj_test", "created"),
  payload: {
    ...PROJECT_CREATE_REQUESTED.payload,
    createRequestedAtOffset: 1,
  },
} satisfies ProjectEventInput;

/** The copied config repo creation certificate as it lands on `/`. */
export const CONFIG_REPO_CREATED = {
  type: "events.iterate.com/repos/created",
  payload: {
    request: { type: "empty" },
    artifactName: "prj_test--L3JlcG9zL2NvbmZpZw",
    defaultBranch: "main",
    remote: "https://example.artifacts.cloudflare.net/git/ns/x.git",
  },
  source: {
    copiedFrom: [
      {
        name: "project-config-to-root",
        streamId: "00000000-0000-4000-8000-000000000002",
        streamCreatedAt: new Date(1).toISOString(),
        cursorChangedAtSourceOffset: 3,
        createdAt: new Date(2).toISOString(),
        offset: 4,
        path: "/repos/config",
        projectId: "prj_test",
        type: "events.iterate.com/repos/created",
      },
    ],
  },
} satisfies ProjectEventInput;

/** The copied config repo terminal failure as it lands on `/`. */
export const CONFIG_REPO_CREATE_FAILED = {
  type: "events.iterate.com/repos/create-failed",
  payload: {
    error: "The backing repository could not be created.",
    request: { type: "empty" },
  },
  source: {
    copiedFrom: [
      {
        name: "project-config-to-root",
        streamId: "00000000-0000-4000-8000-000000000002",
        streamCreatedAt: new Date(1).toISOString(),
        cursorChangedAtSourceOffset: 3,
        createdAt: new Date(2).toISOString(),
        offset: 4,
        path: "/repos/config",
        projectId: "prj_test",
        type: "events.iterate.com/repos/create-failed",
      },
    ],
  },
} satisfies ProjectEventInput;

/** A default-branch config repo commit copied onto the project root. */
export const CONFIG_REPO_COMMIT_COMPLETED = {
  type: "events.iterate.com/repo/commit-completed",
  payload: {
    beforeCommitOid: "a".repeat(40),
    branch: "main",
    commitOid: "b".repeat(40),
  },
  source: {
    copiedFrom: [
      {
        name: "project-config-to-root",
        streamId: "00000000-0000-4000-8000-000000000002",
        streamCreatedAt: new Date(1).toISOString(),
        cursorChangedAtSourceOffset: 3,
        createdAt: new Date(3).toISOString(),
        offset: 5,
        path: "/repos/config",
        projectId: "prj_test",
        type: "events.iterate.com/repo/commit-completed",
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

type SiblingName = "capability-host" | "scheduler" | "repo" | "email";
const SIBLINGS = ["capability-host", "scheduler", "repo", "email"] as const;

/** The generic harness plus the Project processor's external dependencies. */
export function makeProjectHarness(
  options: {
    substrate?: HarnessSubstrate;
    /** Served/thrown by successive worker probes; a 204 after the list runs out. */
    workerOutcomes?: (Response | Error)[];
    /** Trusted source identity stamped on each successful worker probe. */
    workerCommitOids?: string[];
    /** Parks the named sibling's waitUntilProcessed until the promise resolves. */
    siblingWaitBarriers?: Partial<Record<SiblingName, Promise<void>>>;
    /** Advances the virtual clock inside the named sibling's wait. */
    clockAdvanceBySibling?: Partial<Record<SiblingName, number>>;
    /** Overrides the worker probe's retry pause. */
    workerRetrySleep?: () => Promise<void>;
    processorClass?: typeof ProjectProcessor;
  } = {},
) {
  let workerFetchCalls = 0;
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
    ensure: vi.fn(async () => {}),
    readProject: vi.fn(async (): Promise<ProjectDirectoryRecord | null> => PROJECT),
    remove: vi.fn(async () => {}),
  };
  const itx = {
    capabilityHost: { processor: { waitUntilProcessed: waitUntilProcessed("capability-host") } },
    email: { processor: { waitUntilProcessed: waitUntilProcessed("email") } },
    projectId: "prj_test",
    repo: { processor: { waitUntilProcessed: waitUntilProcessed("repo") } },
    scheduler: { processor: { waitUntilProcessed: waitUntilProcessed("scheduler") } },
  } as unknown as ProjectRpcTarget;
  const workerFetch = async () => {
    const outcome = options.workerOutcomes?.[workerFetchCalls];
    workerFetchCalls += 1;
    if (outcome instanceof Error) throw outcome;
    const response = outcome ?? new Response(null, { status: 204 });
    return response.headers.get(WORKER_BUILDING_HEADER) === "1"
      ? response
      : withWorkerCommit(
          response,
          options.workerCommitOids?.[workerFetchCalls - 1] ??
            CONFIG_REPO_COMMIT_COMPLETED.payload.commitOid,
        );
  };
  const Processor = options.processorClass ?? ProjectProcessor;
  const harness = makeProcessorHarness<ProjectProcessorContract>({
    path: "/",
    ...(!options.substrate ? {} : { substrate: options.substrate }),
    createProcessor: (deps) =>
      new Processor({
        ...deps,
        projectId: "prj_test",
        stream: deps.stream,
        sleep: options.workerRetrySleep ?? (() => new Promise((resolve) => setTimeout(resolve, 0))),
        itx,
        customDomains,
        workerFetch,
        appendPlatformEvents: async ({ events, streamId }) => {
          await deps.stream.appendIfStreamId({ events, streamId });
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
    workerFetchCalls: () => workerFetchCalls,
  };
}
