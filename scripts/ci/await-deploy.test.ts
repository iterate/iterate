// The suite jobs' wait for their run's deploy (./await-deploy.ts), against the monitors' fake Depot
// on a fake clock. What the wait runs before and after is apps/os/scripts/preview.ts's.
import { expect, onTestFinished, test, vi } from "vitest";
import { fakeDepot } from "../monitors/fake-depot.ts";
import { AWAIT_DEPLOY, awaitDeploy } from "./await-deploy.ts";
import { depotCiApi } from "./depot.ts";

type Row = {
  name: string;
  /** The deploy job's status at each of the wait's calls, the last one repeated. */
  deploy: string[];
  /** The deploy job's attempts when the wait starts. */
  attempts?: number;
  expected:
    | { goesAfter: { calls: number; seconds: number }; logged: number }
    | { fails: string; calls: number };
};

test.for<Row>([
  {
    name: "a deploy that finishes while the suite waits starts it, one line per change of its state",
    deploy: ["queued", "running", "running", "running", "finished"],
    expected: { goesAfter: { calls: 5, seconds: 4 }, logged: 3 },
  },
  {
    name: "a deploy that finished in an earlier attempt starts a suite re-run alone at once",
    deploy: ["finished"],
    expected: { goesAfter: { calls: 1, seconds: 0 }, logged: 1 },
  },
  {
    name: "a deploy re-run after its first attempt failed is waited for, then starts the suite",
    deploy: ["queued", "running", "finished"],
    attempts: 1,
    expected: { goesAfter: { calls: 3, seconds: 2 }, logged: 3 },
  },
  {
    name: "a deploy that fails while the suite waits fails it: there is no preview to test",
    deploy: ["running", "running", "failed"],
    expected: {
      fails: "Deploy preview failed, so there is no preview of this commit to test.",
      calls: 3,
    },
  },
  {
    name: "a deploy cancelled while the suite waits fails it",
    deploy: ["running", "cancelled"],
    expected: {
      fails: "Deploy preview cancelled, so there is no preview of this commit to test.",
      calls: 2,
    },
  },
  {
    name: "a skipped deploy fails the suite at once",
    deploy: ["skipped"],
    expected: {
      fails: "Deploy preview skipped, so there is no preview of this commit to test.",
      calls: 1,
    },
  },
  {
    name: "a deploy Depot never reports ending fails the suite after the deploy's own timeout",
    deploy: ["running"],
    expected: {
      fails: "Deploy preview is still running after 40 minutes, its own timeout",
      calls: AWAIT_DEPLOY.boundMs / AWAIT_DEPLOY.pollMs + 1,
    },
  },
])("$name", async ({ deploy, attempts = 0, expected }) => {
  const run = deployingRun(deploy, attempts);

  const waited = awaitDeploy({ depot: run.depot, workflowId: "wf-1", job: "deploy", log: run.log });

  if ("fails" in expected) {
    await expect(waited).rejects.toThrow(expected.fails);
    expect(run).toMatchObject({ calls: expected.calls });
    return;
  }
  await waited;
  expect({
    goesAfter: { calls: run.calls, seconds: (Date.now() - run.started) / 1000 },
    logged: run.lines.length,
  }).toEqual(expected);
});

test("the wait fails at once when its workflow has no job by the name it waits for", async () => {
  const run = deployingRun(["running"], 0);

  await expect(
    awaitDeploy({ depot: run.depot, workflowId: "wf-1", job: "build", log: run.log }),
  ).rejects.toThrow("Depot lists no job build in workflow wf-1 to wait for");
});

// DEPOT FAILING ON ITS OWN SIDE: the wait's calls go through depotCiApi, which asks each call
// Depot fails again on CI_HTTP's schedule (at 2, 7 and 17 s, each wait at its longest), then the
// wait asks again a second later. A call made while `failing` answers is Depot's failure; any other
// is Depot's answer about the deploy, the next of the row's statuses.
test.for([
  { failing: 503 as const, message: 'Depot GetWorkflow answered HTTP 503: {"code":"unavailable"}' },
  { failing: 429 as const, message: 'Depot GetWorkflow answered HTTP 429: {"code":"unavailable"}' },
  { failing: "reset" as const, message: "Depot GetWorkflow: fetch failed" },
])(
  "a Depot that answers $failing for 30 s is waited out, and the suite starts once the deploy has finished",
  async ({ failing, message }) => {
    const run = deployingRun(["finished"], 1);
    const depot = throughDepotApi(run, (second) => (second < 30 ? failing : undefined));

    await awaitDeploy({ ...depot, workflowId: "wf-1", job: "deploy", log: run.log });

    expect({
      seconds: (Date.now() - run.started) / 1000,
      calls: depot.calls,
      warned: depot.warned,
      logged: run.lines,
    }).toEqual({
      seconds: 35,
      calls: [0, 2, 7, 17, 18, 20, 25, 35],
      warned: [
        `[await-deploy] 17.0 s: ${message}; asking again in 1.0 s, until 5 minutes of failures`,
      ],
      logged: ["[await-deploy] 35.0 s: Deploy preview (attempt 1) finished"],
    });
  },
);

