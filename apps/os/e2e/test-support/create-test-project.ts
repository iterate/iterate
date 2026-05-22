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
} from "./os-client.ts";

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
  const fixture = project;
  type ExecuteScriptParams = Parameters<
    Awaited<ReturnType<typeof createTestProject>>["os"]["project"]["codemode"]["executeScript"]
  >[0];

  const startCodemodeScript = async <Ctx, Result>(
    fn: ((ctx: Ctx) => Promise<Result>) | CodemodeScript<Ctx, Result>,
    opts?: Partial<Omit<ExecuteScriptParams, "code">>,
  ) => {
    const script = typeof fn === "function" ? stringifyCodemodeScript(fn) : fn;
    const started = await project.os.project.codemode.executeScript({
      code: script.code,
      projectSlugOrId: project.project.id,
      providers: [],
      streamPath,
      ...opts,
    });

    return {
      ...script,
      ...started,
    };
  };

  const executeCodemodeScript = async <Ctx, Result>(
    ...args: Parameters<typeof startCodemodeScript<Ctx, Result>>
  ) => {
    const started = await startCodemodeScript(...args);
    const startedPayload = started.event.payload as { scriptExecutionId: string };
    const isCompletedScriptExecution = (
      event: Event,
    ): event is Event & { payload: ReceiveFunctionCallResultInput } =>
      event.type === "events.iterate.com/codemode/script-execution-completed" &&
      (event.payload as ReceiveFunctionCallResultInput).scriptExecutionId ===
        startedPayload.scriptExecutionId;

    const events = await streamProjectEventsUntil({
      afterOffset: started.event.offset > 1 ? started.event.offset - 1 : "start",
      client: fixture.client,
      projectSlugOrId: fixture.project.id,
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
    const payload = completed.payload; // todo: maybe throw if it's outcome: "threw" and add a type of the actual script result
    return {
      payload,
      success: () => {
        if (payload.outcome?.status !== "returned") {
          throw new Error(`codemode: ${payload.outcome?.status}: ${payload.outcome.error}`, {
            cause: completed,
          });
        }
        return payload.outcome.value as Result;
      },
      event: completed as Omit<typeof completed, "payload"> & { payload: Ctx },
      events,
      /** get a snapshot-friendly copy of the completed event payload. optionally pass in key-value pairs to replace in the whole payload */
      snapshot: (swaps: Record<string, string> = {}) => {
        let json = JSON.stringify(completed.payload);
        for (const [key, value] of Object.entries(swaps)) {
          json = json.replaceAll(value, `<${key}>`);
        }
        const snapshottable = JSON.parse(json) as typeof payload;
        snapshottable.durationMs = 999;
        snapshottable.scriptExecutionId = "<script-execution-id>";
        snapshottable.functionCallId = "<function-call-id>";
        return snapshottable;
      },
    };
  };

  class CodemodeBuilder<Ctx = {}, This = {}> {
    _bound: This;
    _options: Omit<ExecuteScriptParams, "code">;

    constructor(params: { options: Omit<ExecuteScriptParams, "code">; bound: This }) {
      this._bound = params.bound;
      this._options = params.options;
    }

    stringify<Result>(fn: { (this: This, ctx: Ctx): Promise<Result> }) {
      let code = fn.toString();
      if (!code.startsWith("async")) {
        code = `async ${code}`;
      }
      return {
        code,
        $ctx: {} as Ctx,
        $type: {} as Result,
      };
    }

    options(newOptions: Partial<typeof this._options>) {
      return new CodemodeBuilder<Ctx, This>({
        options: { ...this._options, ...newOptions },
        bound: this._bound,
      });
    }

    execute<NewCtx extends Ctx = {} extends Ctx ? any : Ctx, Result = {}>(fn: {
      (this: This, ctx: NewCtx): Promise<Result>;
    }) {
      return executeCodemodeScript(this.define(fn));
    }
    /** Type-only method to set the type of the codemode function's context parameter */
    context<NewCtx>() {
      return this as CodemodeBuilder<unknown, This> as CodemodeBuilder<NewCtx, This>;
    }
    /**
     * Set some serializable data as the codemode function's `this` binding. Useful when your script needs to access something from outside its scope
     * @example
     * ```ts
     * const publicTunnel = await createPublicTunnel({ fetch: fixture.tunnelBaseUrl });
     *
     * const result = await fixture.codemode
     *   .bind({ baseUrl: publicTunnel.url })
     *   .execute(async function () {
     *     const response = await fetch(`${this.baseUrl}/foobar`);
     *     return response.json();
     *   });
     * ```
     */
    bind<NewThis>(bound: NewThis) {
      try {
        return new CodemodeBuilder<Ctx, NewThis>({
          options: this._options,
          bound: bound,
        });
      } catch (error) {
        throw new Error(`Binding value passed to .bind() must be serializable`, { cause: error });
      }
    }
    define<NewCtx extends Ctx = {} extends Ctx ? any : Ctx, Result = {}>(fn: {
      (this: This, ctx: NewCtx): Promise<Result>;
    }) {
      const script = this.context<NewCtx>().stringify<Result>(fn);
      if (this._bound !== null) {
        const indentedCode = script.code.replace(/\n/g, "\n  ");
        script.code = [
          `async (ctx) => {`,
          `  return await (${indentedCode}).bind(${JSON.stringify(this._bound)})(ctx)`,
          `}`,
        ].join("\n");
      }
      return script;
    }
  }

  return {
    ...project,
    /** recommended test stream path - arbitrary, but by convention mirrors test file + name as its path (`/${relativeFilePath}/${describeSlug}/${testSlug}`)  */
    streamPath,
    slugPrefix,
    codemode: new CodemodeBuilder({
      options: { projectSlugOrId: project.project.slug, streamPath },
      bound: {},
    }),
    tunnelBaseUrl: tunnel ? project.baseUrl + "/__iterate/use-egress-tunnel" : undefined,
    /** strongly-typed event constructor for the given processor contracts */
    event: (event: ProcessorContractEvent<ProcessorContracts>) => event,
    /** shorthand for appending an event to the associated test's associated project + stream */
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
    stringifyCodemodeScript,
    createCodemodeScriptWithInputs,
    startCodemodeScript,
    executeCodemodeScript,
    async [Symbol.asyncDispose]() {
      try {
        tunnel?.[Symbol.dispose]();
      } finally {
        await project[Symbol.asyncDispose]();
      }
    },
  };
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

export type CodemodeScript<Ctx, Result> = ReturnType<typeof stringifyCodemodeScript<Ctx, Result>>;

export const stringifyCodemodeScript = <Ctx, Result>(
  fn: (ctx: Ctx, ...args: any[]) => Promise<Result>,
) => {
  let code = fn.toString();
  if (!code.startsWith("async")) {
    code = `async ${code}`;
  }
  return {
    code,
    $ctx: {} as Ctx,
    $type: {} as Result,
  };
};

export const createCodemodeScriptWithInputs = <Inputs, Ctx, Result>(
  inputs: Inputs,
  fn: (ctx: Ctx, inputs: Inputs) => Promise<Result>,
) => {
  const script = stringifyCodemodeScript(fn);
  const match = script.code
    .split("\n")[0]
    .trim()
    .match(/, inputs\) => {/);
  if (!match) {
    throw new Error(`code with inputs must take a second arg named 'inputs'. Got: ${script.code}`);
  }
  return {
    ...script,
    code: script.code.replace("\n", `\n  inputs = ${JSON.stringify(inputs)}\n`),
  };
};

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
