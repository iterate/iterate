import type { GenericEvent } from "@iterate-com/shared/streams/types";
import type { ReceiveFunctionCallResultInput } from "../../src/domains/codemode/durable-objects/codemode-session.ts";
import {
  createAdminOs2Client,
  requireBaseUrl,
  type Os2Client,
  uniqueSuffix,
  readProjectStreamUntil,
} from "./os2-client.ts";

type TestProject = Awaited<ReturnType<Os2Client["projects"]["create"]>>;

export interface TestProjectHandle extends AsyncDisposable {
  baseUrl: string;
  client: Os2Client;
  project: TestProject;
  updateConfig(input: {
    customHostname?: string | null;
    externalEgressProxyUrl?: string | null;
  }): Promise<TestProject>;
}

export async function createFixture(params?: Parameters<typeof createTestProject>[0]) {
  const project = await createTestProject(params);
  const fixture = project;
  return {
    ...project,
    startCodemodeScript: async <T>(
      fn: (ctx: {}) => T | Promise<T>,
      options?: Partial<Omit<typeof project.client.project.codemode.executeScript, "code">>,
    ) => {
      let code = fn.toString();
      if (!code.startsWith("async")) {
        code = `async ${code}`;
      }
      const started = await project.client.project.codemode.executeScript({
        code,
        projectSlugOrId: project.project.id,
        providers: [],
        ...options,
      });
      const startedPayload = started.event.payload as { scriptExecutionId: string };
      const predicate = (event: GenericEvent) =>
        event.type === "events.iterate.com/codemode/script-execution-completed" &&
        (event.payload as ReceiveFunctionCallResultInput).scriptExecutionId ===
          startedPayload.scriptExecutionId;
      return {
        ...started,
        $type: {} as T,
        awaitCompleted: async () => {
          const events = await readProjectStreamUntil({
            afterOffset: started.event.offset > 1 ? started.event.offset - 1 : "start",
            client: fixture.client,
            projectSlugOrId: fixture.project.id,
            streamPath: started.streamPath,
            predicate,
          });
          const completed = events.at(-1)!;
          const payload = completed.payload as ReceiveFunctionCallResultInput;
          return {
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
        },
      };
    },
  };
}

export async function createTestProject(opts?: {
  baseUrl?: string;
  cleanup?: boolean;
  customHostname?: string | null;
  externalEgressProxyUrl?: string | null;
  slugPrefix?: string;
}): Promise<TestProjectHandle> {
  const baseUrl = opts?.baseUrl ?? requireBaseUrl();
  const client = createAdminOs2Client(baseUrl);
  const slugPrefix = opts?.slugPrefix ?? "os2-e2e";
  let project = await client.projects.create({
    slug: `${slugPrefix}-${uniqueSuffix()}`,
  });

  if (opts?.customHostname !== undefined || opts?.externalEgressProxyUrl !== undefined) {
    project = await client.projects.updateConfig({
      id: project.id,
      customHostname: opts.customHostname,
      externalEgressProxyUrl: opts.externalEgressProxyUrl,
    });
  }

  let disposed = false;
  return {
    baseUrl,
    client,
    get project() {
      return project;
    },
    async updateConfig(input) {
      project = await client.projects.updateConfig({
        id: project.id,
        customHostname: input.customHostname,
        externalEgressProxyUrl: input.externalEgressProxyUrl,
      });
      return project;
    },
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      if (opts?.cleanup === false) return;
      await client.projects.remove({ id: project.id }).catch(() => undefined);
    },
  };
}
