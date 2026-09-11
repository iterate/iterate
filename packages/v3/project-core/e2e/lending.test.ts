import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RpcTarget } from "capnweb";
import type { Scope } from "../src/types.ts";
import { base, eventually, project, session, sleep, timeout } from "./support.ts";

class Greeting extends RpcTarget {
  readonly calls: string[] = [];

  greet(name: string): string {
    this.calls.push(name);
    return `hello ${name}`;
  }
}

describe(
  "project core live capability lending",
  { concurrency: false, skip: !base && "set WORKER_BASE_URL to the running Worker" },
  () => {
    test(
      "pages a first client's callback for a second client and through a dynamic worker",
      { timeout },
      async () => {
        const id = project("lending");
        using first = session<Scope>(id);
        using second = session<Scope>(id);
        assert.equal(await (first as unknown as { env: Promise<unknown> }).env, undefined);
        const greeting = new Greeting();
        using _mount = await first.provide("greeting", greeting);

        assert.equal(await second.invoke(["greeting", "greet"], "Ada"), "hello Ada");
        assert.deepEqual(greeting.calls, ["Ada"]);

        const source = `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Bridge extends WorkerEntrypoint {
  async greet(name) {
    return (await this.env.ITX.get()).invoke(["greeting", "greet"], name);
  }
}`;
        await second.append({
          id: crypto.randomUUID(),
          type: "itx.set",
          data: {
            key: "mount/bridge",
            value: { kind: "worker", source: { modules: { "main.js": source } } },
          },
        });
        assert.equal(await second.invoke(["bridge", "greet"], "Bea"), "hello Bea");
        assert.deepEqual(greeting.calls, ["Ada", "Bea"]);

        await sleep(6_000);
        assert.equal(
          (await second.inspect()).lending.borrowed,
          0,
          "the context did not release its borrowed native callback at idle",
        );
        assert.equal(await second.invoke(["greeting", "greet"], "Cy"), "hello Cy");
        assert.deepEqual(greeting.calls, ["Ada", "Bea", "Cy"]);
      },
    );

    test(
      "removes a disposed mount and stops a subscription disposed while its callback is in flight",
      { timeout },
      async () => {
        const id = project("lending");
        using owner = session<Scope>(id);
        using caller = session<Scope>(id);
        using mount = await owner.provide("ephemeral", new Greeting());
        assert.equal(await caller.invoke(["ephemeral", "greet"], "Ada"), "hello Ada");
        mount[Symbol.dispose]();
        await eventually(
          async () =>
            !(await caller.inspect()).settings.some((setting) => setting.key === "mount/ephemeral"),
          "the detached callback mount remained installed",
        );

        const afterOffset = (await caller.inspect()).head;
        let pages = 0;
        let delivered!: () => void;
        const firstPage = new Promise<void>((resolve) => {
          delivered = resolve;
        });
        let release!: () => void;
        const inFlight = new Promise<void>((resolve) => {
          release = resolve;
        });
        const subscription = await owner.subscribe(
          async () => {
            pages++;
            delivered();
            await inFlight;
          },
          { afterOffset },
        );
        await caller.append({ id: crypto.randomUUID(), type: "note", data: { sequence: 1 } });
        await firstPage; // The enclosing test owns the delivery deadline.
        subscription[Symbol.dispose]();
        release();
        await caller.append({ id: crypto.randomUUID(), type: "note", data: { sequence: 2 } });
        await sleep(300);
        assert.equal(pages, 1);
      },
    );
  },
);
