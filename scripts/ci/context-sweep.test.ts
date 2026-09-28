// The context sweep's decisions (scripts/ci/context-sweep.ts): what each stored object is, that an
// orphan is destroyed only once its whole log is in the CI bucket, that a deploy's reset mid-sweep
// is asked again rather than failing the run, and where each run's result is posted. Cloudflare's listing, the session and R2 are the script's IO, left out.
import { expect, test } from "vitest";
import type { StreamPage } from "iterate/api";
import type { IterateConnection } from "iterate/node";
import {
  backUpAndDestroy,
  classifyContexts,
  reconnecting,
  sweepMessages,
  type SweptContext,
} from "./context-sweep.ts";

test.for<{ name: string; contexts: SweptContext[]; expected: object }>([
  {
    name: "a live project's context is left alone",
    contexts: [context("a", "prj_live")],
    expected: { live: ["a"] },
  },
  {
    name: "a global context is never swept",
    contexts: [context("g", "global", "/users/u1")],
    expected: { global: ["g"] },
  },
  {
    name: "a context of a project the control plane does not hold is an orphan",
    contexts: [context("o", "prj_gone", "/agents/x")],
    expected: { orphans: [context("o", "prj_gone", "/agents/x")] },
  },
  {
    name: "one with no birth record was just destroyed (Cloudflare's list catches up in minutes): emptied, not a failure",
    contexts: [{ id: "e", error: "Error: … by id, only a context that was born answers." }],
    expected: { emptied: ["e"] },
  },
  {
    name: "one that could not say who it is is reported, never destroyed",
    contexts: [{ id: "u", error: "must be addressed by name" }],
    expected: { unidentified: [{ id: "u", error: "must be addressed by name" }] },
  },
])("$name", ({ contexts, expected }) => {
  expect(classifyContexts(contexts, new Set(["prj_live"]))).toEqual({
    live: [],
    global: [],
    orphans: [],
    emptied: [],
    unidentified: [],
    ...expected,
  });
});

