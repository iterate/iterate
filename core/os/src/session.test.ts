// session.test.ts — the platform-fact append's await-vs-best-effort split: a grant's end awaits
// `appendPlatformFacts` (the revocation truth: a failed append must fail the verb), and a sign-in's
// connection awaits it FOLDED (the answer implies the fold); the account's sign-ins and consents and
// an organization's activity go through `publishPlatformFacts`, best-effort in waitUntil: each fact
// is keyed, so an append the platform cut is sent once more (`ownerContext`, context-stub.ts) and
// lands once, and a second failure is reported.

import { expect, test, vi } from "vitest";
import type { ItxExpression } from "iterate/expression";
import type { StreamEventInput } from "iterate/stream/processor";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "./context/paths.ts";
import { appendPlatformFacts, publishPlatformFacts, SessionTeardown } from "./session.ts";
import { nodeSqliteStream } from "./stream/test-support.ts";

const fact = { type: "events.iterate.com/test/fact-appended", payload: {} };
const keyedFact = {
  type: "events.iterate.com/account/consent-approved",
  idempotencyKey: "account/consent-approved/grant_1",
  payload: { clientId: "c1", clientName: "c1", projects: null, scopes: [] },
};

test("appendPlatformFacts enables the owner's processor, then appends stamped platform — and a failed append rejects", async () => {
  const { namespace, calls, names } = failingAppendNamespace();
  await expect(
    appendPlatformFacts(namespace, { account: "u1" }, fact, { principal: null }),
  ).rejects.toThrow("append refused");
  expect(names).toEqual([globalName("/users/u1"), globalName("/users/u1")]); // a stub per call
  expect(calls).toEqual([
    [["itx", "builtins", "processors", ["enable", "account"]], [], { principal: null }],
    [["itx", "builtins", ["append", fact]], [], { principal: null, platform: true }],
  ]);
});

