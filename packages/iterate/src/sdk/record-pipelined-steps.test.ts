// record-pipelined-steps.test.ts — `withItx` disposes what this records, so it must record EVERY call a
// round trip reached (the undisposed `itx.cd(path)` of `itx.cd(path).append(…)` kept facet → ItxEntrypoint
// → context resident until the next deploy, 2026-09-21/22; without this, the facet itself kept running,
// billed, 2026-09-23) and change nothing else about the stub.
import { expect, test, vi } from "vitest";
import { recordPipelinedSteps, withItx } from "./record-pipelined-steps.ts";

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
  const answered = await withItx({ get: () => fakeStub(log) }, async (itx) => {
    const value = await run(itx);
    expect(log).toEqual([]); // recording disposes nothing itself
    return value;
  });
  expect(answered).toEqual(answer);
  expect(log).toEqual(disposed);
});

test("a release that throws is reported, the rest are still released and the answer stands", async () => {
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
  try {
    const answered = await withItx({ get: () => itx }, (scope: any) =>
      scope.cd("/d").append({ type: "y" }),
    );
    expect(answered).toEqual({ appended: [{ type: "y" }] });
    expect(log).toEqual(["dispose cd(/d).append", "dispose cd(/d)"]);
    expect(reported).toHaveBeenCalled();
  } finally {
    reported.mockRestore();
  }
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
