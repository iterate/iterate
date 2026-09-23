// record-pipelined-steps.test.ts — `withItx` disposes what this records, so it must record EVERY call a
// round trip reached (the undisposed `itx.cd(path)` of `itx.cd(path).append(…)` kept facet → ItxEntrypoint
// → context resident until the next deploy, 2026-09-21/22) and change nothing else about the stub.
import { describe, expect, test } from "vitest";
import { recordPipelinedSteps } from "./record-pipelined-steps.ts";

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
  return {
    cd: (path: string) => step(`cd(${path})`, undefined),
    repos: { get: (path: string) => step(`repos.get(${path})`, undefined) },
    echo: (arg: unknown) => arg,
    nothing: () => undefined,
  };
}

describe("recordPipelinedSteps", () => {
  test.each([
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
  ])("$name", async ({ run, answer, disposed }) => {
    const log: string[] = [];
    const steps: unknown[] = [];
    expect(await run(recordPipelinedSteps(fakeStub(log), steps))).toEqual(answer);
    expect(log).toEqual([]); // recording disposes nothing itself
    for (const step of steps.reverse())
      (step as Partial<Disposable> | undefined)?.[Symbol.dispose]?.();
    expect(log).toEqual(disposed);
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
});
