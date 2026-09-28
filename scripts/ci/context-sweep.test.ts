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
  sweepPosts,
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

test("a session whose socket closed and whose first reconnect failed is connected again, the orphan is still swept, and the last connection is disposed once", async () => {
  const calls: string[] = [];
  let connects = 0;
  const close: Record<number, () => void> = {};
  const session = await reconnecting(async () => {
    const n = ++connects;
    calls.push(`connect ${n}`);
    if (n === 2) throw new Error("Unexpected server response: 503");
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      close[n] = () => resolve({ code: 1006, reason: "" });
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
  close[1]!();
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
  // the sweep's end: its dispose closes the socket, whose close must not dispose it again
  session[Symbol.dispose]();
  close[3]!();
  await Promise.resolve();
  expect({ calls, result }).toEqual({
    calls: [
      "connect 1",
      "dispose 1",
      "connect 2",
      "connect 3",
      "read o 0 on 3",
      "read o 2 on 3",
      "destroy o on 3",
      "dispose 3",
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
const run = { runUrl: "https://depot.dev/run", testRun: false };
test.for([
  {
    name: "a report-only run is one #ci line and no page",
    posts: sweepPosts({ ...run, result: "success", report }),
    expected: {
      result:
        "🧹 context sweep of prd: 172 objects: 111 live, 18 global, 43 orphans (report-only) · <https://depot.dev/run|run>",
      page: undefined,
    },
  },
  {
    name: "a run that destroyed orphans is routine (the crash hunt leaves some every night): no page",
    posts: sweepPosts({
      ...run,
      result: "success",
      report: { ...report, destroyed: 41, recent: 2, emptied: 3, backups: "r2://b/prd/r/" },
    }),
    expected: {
      result:
        "🧹 context sweep of prd: 172 objects: 111 live, 18 global, 43 orphans (41 destroyed, 2 recent), 3 emptied · <https://depot.dev/run|run>",
      page: undefined,
    },
  },
  {
    name: "a run that failed is a #ci line and a page naming what failed",
    posts: sweepPosts({
      ...run,
      result: "failure",
      report: { ...report, unidentified: 1, destroyed: 41, destroyFailed: 1, backups: "r2://b/" },
    }),
    expected: {
      result:
        "🚨 context sweep failed on prd: 172 objects: 111 live, 18 global, 43 orphans (41 destroyed, 1 not destroyed), 1 unidentified · <https://depot.dev/run|run>",
      page: failedPage(
        "context sweep failed on prd: 1 object(s) could not say who they are, 1 orphan(s) not destroyed",
      ),
    },
  },
  {
    name: "a run that timed out after its report pages with how it ended",
    posts: sweepPosts({ ...run, result: "cancelled", report }),
    expected: {
      result:
        "🚨 context sweep failed on prd (cancelled): 172 objects: 111 live, 18 global, 43 orphans (report-only) · <https://depot.dev/run|run>",
      page: failedPage("context sweep failed on prd: the job ended cancelled"),
    },
  },
  {
    name: "a run that ended before its report still posts and pages",
    posts: sweepPosts({ ...run, result: "cancelled", report: undefined }),
    expected: {
      result: "🚨 context sweep failed before its report (cancelled) · <https://depot.dev/run|run>",
      page: failedPage("context sweep failed before its report (cancelled)"),
    },
  },
  {
    name: "a job that succeeded without writing its report pages all the same",
    posts: sweepPosts({ ...run, result: "success", report: undefined }),
    expected: {
      result: "🚨 context sweep failed before its report (success) · <https://depot.dev/run|run>",
      page: failedPage("context sweep failed before its report (success)"),
    },
  },
  {
    name: "a test run is 🧪 and its page mentions nobody",
    posts: sweepPosts({ ...run, testRun: true, result: "failure", report: undefined }),
    expected: {
      result:
        "🧪 TEST RUN — 🚨 context sweep failed before its report (failure) · <https://depot.dev/run|run>",
      page: [
        "🧪 TEST RUN — 🚨 context sweep failed before its report (failure)",
        "Impact: orphan contexts stay stored and billed until a sweep succeeds",
        "Do: open the run: its log names each object that could not say who it is and each orphan not destroyed, with the error",
        "<https://depot.dev/run|run>",
      ].join("\n"),
    },
  },
])("$name", ({ posts, expected }) => {
  // exact: a stray mention on a routine post, or a missing one on a page, must fail
  expect(posts).toEqual(expected);
});

test("a routine night's #ci line, at five-digit counts, is one line of at most 120 characters besides its link", () => {
  const { result } = sweepPosts({
    ...run,
    result: "success",
    report: {
      ...report,
      stored: 12_345,
      live: 11_000,
      global: 1_200,
      orphans: 145,
      destroyed: 140,
      recent: 3,
      emptied: 2,
      backups: "r2://b/",
    },
  });
  const text = result.replace(/<[^|]+\|run>/u, "run");
  expect({ text, lines: text.split("\n").length, short: text.length <= 120 }).toMatchObject({
    lines: 1,
    short: true,
  });
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
  return {
    type: "events.iterate.com/test/marker",
    payload: {},
    offset,
    path: "/",
    createdAt,
    source: { origin: "/" },
  };
}

/** A failing sweep's page, as it pages #error-pulse. */
function failedPage(what: string) {
  return [
    `🚨 ${what} <@U067G4QRFK2> <@U099JH9TAF2>`,
    "Impact: orphan contexts stay stored and billed until a sweep succeeds",
    "Do: open the run: its log names each object that could not say who it is and each orphan not destroyed, with the error",
    "<https://depot.dev/run|run>",
  ].join("\n");
}