test("an organization's facts land on its own context, its processor enabled first", async () => {
  const { namespace, calls, names } = failingAppendNamespace();
  await expect(
    appendPlatformFacts(namespace, { organization: "org_1" }, [fact, fact], { principal: null }),
  ).rejects.toThrow("append refused");
  expect(names).toEqual([globalName("/organizations/org_1"), globalName("/organizations/org_1")]);
  expect(calls).toEqual([
    [["itx", "builtins", "processors", ["enable", "organization"]], [], { principal: null }],
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
    { account: "u1" },
    [fact, fact],
    { principal: null },
    { folded: true },
  );
  expect(calls.at(-1)).toEqual([
    ["itx", "builtins", "facets", ["get", "account"], ["waitUntilProcessed", { offset: 8 }]],
    [],
    { principal: null },
  ]);
});

test.for([
  {
    name: "a deploy's reset that cut the answer after the fact landed is sent again: the stream answers with the fact it holds",
    failures: [{ failure: "deploy reset", afterLanding: true }],
    landed: 1,
    lines: [
      [
        "info",
        appendLine("session.deploy-reset-retry", "deploy-reset", {
          message: "Error: Durable Object reset because its code was updated.",
          attempt: 1,
          retryInMs: 0,
        }),
      ],
    ],
    reported: undefined,
  },
  {
    name: "a lost connection that cut the append before it landed is sent again and lands it",
    failures: [{ failure: "connection lost", afterLanding: false }],
    landed: 1,
    lines: [
      [
        "warn",
        appendLine("session.platform-failure-retry", "disconnected", {
          message: "Error: Network connection lost.",
          attempt: 1,
          retryInMs: 0,
        }),
      ],
    ],
    reported: undefined,
  },
  {
    name: "a second cut is reported, never dropped",
    failures: [
      { failure: "connection lost", afterLanding: false },
      { failure: "connection lost", afterLanding: false },
    ],
    landed: 0,
    lines: [
      [
        "warn",
        appendLine("session.platform-failure-retry", "disconnected", {
          message: "Error: Network connection lost.",
          attempt: 1,
          retryInMs: 0,
        }),
      ],
      [
        "warn",
        appendLine("session.platform-failure-gave-up", "disconnected", {
          message: "Error: Network connection lost.",
          attempts: 2,
        }),
      ],
    ],
    reported: "Network connection lost.",
  },
  {
    name: "a refusal is reported at once",
    failures: [{ failure: "refusal", afterLanding: false }],
    landed: 0,
    lines: [],
    reported: "append refused",
  },
] satisfies {
  name: string;
  failures: { failure: Failure; afterLanding: boolean }[];
  landed: number;
  lines: [string, object][];
  reported: string | undefined;
}[])("publishPlatformFacts: $name", async ({ failures, landed, lines, reported }) => {
  const logged: [string, unknown][] = [];
  vi.spyOn(console, "info").mockImplementation((line) => void logged.push(["info", line]));
  vi.spyOn(console, "warn").mockImplementation((line) => void logged.push(["warn", line]));
  const issue = vi.spyOn(console, "error").mockImplementation(() => {});
  const { stream, events } = nodeSqliteStream();
  const left = [...failures];
  const invoke = vi.fn(async (expression: ItxExpression) => {
    const [verb, ...appended] = expression[2] as [string, ...StreamEventInput[]];
    if (verb !== "append") return; // the owner's processor enable
    const cut = left.shift();
    if (cut && !cut.afterLanding) throw platformError(cut.failure);
    const answer = stream.append(...appended);
    if (cut) throw platformError(cut.failure);
    return answer;
  });
  const getByName = vi.fn(() => ({ invoke }));
  const pending: Promise<unknown>[] = [];
  publishPlatformFacts(
    {
      // The fake namespace answers the one method the append calls on it.
      contextNamespace: { getByName } as unknown as Parameters<typeof appendPlatformFacts>[0],
      waitUntil: (promise) => void pending.push(promise),
    },
    { account: "u1" },
    keyedFact,
    { principal: null },
  );
  expect(pending).toHaveLength(1);
  await expect(pending[0]).resolves.toBeUndefined();
  expect(events.map((event) => event.idempotencyKey)).toEqual(
    Array.from({ length: landed }, () => keyedFact.idempotencyKey),
  );
  // the enable, then each append on a fresh stub
  const retries = lines.filter(([, line]) => "retryInMs" in line).length;
  expect(getByName).toHaveBeenCalledTimes(2 + retries);
  // Exact: the lines are the prd fault alarm's input.
  expect(logged).toEqual(lines);
  expect(issue.mock.calls.map(([line]) => line)).toEqual(
    reported
      ? [
          expect.objectContaining({
            event: "issue",
            failureSite: "session.platform-fact-not-recorded",
            path: "/users/u1",
            type: keyedFact.type,
            error: expect.objectContaining({ message: reported }),
          }),
        ]
      : [],
  );
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
function failingAppendNamespace() {
  const calls: unknown[][] = [];
  const names: string[] = [];
  const context = {
    invoke: async (...args: unknown[]) => {
      calls.push(args);
      if (calls.length === 2) throw new Error("append refused");
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

type Failure = "deploy reset" | "connection lost" | "refusal";

/** Each failure as workerd hands it to the caller: a DISCONNECTED one stamped `retryable`, a
 *  deploy's also `durableObjectReset`; the callee's own refusal carries neither. */
function platformError(failure: Failure): Error {
  if (failure === "deploy reset")
    return Object.assign(new Error("Durable Object reset because its code was updated."), {
      retryable: true,
      durableObjectReset: true,
    });
  if (failure === "connection lost")
    return Object.assign(new Error("Network connection lost."), { retryable: true });
  return new Error("append refused");
}

/** A line the keyed append's repeat, or giving up on it, logs. */
function appendLine(event: string, kind: string, fields: object) {
  return {
    event,
    kind,
    name: "itx.builtins.append",
    projectId: "global",
    path: "/users/u1",
    ...fields,
  };
}