test.for<{
  name: string;
  failing?: "put" | "destroy" | "deploy-reset" | "landed-destroy";
  newestAt?: string;
  expected: object;
}>([
  {
    name: "an orphan's identity and whole log, read a page at a time, land in the bucket before it is destroyed",
    expected: {
      calls: ["read o 0", "read o 2", "put backups/run/o.jsonl", "destroy o"],
      backups: { "backups/run/o.jsonl": [identity("o"), event(1), event(2), event(5)] },
      result: { destroyed: ["o"], recent: [], failed: [] },
    },
  },
  {
    name: "a read that a deploy's reset failed is asked again, and the orphan is still swept",
    failing: "deploy-reset",
    expected: {
      calls: ["read o 0", "read o 0", "read o 2", "put backups/run/o.jsonl", "destroy o"],
      backups: { "backups/run/o.jsonl": [identity("o"), event(1), event(2), event(5)] },
      result: { destroyed: ["o"], recent: [], failed: [] },
    },
  },
  {
    name: "a destruction asked again after its first try landed answers EMPTIED: destroyed",
    failing: "landed-destroy",
    expected: {
      calls: ["read o 0", "read o 2", "put backups/run/o.jsonl", "destroy o", "destroy o"],
      backups: { "backups/run/o.jsonl": [identity("o"), event(1), event(2), event(5)] },
      result: { destroyed: ["o"], recent: [], failed: [] },
    },
  },
  {
    name: "an orphan written in the last hour (a running test's) is neither backed up nor destroyed",
    newestAt: "2026-09-28T02:30:00.000Z",
    expected: {
      calls: ["read o 0", "read o 2"],
      backups: {},
      result: { destroyed: [], recent: ["o"], failed: [] },
    },
  },
  {
    name: "an orphan whose backup did not land is left standing, and the next one is still swept",
    failing: "put",
    expected: {
      calls: [
        ...["read o 0", "read o 2", "put backups/run/o.jsonl"],
        ...["read p 0", "read p 2", "put backups/run/p.jsonl", "destroy p"],
      ],
      backups: { "backups/run/p.jsonl": [identity("p"), event(1), event(2), event(5)] },
      result: { destroyed: ["p"], recent: [], failed: [{ id: "o", error: "Error: R2 PUT 500" }] },
    },
  },
  {
    name: "an orphan whose destruction failed is named, its backup kept",
    failing: "destroy",
    expected: {
      calls: ["read o 0", "read o 2", "put backups/run/o.jsonl", "destroy o"],
      backups: { "backups/run/o.jsonl": [identity("o"), event(1), event(2), event(5)] },
      result: { destroyed: [], recent: [], failed: [{ id: "o", error: "Error: FORBIDDEN" }] },
    },
  },
])("$name", async ({ failing, newestAt, expected }) => {
  const calls: string[] = [];
  const backups: Record<string, unknown[]> = {};
  let reset = failing === "deploy-reset";
  let destroys = 0;
  const result = await backUpAndDestroy({
    orphans: [identity("o"), ...(failing === "put" ? [identity("p")] : [])],
    contexts: {
      readEvents: async (id, afterOffset) => {
        calls.push(`read ${id} ${afterOffset}`);
        if (reset) {
          reset = false;
          throw new Error("Durable Object reset because its code was updated.");
        }
        return page(afterOffset, newestAt);
      },
      destroy: async (id) => {
        calls.push(`destroy ${id}`);
        if (failing === "destroy") throw new Error("FORBIDDEN");
        // the first try landed, its answer lost to a dropped socket
        if (failing === "landed-destroy" && destroys++ === 0)
          throw new Error("Peer closed WebSocket: 1006 ");
        if (failing === "landed-destroy")
          throw new Error("Error: … by id, only a context that was born answers.");
        return { projectId: "prj_gone", path: "/" };
      },
    },
    putBackup: async (key, body) => {
      calls.push(`put ${key}`);
      if (failing === "put" && key.endsWith("/o.jsonl")) throw new Error("R2 PUT 500");
      backups[key] = new TextDecoder()
        .decode(body)
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
    prefix: "backups/run/",
    now: () => Date.parse("2026-09-28T03:00:00.000Z"),
  });
  expect({ calls, backups, result }).toEqual(expected);
});

test("a session whose socket closed and whose first reconnect failed is connected again, and the orphan is still swept", async () => {
  const calls: string[] = [];
  let connects = 0;
  let closeFirst = () => {};
  const session = await reconnecting(async () => {
    const n = ++connects;
    calls.push(`connect ${n}`);
    if (n === 2) throw new Error("Unexpected server response: 503");
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      if (n === 1) closeFirst = () => resolve({ code: 1006, reason: "" });
    });
    const contexts = {
      readEvents: async (id: string, afterOffset: number) => {
        calls.push(`read ${id} ${afterOffset} on ${n}`);
        return page(afterOffset);
      },
      destroy: async (id: string) => {
        calls.push(`destroy ${id} on ${n}`);
        return { projectId: "prj_gone", path: "/" };
      },
    };
    return {
      session: { contexts },
      closed,
      [Symbol.dispose]: () => calls.push(`dispose ${n}`),
    } as unknown as IterateConnection;
  });
  closeFirst();
  await Promise.resolve();
  const result = await backUpAndDestroy({
    orphans: [identity("o")],
    contexts: {
      readEvents: async (id, afterOffset) =>
        (await session.session()).contexts.readEvents(id, afterOffset),
      destroy: async (id) => (await session.session()).contexts.destroy(id),
    },
    putBackup: async () => {},
    prefix: "backups/run/",
    now: () => Date.parse("2026-09-28T03:00:00.000Z"),
  });
  expect({ calls, result }).toEqual({
    calls: [
      "connect 1",
      "dispose 1",
      "connect 2",
      "connect 3",
      "read o 0 on 3",
      "read o 2 on 3",
      "destroy o on 3",
    ],
    result: { destroyed: ["o"], recent: [], failed: [] },
  });
});

