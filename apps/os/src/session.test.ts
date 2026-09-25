// session.test.ts — the platform-fact append's await-vs-best-effort split: a grant's end awaits
// `appendPlatformFacts` (the revocation truth: a failed append must fail the verb), and the
// organization verbs await it FOLDED (the answer implies the fold); the account's sign-ins, mints and
// consents go through `publishPlatformFacts`, best-effort in waitUntil: a deploy's cut is a warning,
// any other failure is reported.

import { expect, test, vi } from "vitest";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "./context/paths.ts";
import { appendPlatformFacts, publishPlatformFacts, SessionTeardown } from "./session.ts";

const fact = { type: "events.iterate.com/test/fact-appended", payload: {} };

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

test("appendPlatformFacts `folded` waits on the owner's processor barrier through the last appended offset", async () => {
  const calls: unknown[][] = [];
  const context = {
    invoke: async (...args: unknown[]) => {
      calls.push(args);
      if (calls.length === 2) return [{ offset: 7 }, { offset: 8 }];
    },
  };
  const namespace = { getByName: () => context } as unknown as Parameters<
    typeof appendPlatformFacts
  >[0];
  await appendPlatformFacts(
    namespace,
    { organization: "org_1" },
    [fact, fact],
    { principal: null },
    { folded: true },
  );
  expect(calls.at(-1)).toEqual([
    ["itx", "facets", ["get", "organization"], ["waitUntilProcessed", { offset: 8 }]],
    [],
    { principal: null },
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

// SessionTeardown, the lease: a handle disposes only what it registered.

test("re-adding a key replaces (the incumbent is disposed once); a STALE lease's dispose is inert; the current lease's disposes", () => {
  const log: string[] = [];
  const teardown = new SessionTeardown();
  const first = teardown.add("k", undo(log, "first"));
  const second = teardown.add("k", undo(log, "second"));
  expect(log).toEqual(["first"]); // replaced ⇒ disposed at replacement
  first.dispose();
  expect(log).toEqual(["first"]); // the stale handle touched nothing — its replacement lives
  second.dispose();
  expect(log).toEqual(["first", "second"]);
  second.dispose();
  expect(log).toEqual(["first", "second"]); // idempotent
});

test("the session's own dispose(key) takes whatever is current; disposeAll takes everything once", () => {
  const log: string[] = [];
  const teardown = new SessionTeardown();
  teardown.add("a", undo(log, "a"));
  const b = teardown.add("b", undo(log, "b"));
  teardown.dispose("a");
  expect(log).toEqual(["a"]);
  teardown.disposeAll();
  expect(log).toEqual(["a", "b"]);
  b.dispose();
  expect(log).toEqual(["a", "b"]);
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

const undo = (log: string[], label: string) => ({ dispose: () => void log.push(label) });
