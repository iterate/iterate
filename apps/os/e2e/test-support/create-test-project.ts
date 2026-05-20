import type { Event } from "@iterate-com/shared/streams/types";
import type { Project } from "@iterate-com/os-contract";
import { createCaptunTunnel } from "captun/client";
import type { ReceiveFunctionCallResultInput } from "../../src/domains/codemode/durable-objects/codemode-session.ts";
import {
  createAdminOsClient,
  requireBaseUrl,
  uniqueSuffix,
  readProjectStreamUntil,
  requireAdminBearerToken,
} from "./os-client.ts";

type Fetch = Parameters<typeof createCaptunTunnel>[0]["fetch"];

export async function createTestProjectFixture(params: {
  slugPrefix: string;
  /** a fetch implementation that will be used to intercept the project's egress */
  egressFetch?: Fetch;
}) {
  const { slugPrefix, egressFetch } = params;
  const project = await createTestProject({ slugPrefix });
  const tunnel = egressFetch
    ? await createProjectEgressInterceptTunnel({ project: project.project, fetch: egressFetch })
    : null;
  const fixture = project;
  type ExecuteScriptParams = Parameters<
    Awaited<ReturnType<typeof createTestProject>>["client"]["project"]["codemode"]["executeScript"]
  >[0];

  const startCodemodeScript = async <T, U>(
    fn: (ctx: T) => Promise<U>,
    opts?: Partial<Omit<ExecuteScriptParams, "code">>,
  ) => {
    const script = stringifyCodemodeScript(fn);
    const started = await project.client.project.codemode.executeScript({
      ...script,
      projectSlugOrId: project.project.id,
      providers: [],
      ...opts,
    });

    return {
      ...started,
      $type: {} as U,
    };
  };

  const executeCodemodeScript = async <T, U>(
    ...args: Parameters<typeof startCodemodeScript<T, U>>
  ) => {
    const started = await startCodemodeScript(...args);
    const startedPayload = started.event.payload as { scriptExecutionId: string };
    const isCompletedScriptExecution = (
      event: Event,
    ): event is Event & { payload: ReceiveFunctionCallResultInput } =>
      event.type === "events.iterate.com/codemode/script-execution-completed" &&
      (event.payload as ReceiveFunctionCallResultInput).scriptExecutionId ===
        startedPayload.scriptExecutionId;

    const events = await readProjectStreamUntil({
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
    const payload = completed.payload;
    return {
      $type: {} as T,
      payload,
      event: completed as Omit<typeof completed, "payload"> & { payload: T },
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

  return {
    ...project,
    stringifyCodemodeScript,
    startCodemodeScript,
    executeCodemodeScript,
    async [Symbol.asyncDispose]() {
      tunnel?.[Symbol.dispose]();
    },
  };
}

export const stringifyCodemodeScript = <T, U>(fn: (ctx: T) => Promise<U>) => {
  let code = fn.toString();
  if (!code.startsWith("async")) {
    code = `async ${code}`;
  }
  return {
    code,
    $type: {} as U,
  };
};

export async function createTestProject(opts: { slugPrefix: string }) {
  const baseUrl = requireBaseUrl();
  const client = createAdminOsClient(baseUrl);
  const slugPrefix = opts.slugPrefix;
  let project = await client.projects.create({
    slug: `${slugPrefix}-${uniqueSuffix()}`,
  });

  let disposed = false;
  return {
    baseUrl,
    client,
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
