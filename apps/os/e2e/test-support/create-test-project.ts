import path from "node:path";
import type { Event, EventInput } from "@iterate-com/shared/streams/types";
import type { Project } from "@iterate-com/os-contract";
import { createCaptunTunnel } from "captun";
import { expect } from "vitest";
import { slugify } from "@iterate-com/shared/slug";
import type { ProcessorContractShape } from "@iterate-com/shared/stream-processors";
import type { ReceiveFunctionCallResultInput } from "../../src/domains/codemode/durable-objects/codemode-session.ts";
import {
  createAdminOsClient,
  requireBaseUrl,
  uniqueSuffix,
  streamProjectEventsUntil,
  requireAdminBearerToken,
  type OsClient,
} from "./os-client.ts";
import type { AiCapability, ReposCapability, WorkspaceDurableObject } from "~/entry.workerd.ts";

type Fetch = Parameters<typeof createCaptunTunnel>[0]["fetch"];

export async function createTestProjectFixture<
  ProcessorContracts extends ProcessorContractShape[],
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

type OptionalProjectDeep<T> = T extends (
  params: infer P extends { projectSlugOrId: string },
) => infer R
  ? (params: Omit<P, "projectSlugOrId"> & { projectSlugOrId?: string }) => R
  : { [K in keyof T]: OptionalProjectDeep<T[K]> };

type Stubify<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (
        ...args: A
      ) => Awaited<R> extends import("cloudflare:workers").RpcTarget
        ? Stubify<Awaited<R>>
        : Promise<Awaited<R>>
    : Stubify<T[K]>;
};

type DefaultCtx = {
  os: OptionalProjectDeep<OsClient>;
  ai: AiCapability;
  env: {};
  repos: Stubify<ReposCapability>;
  workspace: Stubify<ReturnType<WorkspaceDurableObject["getShellState"]>>;
};

type ExecuteScriptParams = Parameters<OsClient["project"]["codemode"]["executeScript"]>[0];
type CodemodeBuilderOptions = Omit<ExecuteScriptParams, "code">;

class CodemodeBuilder<Ctx = DefaultCtx> {
  constructor(
    readonly os: OsClient,
    readonly options: CodemodeBuilderOptions,
  ) {}

  stringify<Result>(fn: (ctx: Ctx) => Promise<Result>) {
    const code = fn.toString();
    return code.startsWith("async ") ? code : `async ${code}`;
  }

  define<Result>(fn: (ctx: Ctx) => Promise<Result>) {
    return {
      code: this.stringify(fn),
      $ctx: {} as Ctx,
      $type: {} as Result,
    };
  }

  async start<NewCtx extends Ctx = {} extends Ctx ? any : Ctx, Result = {}>(
    fn: (ctx: NewCtx) => Promise<Result>,
  ) {
    return this.os.project.codemode.executeScript({
      code: this.context<NewCtx>().stringify(fn),
      ...this.options,
    });
  }

  async execute<NewCtx extends Ctx = Ctx, Result = {}>(fn: { (ctx: NewCtx): Promise<Result> }) {
    const started = await this.start(fn);
    const startedPayload = started.event.payload as { scriptExecutionId: string };
    const isCompletedScriptExecution = (
      event: Event,
    ): event is Event & { payload: ReceiveFunctionCallResultInput } =>
      event.type === "events.iterate.com/codemode/script-execution-completed" &&
      (event.payload as ReceiveFunctionCallResultInput).scriptExecutionId ===
        startedPayload.scriptExecutionId;

    const events = await streamProjectEventsUntil({
      afterOffset: started.event.offset > 1 ? started.event.offset - 1 : "start",
      client: this.os,
      projectSlugOrId: this.options.projectSlugOrId,
      streamPath: started.streamPath,
      // todo: proper strongly-typed version of this read-until helper
      predicate: isCompletedScriptExecution,
    });
    const completed = events.find(isCompletedScriptExecution);
    if (!completed) {
      throw new Error(
        `Expected completed script execution ${startedPayload.scriptExecutionId} in stream batch.`,
      );
    }
    const payload = completed.payload;
    return {
      /** Raw payload from the completed event. Use `.success()` instead if you expect a successful result. */
      payload,
      /** Asserts that the script executed successfully and returns the strongly-typed result */
      success: () => {
        if (payload.outcome?.status !== "returned") {
          throw new Error(`codemode: ${payload.outcome?.status}: ${payload.outcome.error}`, {
            cause: completed,
          });
        }
        return payload.outcome.value as Result;
      },
      /** The full completed event object, including the payload. */
      event: completed as Omit<typeof completed, "payload"> & {
        payload: ReceiveFunctionCallResultInput;
      },
      /** All events in the stream batch, including the completed event. */
      events,
      /**
       * a snapshot-friendly copy of the completed event payload. optionally pass in key-value pairs to replace in the whole payload
       * note: each `value` is replaced with `<key>` so `{ requestId: "abc123" }` replaces all `abc123` occurrences in the whole payload with `<requestId>`
       */
      snapshot: (redactions: Record<string, string> = {}) => {
        let json = JSON.stringify(completed.payload);
        // sort by length descending to avoid replacing substrings
        const entries = Object.entries(redactions).sort((a, b) => b[0].length - a[0].length);
        for (const [key, value] of entries) {
          json = json.replaceAll(value, `<${key}>`);
        }
        const snapshottable = JSON.parse(json) as typeof payload;
        snapshottable.durationMs = 999;
        snapshottable.scriptExecutionId = "<script-execution-id>";
        snapshottable.functionCallId = "<function-call-id>";
        return snapshottable;
      },
    };
  }
  /** Type-only method to set the type of the codemode function's context parameter */
  context<NewCtx, Mode extends "extend" | "replace" = "extend">() {
    type ReplacementCtx = Mode extends "extend" ? NewCtx & Ctx : NewCtx;
    return this as CodemodeBuilder<ReplacementCtx>;
  }

  /**
   * Set an environment variable for the codemode function.
   * This will be available to the codemode function as `ctx.env.YOUR_ENV_VAR`.
   */
  env<Key extends string, Value extends string>(key: Key, value: Value) {
    if (key.trim() === "") {
      throw new Error("Codemode env key must not be blank.");
    }

    type OldEnv = Ctx extends { env: infer OldEnv } ? OldEnv : never;
    type NewCtx = Ctx & { env: OldEnv & Record<Key, Value> };
    return new CodemodeBuilder<NewCtx>(this.os, {
      ...this.options,
      events: [
        ...(this.options.events || []),
        {
          type: "events.iterate.com/codemode/env-updated",
          payload: { env: { [key]: value } },
        },
      ],
    });
  }
}

type ProcessorContractEvent<ProcessorContracts extends ProcessorContractShape[]> =
  ProcessorContractShape extends { processorDeps: infer Deps extends ProcessorContractShape[] }
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
    url: `${input.project.ingressUrl}/__iterate/intercept-project-egress`,
    headers: { Authorization: `Bearer ${requireAdminBearerToken()}` },
    fetch: input.fetch,
  });
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
