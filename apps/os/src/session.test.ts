// session.test.ts — the platform-fact append's await-vs-best-effort split: a grant's end awaits
// `appendPlatformFacts` (the revocation truth: a failed append must fail the verb); every other fact
// goes through `publishPlatformFacts`, best-effort in waitUntil: a deploy's cut is a warning, any
// other failure is reported.

import { expect, test, vi } from "vitest";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "./context/paths.ts";
import { appendPlatformFacts, publishPlatformFacts } from "./session.ts";

const fact = { type: "events.iterate.com/account/test", payload: {} };

test("appendPlatformFacts enables the owner's processor, then appends stamped platform — and a failed append rejects", async () => {
  const { namespace, calls, names } = failingAppendNamespace();
  await expect(
    appendPlatformFacts(namespace, { account: "u1" }, fact, { principal: null }),
  ).rejects.toThrow("append refused");
  expect(names).toEqual([globalName("/users/u1")]);
  expect(calls).toEqual([
    [["itx", "processors", ["enable", "account"]], [], { principal: null }],
    [["itx", "builtins", ["append", fact]], [], { principal: null, platform: true }],
  ]);
});

test("an organization's facts land on its own context, folded by the organization processor", async () => {
  const { namespace, calls, names } = failingAppendNamespace();
  await expect(
    appendPlatformFacts(namespace, { organization: "org_1" }, [fact, fact], { principal: null }),
  ).rejects.toThrow("append refused");
  expect(names).toEqual([globalName("/organizations/org_1")]);
  expect(calls).toEqual([
    [["itx", "processors", ["enable", "organization"]], [], { principal: null }],
    [["itx", "builtins", ["append", fact, fact]], [], { principal: null, platform: true }],
  ]);
});

test("publishPlatformFacts hands waitUntil a promise that resolves and reports when the append fails", async () => {
  const issue = vi.spyOn(console, "error").mockImplementation(() => {});
  const { namespace } = failingAppendNamespace();
  const pending: Promise<unknown>[] = [];
  publishPlatformFacts(
    { contextNamespace: namespace, waitUntil: (promise) => void pending.push(promise) },
    { account: "u1" },
    fact,
    { principal: null },
  );
  expect(pending).toHaveLength(1);
  await expect(pending[0]).resolves.toBeUndefined();
  expect(issue).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "issue",
      failureSite: "session.platform-fact-not-recorded",
      path: "/users/u1",
      types: fact.type,
    }),
  );
  issue.mockRestore();
});

test("publishPlatformFacts warns, not reports, when a deploy's reset cuts the append at the transport", async () => {
  const issue = vi.spyOn(console, "error").mockImplementation(() => {});
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { namespace } = failingAppendNamespace(
    Object.assign(new Error("Durable Object reset because its code was updated."), {
      retryable: true,
      durableObjectReset: true,
    }),
  );
  const pending: Promise<unknown>[] = [];
  publishPlatformFacts(
    { contextNamespace: namespace, waitUntil: (promise) => void pending.push(promise) },
    { organization: "org_1" },
    fact,
    { principal: null },
  );
  await expect(pending[0]).resolves.toBeUndefined();
  expect(issue).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "session.platform-fact-cut",
      path: "/organizations/org_1",
      types: fact.type,
    }),
  );
  issue.mockRestore();
  warning.mockRestore();
});

const globalName = (path: string) =>
  DurableObjectNameCodec.stringify({ projectId: GLOBAL_PROJECT_ID, path });

/** A context namespace whose append (the second `invoke`, after the processor enable) rejects. */
function failingAppendNamespace(failure: Error = new Error("append refused")) {
  const calls: unknown[][] = [];
  const names: string[] = [];
  const context = {
    invoke: async (...args: unknown[]) => {
      calls.push(args);
      if (calls.length === 2) throw failure;
    },
  };
  const namespace = {
    getByName: (name: string) => {
      names.push(name);
      return context;
    },
  } as unknown as Parameters<typeof appendPlatformFacts>[0];
  return { namespace, calls, names };
}