const report = {
  env: "prd",
  stored: 172,
  live: 111,
  global: 18,
  orphans: 43,
  emptied: 0,
  unidentified: 0,
  destroyed: 0,
  recent: 0,
  destroyFailed: 0,
};
const run = { refName: "main", runUrl: "https://depot.dev/run" };

test.for([
  {
    name: "a report-only run is routine, in #ci alone",
    messages: sweepMessages({ ...run, result: "success", report: { ...report, orphans: 0 } }),
    expected: [
      {
        channel: "C0B3QJSU32A",
        text: "🧹 Context sweep of prd on main: 172 stored, 111 live, 18 global, 0 orphans\n<https://depot.dev/run|View the Depot job>",
      },
    ],
  },
  {
    name: "a run that destroyed orphans is routine too (the crash hunt leaves some every night): #ci alone, naming the backups",
    messages: sweepMessages({
      ...run,
      result: "success",
      report: {
        ...report,
        destroyed: 41,
        recent: 2,
        backups: "r2://iterate-ci/backups/context-sweep/prd/r/",
      },
    }),
    expected: [
      {
        channel: "C0B3QJSU32A",
        text: "🧹 Context sweep of prd on main: 172 stored, 111 live, 18 global, 43 orphans; 41 orphans destroyed, each backed up first to r2://iterate-ci/backups/context-sweep/prd/r/; 2 orphans active in the last hour, left for the next run\n<https://depot.dev/run|View the Depot job>",
      },
    ],
  },
  {
    name: "a run that failed posts to #ci and pages #error-pulse with what failed",
    messages: sweepMessages({
      ...run,
      result: "failure",
      report: { ...report, unidentified: 1, destroyed: 41, destroyFailed: 1, backups: "r2://b/" },
    }),
    expected: [
      {
        channel: "C0B3QJSU32A",
        text: "🚨 Context sweep of prd on main (failure): 172 stored, 111 live, 18 global, 43 orphans; 1 could not say who they are; 41 orphans destroyed, each backed up first to r2://b/; 1 orphans not destroyed\n<https://depot.dev/run|View the Depot job>",
      },
      {
        channel: "C09K1CTN4M7",
        text: "🚨 Context sweep of prd on main (failure): 172 stored, 111 live, 18 global, 43 orphans; 1 could not say who they are; 41 orphans destroyed, each backed up first to r2://b/; 1 orphans not destroyed <@U067G4QRFK2> <@U099JH9TAF2>\n<https://depot.dev/run|View the Depot job>",
      },
    ],
  },
  {
    name: "a run that ended before its report still posts to both",
    messages: sweepMessages({ ...run, result: "cancelled", report: undefined }),
    expected: [
      {
        channel: "C0B3QJSU32A",
        text: "🚨 Context sweep on main (cancelled): it failed before its report\n<https://depot.dev/run|View the Depot job>",
      },
      {
        channel: "C09K1CTN4M7",
        text: "🚨 Context sweep on main (cancelled): it failed before its report <@U067G4QRFK2> <@U099JH9TAF2>\n<https://depot.dev/run|View the Depot job>",
      },
    ],
  },
])("$name", ({ messages, expected }) => {
  // exact: a stray mention on a routine post, or a missing one on a page, must fail
  expect(messages).toEqual(expected);
});

function context(id: string, projectId: string, path = "/"): SweptContext {
  return { id, projectId, path };
}

function identity(id: string) {
  return { id, projectId: "prj_gone", path: "/" };
}

/** The log offsets 1, 2 and 5 (3 and 4 were ephemerals), in two pages: the first cut after 2. The
 *  newest, 5, written at `newestAt`. */
function page(afterOffset: number, newestAt?: string): StreamPage {
  return afterOffset === 0
    ? { events: [event(1), event(2)], scannedThroughOffset: 2, atHead: false }
    : { events: [event(5, newestAt)], scannedThroughOffset: 5, atHead: true };
}

function event(offset: number, createdAt = "2026-09-28T00:00:00.000Z") {
  return { type: "events.iterate.com/test/marker", payload: {}, offset, path: "/", createdAt };
}
