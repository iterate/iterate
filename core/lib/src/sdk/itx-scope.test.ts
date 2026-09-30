// itx-scope.test.ts — `itxScope`'s release disposes what `recordPipelinedSteps` records, so it must
// record EVERY call a scope reached and change nothing else about the stub (itx-scope.ts says why).
import { expect, test, vi } from "vitest";
import { runCausedBy } from "../cause.ts";
import { itxScope, recordPipelinedSteps } from "./itx-scope.ts";

test.for([
  {
    name: "a pipelined chain records the intermediate and the final call",
    run: (itx: any) => itx.cd("/a").append({ type: "x" }),
    answer: { appended: [{ type: "x" }] },
    disposed: ["dispose cd(/a).append", "dispose cd(/a)"],
  },
  {
    name: "a property path before the call is not a step; the calls are",
    run: (itx: any) => itx.repos.get("/repos/r").whoami(),
    answer: { path: "repos.get(/repos/r)" },
    disposed: ["dispose repos.get(/repos/r).whoami", "dispose repos.get(/repos/r)"],
  },
  {
    name: "an intermediate held across awaits (the collection's `const context = itx.cd(path)`)",
    run: async (itx: any) => {
      const context = itx.cd("/b");
      await context.whoami();
      return context.append("e");
    },
    answer: { appended: ["e"] },
    disposed: ["dispose cd(/b).append", "dispose cd(/b).whoami", "dispose cd(/b)"],
  },
  {
    name: "an awaited handle, and a call made on it, are released",
    run: async (itx: any) => {
      const repo = await itx.open("/r");
      return await repo.whoami();
    },
    answer: { path: "handle(/r)" },
    disposed: ["dispose handle(/r).whoami", "dispose handle(/r)", "dispose open(/r)"],
  },
  {
    name: "awaited plain data is handed back as it is, so it still copies across RPC",
    run: async (itx: any) => {
      const answer = await itx.cd("/p").whoami();
      expect(answer).toStrictEqual({ path: "cd(/p)" });
      return answer;
    },
    answer: { path: "cd(/p)" },
    disposed: ["dispose cd(/p).whoami", "dispose cd(/p)"],
  },
])("$name", async ({ run, answer, disposed }) => {
  const log: string[] = [];
  {
    using itx = itxScope({ get: () => fakeStub(log) });
    expect(await run(itx)).toEqual(answer);
    expect(log).toEqual([]); // recording disposes nothing itself
  }
  expect(log).toEqual(disposed);
});

test("`using itx = itxScope(…)` gets the scope under the running cause and releases it, and every call made through it, the last first, as the block ends", async () => {
  const log: string[] = [];
  const causes: unknown[] = [];
  const cause = { chain: "a test's chain", depth: 2 };
  const entrypoint = {
    get: (asked?: unknown) => {
      causes.push(asked);
      return Object.assign(fakeStub(log), { [Symbol.dispose]: () => log.push("dispose root") });
    },
  };
  await runCausedBy(cause, async () => {
    using itx: any = itxScope(entrypoint);
    const repo = await itx.open("/r");
    await repo.whoami();
    await itx.cd("/a").append({ type: "x" });
    expect(log).toEqual([]);
  });
  expect(causes).toEqual([cause]);
  expect(log).toEqual([
    "dispose cd(/a).append",
    "dispose cd(/a)",
    "dispose handle(/r).whoami",
    "dispose handle(/r)",
    "dispose open(/r)",
    "dispose root",
  ]);
});

test("a release that throws is reported, the rest are still released and the block ends without its throw", async () => {
  const log: string[] = [];
  const stub = fakeStub(log);
  const itx = {
    ...stub,
    cd: (path: string) =>
      Object.assign(stub.cd(path), {
        [Symbol.dispose]: () => {
          log.push(`dispose cd(${path})`);
          throw new Error(`cd(${path}) already gone`);
        },
      }),
  };
  const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
  {
    using scope: any = itxScope({ get: () => itx });
    expect(await scope.cd("/d").append({ type: "y" })).toEqual({ appended: [{ type: "y" }] });
  }
  expect(log).toEqual(["dispose cd(/d).append", "dispose cd(/d)"]);
  expect(reported).toHaveBeenCalled();
});

test("a void call is recorded as undefined and a recorded argument crosses as the value it wraps", () => {
  const steps: unknown[] = [];
  const itx: any = recordPipelinedSteps(fakeStub([]), steps);
  expect(itx.nothing()).toBeUndefined();
  const context = itx.cd("/c");
  const echoed = itx.echo(context);
  expect(steps[1]).toBe(steps[2]); // echo got the unwrapped cd(/c) step, and answered it back
  expect(echoed).not.toBe(steps[1]); // …which the caller sees recorded again
  expect(steps[0]).toBeUndefined();
});

/** A stand-in for a Workers-RPC stub: each call answers a disposable promise-like step that pipelines
 *  further calls, and remembers whether it was disposed. */
function fakeStub(log: string[]) {
  const step = (name: string, value: unknown): any => {
    const answer = Promise.resolve(value);
    return Object.assign(
      {
        then: answer.then.bind(answer),
        [Symbol.dispose]: () => log.push(`dispose ${name}`),
      },
      {
        append: (...events: unknown[]) => step(`${name}.append`, { appended: events }),
        whoami: () => step(`${name}.whoami`, { path: name }),
      },
    );
  };
  // A stub a call answers once awaited: callable, as workerd's and capnweb's stubs are.
  const handle = (name: string) =>
    Object.assign(() => undefined, {
      whoami: () => step(`${name}.whoami`, { path: name }),
      [Symbol.dispose]: () => log.push(`dispose ${name}`),
    });
  return {
    cd: (path: string) => step(`cd(${path})`, undefined),
    open: (path: string) => step(`open(${path})`, handle(`handle(${path})`)),
    repos: { get: (path: string) => step(`repos.get(${path})`, undefined) },
    echo: (arg: unknown) => arg,
    nothing: () => undefined,
  };
}
