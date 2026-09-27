// The suite jobs' wait for their run's deploy (./await-deploy.ts), against the monitors' fake Depot
// on a fake clock. What the wait runs before and after is apps/os/scripts/preview.ts's.
import { expect, onTestFinished, test, vi } from "vitest";
import { fakeDepot } from "../monitors/fake-depot.ts";
import { AWAIT_DEPLOY, awaitDeploy } from "./await-deploy.ts";

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
