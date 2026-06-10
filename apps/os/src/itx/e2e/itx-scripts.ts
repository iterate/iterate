// Worker-cap sources shared by the itx e2e scenarios. The cross-runtime
// script catalogue itself lives in src/itx/examples.ts (it doubles as the
// REPL's Examples panel); these are the remaining test-only dynamic-worker
// sources for scenario tests that aren't catalogue material.

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
