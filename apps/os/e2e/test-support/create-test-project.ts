import path from "node:path";
import type { EventInput } from "@iterate-com/shared/streams/types";
import { createCaptunTunnel } from "captun";
import { RpcTarget } from "capnweb";
import { expect } from "vitest";
import { slugify } from "@iterate-com/shared/slug";
import type { ProcessorContractShape } from "@iterate-com/streams/shared/stream-processors";
import {
  createAdminOsClient,
  requireBaseUrl,
  uniqueSuffix,
  requireAdminBearerToken,
} from "./os-client.ts";
import { connectItx, type ItxClient } from "~/itx/client.ts";

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
  let egressItx: ItxClient | null = null;
  try {
    if (egressFetch) {
      egressItx = await defineLiveEgressFetchCap({
        baseUrl: project.baseUrl,
        fetch: egressFetch,
        projectId: project.project.id,
      });
    }
  } catch (error) {
    egressItx?.[Symbol.dispose]?.();
    await project[Symbol.asyncDispose]();
    throw error;
  }

  return {
    ...project,
    /** recommended test stream path - arbitrary, but by convention mirrors test file + name as its path (`/${relativeFilePath}/${describeSlug}/${testSlug}`)  */
    streamPath,
    slugPrefix,
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
        // The fetch shadow is a LIVE cap: dropping the itx session revokes it.
        egressItx?.[Symbol.dispose]?.();
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

/**
 * Shadows the project's `fetch` capability with a LIVE cap backed by the
 * given fetch implementation: every project egress request dispatches to it
 * (with getSecret() placeholders unsubstituted) for as long as the returned
 * itx session stays open. Dispose the session to drop the shadow.
 */
async function defineLiveEgressFetchCap(input: {
  baseUrl: string;
  fetch: Fetch;
  projectId: string;
}): Promise<ItxClient> {
  class LiveEgressFetch extends RpcTarget {
    async call({ args }: { path: string[]; args: unknown[] }) {
      return await input.fetch(args[0] as Request);
    }
  }

  const itx = connectItx({
    baseUrl: input.baseUrl,
    context: input.projectId,
    token: requireAdminBearerToken(),
  });
  try {
    await itx.define({
      invoke: "path-call",
      name: "fetch",
      target: new LiveEgressFetch() as never,
    });
  } catch (error) {
    itx[Symbol.dispose]?.();
    throw error;
  }
  return itx;
}

/** creates a public OS-hosted captun tunnel for test-defined HTTP servers */
export async function createPublicTunnel(input: { fetch: Fetch; tunnelName?: string }) {
  const tunnelName = input.tunnelName || `e2e-${uniqueSuffix()}`;
  const url = `${requireBaseUrl()}/__iterate/captun/${encodeURIComponent(tunnelName)}`;
  const tunnel = await createCaptunTunnel({
    url: `${url}/__captun-connect`,
    headers: { Authorization: `Bearer ${requireAdminBearerToken()}` },
    fetch: input.fetch,
  });

  return {
    url,
    [Symbol.dispose]() {
      tunnel[Symbol.dispose]();
    },
  };
}
