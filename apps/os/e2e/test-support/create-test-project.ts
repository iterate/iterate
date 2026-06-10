import path from "node:path";
import type { EventInput } from "@iterate-com/shared/streams/types";
import type { Project } from "@iterate-com/os-contract";
import { createCaptunTunnel } from "captun";
import { expect } from "vitest";
import { slugify } from "@iterate-com/shared/slug";
import type { ProcessorContractShape } from "@iterate-com/streams/shared/stream-processors";
import {
  createAdminOsClient,
  requireBaseUrl,
  uniqueSuffix,
  requireAdminBearerToken,
} from "./os-client.ts";
import { CodemodeBuilder } from "./codemode-builder.ts";

type Fetch = Parameters<typeof createCaptunTunnel>[0]["fetch"];

/**
 * Structural subset of a stream processor contract used for event typing.
 * Looser than `ProcessorContractShape` so contracts returned by
 * `defineProcessorContract` (whose `reduce` is property-typed after `Omit`)
 * remain assignable.
 */
type ProcessorContractLike = {
  events: ProcessorContractShape["events"];
  processorDeps?: readonly unknown[];
};

export async function createTestProjectFixture<
  ProcessorContracts extends ProcessorContractLike[],
>(params?: {
  /** a fetch implementation that will be used to intercept the project's egress */
  egressFetch?: Fetch;
  processors?: ProcessorContracts;
  slugPrefix?: string;
}) {
  const testFilePath = expect.getState().testPath;
  if (!testFilePath) throw new Error(`Couldn't get test path from expect.getState()`);
  const streamPathParts = [
    ...path.relative(process.cwd(), testFilePath).split("/"),
    ...expect.getState().currentTestName!.split(" > "),
  ].map(slugify);
  const streamPath = "/" + streamPathParts.join("/");
  const { egressFetch } = params || {};
  const slugPrefix = params?.slugPrefix || streamPathParts.at(-1)!;
  const project = await createTestProject({ slugPrefix });
  let tunnel: Awaited<ReturnType<typeof createProjectEgressInterceptTunnel>> | null = null;
  try {
    tunnel = egressFetch
      ? await createProjectEgressInterceptTunnel({ project: project.project, fetch: egressFetch })
      : null;
  } catch (error) {
    await project[Symbol.asyncDispose]();
    throw error;
  }

  return {
    ...project,
    /** recommended test stream path - arbitrary, but by convention mirrors test file + name as its path (`/${relativeFilePath}/${describeSlug}/${testSlug}`)  */
    streamPath,
    slugPrefix,
    codemode: new CodemodeBuilder(project.os, {
      projectSlugOrId: project.project.slug,
      providers: [],
      streamPath,
    }),
    /** strongly-typed event constructor for the given processor contracts */
    event: (event: ProcessorContractEvent<ProcessorContracts>) => event,
    /** shorthand for appending an event to the test's associated project + stream */
    append: (params: {
      projectSlugOrId?: string;
      streamPath?: string;
      event: ProcessorContractEvent<ProcessorContracts>;
    }) =>
      project.os.project.streams.append({
        projectSlugOrId: params.projectSlugOrId || project.project.slug,
        streamPath: params.streamPath || streamPath,
        event: params.event,
      }),
    async [Symbol.asyncDispose]() {
      try {
        tunnel?.[Symbol.dispose]();
      } finally {
        await project[Symbol.asyncDispose]();
      }
    },
  };
}

type ProcessorContractEvent<ProcessorContracts extends ProcessorContractLike[]> =
  ProcessorContractLike extends { processorDeps: infer Deps extends ProcessorContractLike[] }
    ? ExtractEventType<ProcessorContracts[number]["events"]> | ProcessorContractEvent<Deps>
    : ExtractEventType<ProcessorContracts[number]["events"]>;

type ExtractEventType<EventsDefinition extends ProcessorContractShape["events"]> = Extract<
  {
    [K in keyof EventsDefinition]: Omit<EventInput, "type" | "payload"> & {
      type: Extract<K, string>;
      payload: NoInfer<
        NonNullable<EventsDefinition[K]["payloadSchema"]["~standard"]["types"]>["output"]
      >;
    };
  }[keyof EventsDefinition],
  EventInput
>;

export async function createTestProject(opts: { slugPrefix: string }) {
  const baseUrl = requireBaseUrl();
  const client = createAdminOsClient(baseUrl);
  const slugPrefix = opts.slugPrefix;
  let project = await client.projects.create({
    // you get invalid DNS name errors if the slug is too long
    slug: `${slugPrefix.slice(0, 20)}-${uniqueSuffix()}`.replace("--", "-"),
  });

  let disposed = false;
  return {
    baseUrl,
    /** @deprecated use `.os` instead */
    client,
    os: client,
    get project() {
      return project;
    },
    async updateConfig(input: { customHostname?: string | null }) {
      project = await client.projects.updateConfig({
        id: project.id,
        customHostname: input.customHostname,
      });
      return project;
    },
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      await client.projects.remove({ id: project.id }).catch(() => undefined);
    },
  };
}

/** creates a captun tunnel to the project's worker to capture its egress */
export async function createProjectEgressInterceptTunnel(input: {
  project: Project & { ingressUrl: string };
  fetch: Fetch;
}) {
  return createCaptunTunnel({
    gateway: `${input.project.ingressUrl}/__iterate/intercept-project-egress`,
    token: requireAdminBearerToken(),
    fetch: input.fetch,
  });
}

/** creates a public OS-hosted captun tunnel for test-defined HTTP servers */
export async function createPublicTunnel(input: { fetch: Fetch; tunnelName?: string }) {
  const tunnelName = input.tunnelName || `e2e-${uniqueSuffix()}`;
  const url = `${requireBaseUrl()}/__iterate/captun/${encodeURIComponent(tunnelName)}`;
  const tunnel = await createCaptunTunnel({
    gateway: `${requireBaseUrl()}/__iterate/captun`,
    name: tunnelName,
    token: requireAdminBearerToken(),
    fetch: input.fetch,
  });

  return {
    url,
    [Symbol.dispose]() {
      tunnel[Symbol.dispose]();
    },
  };
}
