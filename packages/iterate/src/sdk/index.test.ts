// sdk/index.test.ts — `IterateConfigEntrypoint` in Node, on the `cloudflare:workers` shim's base
// class: the platform's `deliverEvent` hands `processEvent` one event and the project's root, the
// scope of ONE `withItx` round trip that is released once the handler settles, even when it throws.
import { expect, test } from "vitest";
import type { StreamEvent } from "../stream/processor.ts";
import { IterateConfigEntrypoint, type IterateConfigProcessEventArgs } from "./index.ts";

const event = {
  type: "events.iterate.com/test/ping-sent",
  path: "/child",
  offset: 7,
  createdAt: "2026-09-28T00:00:00.000Z",
} as StreamEvent;

test("deliverEvent hands processEvent the event and the root in one round trip, releasing every call the handler made once it settles, even when it throws", async () => {
  const log: string[] = [];
  const handled: string[] = [];
  const entrypoint = configEntrypoint(log, async ({ event, itx }) => {
    handled.push(`${event.path}@${event.offset}`);
    await itx.cd(event.path).append({ type: "events.iterate.com/test/pong-sent" });
    expect(log).toEqual(["get", `cd(${event.path}).append`]); // nothing released mid-handler
    throw new Error("the handler failed");
  });
  await expect(entrypoint.deliverEvent(event)).rejects.toThrow("the handler failed");
  expect(handled).toEqual(["/child@7"]);
  expect(log).toEqual([
    "get",
    "cd(/child).append",
    "dispose cd(/child).append",
    "dispose cd(/child)",
    "dispose root",
  ]);
});

test("the defaults: an event is ignored and every request is not found", async () => {
  const log: string[] = [];
  const entrypoint = configEntrypoint(log);
  await entrypoint.deliverEvent(event);
  expect(log).toEqual(["get", "dispose root"]);
  expect(await entrypoint.fetch(new Request("https://project.example/"))).toMatchObject({
    status: 404,
  });
});

/** A config entrypoint over a fake `env.ITX` whose root logs each call and each release; `handler`
 *  overrides `processEvent` when given. */
function configEntrypoint(
  log: string[],
  handler?: (args: IterateConfigProcessEventArgs) => Promise<void>,
) {
  const step = (name: string): any => {
    const answer = Promise.resolve(undefined);
    return {
      then: answer.then.bind(answer),
      append: () => {
        log.push(`${name}.append`);
        return step(`${name}.append`);
      },
      [Symbol.dispose]: () => log.push(`dispose ${name}`),
    };
  };
  const root = {
    cd: (path: string) => step(`cd(${path})`),
    [Symbol.dispose]: () => log.push("dispose root"),
  };
  const env = {
    ITX: {
      get: () => {
        log.push("get");
        return root;
      },
    },
  };
  const entrypoint = new (class extends IterateConfigEntrypoint {
    override processEvent(args: IterateConfigProcessEventArgs) {
      return handler?.(args);
    }
  })({} as never, env as never);
  // the shim's base class keeps no constructor arguments; the runtime's sets `env` from them
  Object.assign(entrypoint, { env });
  return entrypoint;
}