test("Depot failing on and off is no outage: one answer between the failures starts the count again", async () => {
  const run = deployingRun(["running", "finished"], 1);
  // every call fails but those at 240–242 s and from 480 s: 483 s of failures, four minutes at a time
  const depot = throughDepotApi(run, (second) =>
    second < 240 || (second >= 242 && second < 480) ? 503 : undefined,
  );

  await awaitDeploy({ ...depot, workflowId: "wf-1", job: "deploy", log: run.log });

  expect({ seconds: (Date.now() - run.started) / 1000, logged: run.lines }).toEqual({
    seconds: 483,
    logged: [
      "[await-deploy] 241.0 s: Deploy preview (attempt 1) running",
      "[await-deploy] 483.0 s: Deploy preview (attempt 1) finished",
    ],
  });
});

test("a Depot that fails every call for five minutes fails the suite", async () => {
  const run = deployingRun(["running"], 0);
  const depot = throughDepotApi(run, () => 503);

  await expect(
    awaitDeploy({ ...depot, workflowId: "wf-1", job: "deploy", log: run.log }),
  ).rejects.toThrow(
    'Depot has failed every GetWorkflow for the last 305.0 s (Depot GetWorkflow answered HTTP 503: {"code":"unavailable"}), so the wait for deploy gives up.',
  );
  // seventeen of CI_HTTP's four calls, 18 s apart; the last ends at 305 s
  expect({ calls: depot.calls.length, seconds: (Date.now() - run.started) / 1000 }).toEqual({
    calls: 17 * 4,
    seconds: 305,
  });
});

// An answer about the request is the same answer asked again: a token Depot refuses, a workflow it
// has not got, an answer the wait cannot read.
test.for([401, 403, 404])("a Depot that answers %i fails the suite at once", async (status) => {
  const run = deployingRun(["running"], 0);
  const depot = throughDepotApi(run, () => status);

  await expect(
    awaitDeploy({ ...depot, workflowId: "wf-1", job: "deploy", log: run.log }),
  ).rejects.toThrow(`Depot GetWorkflow answered HTTP ${status}`);
  expect({ calls: depot.calls, warned: depot.warned }).toEqual({ calls: [0], warned: [] });
});

test("an answer the wait cannot read fails the suite at once", async () => {
  let calls = 0;
  const depot = async () => {
    calls++;
    return { jobs: [{ jobKey: "preview-os.yml:deploy", attempts: [] }] };
  };

  await expect(
    awaitDeploy({ depot, workflowId: "wf-1", job: "deploy", log: () => {}, warn: () => {} }),
  ).rejects.toThrow(/status/);
  expect(calls).toBe(1);
});

/** `run`'s Depot as the suite job calls it, through depotCiApi's fetch and its CI_HTTP repeats,
 *  each wait at its longest (`Math.random` at 1): a call made at a second of the fake clock that
 *  `failing` names a status or "reset" (a connection that fails the way undici's fetch does) for
 *  is Depot's failure, any other `run`'s answer. `calls` are the calls' seconds; `warned` is the
 *  wait's own warns, and depotCiApi's go to a silenced console.warn. */
function throughDepotApi(
  run: ReturnType<typeof deployingRun>,
  failing: (second: number) => number | "reset" | undefined,
) {
  vi.spyOn(Math, "random").mockReturnValue(1);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const calls: number[] = [];
  const warned: string[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const second = (Date.now() - run.started) / 1000;
    calls.push(second);
    const answer = failing(second);
    if (answer === "reset") throw new TypeError("fetch failed");
    if (answer !== undefined) return new Response('{"code":"unavailable"}', { status: answer });
    return Response.json(await run.depot("GetWorkflow", JSON.parse(String(init!.body))));
  }) as typeof globalThis.fetch;
  return {
    depot: (method: string, body: object) => depotCiApi(method, body, "token", { fetch }),
    warn: (line: string) => void warned.push(line),
    calls,
    warned,
  };
}

/** A Preview OS run whose suites and trace wait while its deploy moves through `statuses`, one a
 *  call to GetWorkflow, on a fake clock that moves on whenever the wait sleeps. */
function deployingRun(statuses: string[], attempts: number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setTimerTickMode("nextTimerAsync");
  onTestFinished(() => void vi.useRealTimers());
  const job = (key: string, jobDisplayName: string, status: string) => ({
    jobKey: `preview-os.yml:${key}`,
    jobDisplayName,
    status,
    attempts: [] as { attemptId: string; attempt: number }[],
  });
  const deploy = job("deploy", "Deploy preview", statuses[0]!);
  deploy.attempts = Array.from({ length: attempts }, (_, index) => ({
    attemptId: `deploy-${index + 1}`,
    attempt: index + 1,
  }));
  const fake = fakeDepot({
    "Preview OS": [
      {
        workflowId: "wf-1",
        runId: "run-1",
        status: "running",
        trigger: "pull_request",
        sha: "a".repeat(40),
        createdAt: "2026-09-27T09:00:00.000Z",
        jobs: [
          deploy,
          job("e2e", "E2E tests", "running"),
          job("specs", "Browser specs", "running"),
          job("trace", "CI trace", "queued"),
        ],
      },
    ],
  });
  const run = {
    started: Date.now(),
    calls: 0,
    lines: [] as string[],
    log: (line: string) => void run.lines.push(line),
    depot: async (method: string, body: object) => {
      const status = statuses[Math.min(run.calls, statuses.length - 1)]!;
      // a job that starts running has an attempt; a re-run's next attempt starts as it runs again
      if (status === "running" && deploy.status !== "running")
        deploy.attempts.push({
          attemptId: `deploy-${deploy.attempts.length + 1}`,
          attempt: deploy.attempts.length + 1,
        });
      deploy.status = status;
      run.calls++;
      return fake(method, body);
    },
  };
  return run;
}
