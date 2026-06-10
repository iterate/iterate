// Shared itx scripts: the SAME function bodies run from Node over Cap'n Web
// and inside /api/itx/run dynamic workers (and, later, the browser). This is
// the executable proof that the handle is transport-honest — scripts may only
// use what works everywhere, so they `await` narrowing instead of relying on
// pipelining, and they return plain serializable values.

import type { Itx } from "../handle.ts";

export type ItxScriptInput<Vars extends Record<string, unknown> = Record<string, unknown>> = {
  itx: Itx;
  vars: Vars;
};

export type ItxScript<
  Vars extends Record<string, unknown> = Record<string, unknown>,
  Result = unknown,
> = (input: ItxScriptInput<Vars>) => Result | Promise<Result>;

class ItxScriptBuilder<Vars extends Record<string, unknown> = Record<string, unknown>> {
  define<Result>(fn: ItxScript<Vars, Result>) {
    return fn;
  }

  vars<NewVars extends Record<string, unknown>>() {
    return this as unknown as ItxScriptBuilder<NewVars>;
  }
}

export const itxScript = new ItxScriptBuilder();

/** Narrow global → project, describe both ends. */
export const describeProject = itxScript
  .vars<{ projectId: string }>()
  .define(async ({ itx, vars }) => {
    const project = await itx.projects.get(vars.projectId);
    const description = await project.describe();
    return {
      context: description.context,
      projectId: description.project?.id,
      slug: description.project?.slug,
    };
  });

/** Streams through a narrowed handle: append, read back, verify the marker. */
export const appendAndReadStream = itxScript
  .vars<{ eventType: string; marker: string; projectId: string; streamPath: string }>()
  .define(async ({ itx, vars }) => {
    const project = await itx.projects.get(vars.projectId);
    const stream = await project.streams.get(vars.streamPath);
    const appended = (await stream.append({
      payload: { marker: vars.marker },
      type: vars.eventType,
    })) as { offset: number; payload: { marker: string }; type: string };
    const events = (await stream.read()) as Array<{ payload: { marker: string }; type: string }>;
    return {
      appended: { marker: appended.payload.marker, type: appended.type },
      readBackMarkers: events
        .filter((event) => event.type === vars.eventType)
        .map((event) => event.payload.marker),
    };
  });

/**
 * Invoke a previously defined path-call capability through the fallthrough:
 * `itx.<name>.chat.postMessage(...)` with zero client-side wiring. The cap
 * name arrives in vars so the same script exercises live AND worker caps.
 */
export const callPathCapability = itxScript
  .vars<{ capName: string; projectId: string; text: string }>()
  .define(async ({ itx, vars }) => {
    const project = (await itx.projects.get(vars.projectId)) as unknown as Record<
      string,
      { chat: { postMessage: (input: { text: string }) => Promise<unknown> } }
    >;
    return await project[vars.capName]!.chat.postMessage({ text: vars.text });
  });

/**
 * Worker-cap source: a durable path-call capability. The provider implements
 * ONE method and callers get the whole dotted surface (the Slack SDK trick:
 * public SDK docs become the tool docs).
 */
export function pathCallCapSource(input: { marker: string }) {
  return `
    import { WorkerEntrypoint } from "cloudflare:workers";

    export default class extends WorkerEntrypoint {
      async call({ path, args }) {
        return {
          args,
          marker: ${JSON.stringify(input.marker)},
          method: path.join("."),
        };
      }
    }
  `;
}

/**
 * Worker-cap source proving caps get a working, correctly scoped itx of
 * their own: a tiny todo tool storing items on a project stream via
 * env.ITERATE.context. Invoked with "members": itx.todo.add({ text }).
 */
export function todoCapSource() {
  return `
    import { WorkerEntrypoint } from "cloudflare:workers";

    const TODO_STREAM = "/itx-e2e/todos";
    const TODO_EVENT = "events.iterate.test/itx/todo-added";

    export default class extends WorkerEntrypoint {
      async add({ text }) {
        const itx = await this.env.ITERATE.context;
        const appended = await itx.streams.get(TODO_STREAM).append({
          payload: { text },
          type: TODO_EVENT,
        });
        return { offset: appended.offset, text };
      }

      async list() {
        const itx = await this.env.ITERATE.context;
        const events = await itx.streams.get(TODO_STREAM).read();
        return events
          .filter((event) => event.type === TODO_EVENT)
          .map((event) => event.payload.text);
      }
    }
  `;
}
