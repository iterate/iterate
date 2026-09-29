// scripts/ci/await-deploy.ts — A SUITE JOB'S WAIT FOR ITS RUN'S DEPLOY. Preview OS's and Main OS
// e2e's E2E tests and Browser specs jobs start when the run does, beside Deploy preview, with no
// `needs:`. Each sets itself up while the deploy runs (apps/os/scripts/preview.ts `runSuite`), then
// waits here: Depot's GetWorkflow for its own workflow run, once a second, until the deploy job has
// finished, which starts the suite, or failed, been cancelled or skipped, which fails it red, since
// there is no preview of this commit to test (docs/depot-ci.md#preview-job-shape).
//
// It reads the job's status, not one attempt's, so a suite re-run alone after the run ended goes at
// once on a deploy that finished in an earlier attempt, and one re-run beside a re-run deploy waits
// for that deploy's new attempt. It waits on no other job. It gives up after AWAIT_DEPLOY.boundMs,
// the deploy's own `timeout-minutes`, in case Depot never reports the deploy ending, and logs one
// line per change of the deploy's state.
//
// Depot failing on its own side does not fail the suite. A call Depot answers with a 5xx or a 429,
// or whose connection fails, is asked again on CI_HTTP's schedule with a warn each
// (scripts/ci/depot.ts `depotCiApi`); a call that still fails after that is one more warn here, and
// the wait asks again a second later. Only an outage, every call failing for AWAIT_DEPLOY.outageMs,
// fails the suite. An answer about the request (a 401 or 403, a missing token, an answer the wait
// cannot read) fails it at once.
import { z } from "zod";
import {
  httpFailureFields,
  httpFailureKind,
  isPlatformFailureKind,
} from "@iterate-com/shared/platform-retry";
import { depotApi, type DepotApi } from "./depot.ts";

/** How often the wait asks Depot; how long it waits at most, the deploy jobs' own `timeout-minutes`;
 *  and how long Depot may fail every call before the wait gives up on it. */
export const AWAIT_DEPLOY = { pollMs: 1_000, boundMs: 40 * 60_000, outageMs: 5 * 60_000 };

/** How long a suite runs at most once the wait is over (apps/os/scripts/preview.ts `runSuite`). The
 *  suite jobs' `timeout-minutes` is the wait's bound and then this (preview-os-workflow.test.ts). */
export const SUITE_BOUND_MS = 30 * 60_000;

/** A job's statuses that end the wait with no preview (Depot's terminal statuses but `finished`:
 *  https://github.com/depot/cli/blob/main/pkg/cmd/ci/logs.go). */
const NO_PREVIEW = ["failed", "cancelled", "skipped"];

// Connect's JSON omits empty lists and strings (https://protobuf.dev/programming-guides/json/).
const WorkflowJobs = z.object({
  runId: z.string(),
  jobs: z
    .array(
      z.object({
        jobKey: z.string(),
        jobDisplayName: z.string().default(""),
        status: z.string(),
        attempts: z.array(z.object({ attemptId: z.string(), attempt: z.number() })).default([]),
      }),
    )
    .default([]),
});
export type WorkflowJobs = z.infer<typeof WorkflowJobs>;

/** Wait until the job `job` (its id in the workflow file, `deploy`) of the workflow run
 *  `workflowId` has finished; throw once it failed, was cancelled or skipped, after the bound, after
 *  an outage of Depot's, or on an answer about the request. */
export async function awaitDeploy(input: {
  depot: DepotApi;
  workflowId: string;
  job: string;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}) {
  const { workflowId, job, log = console.log } = input;
  let reported = "";
  await pollWorkflow({
    ...input,
    tag: "await-deploy",
    waitingFor: job,
    boundMs: AWAIT_DEPLOY.boundMs,
    settled: ({ jobs }, waitedMs) => {
      // `<file>:<job id>`, a matrix leg's with `:matrix-<n>` after it
      const deploy = jobs.find((candidate) => candidate.jobKey.split(":")[1] === job);
      if (!deploy)
        throw new Error(`Depot lists no job ${job} in workflow ${workflowId} to wait for`);
      const name = deploy.jobDisplayName || deploy.jobKey;
      const attempt = Math.max(0, ...deploy.attempts.map((candidate) => candidate.attempt));
      const state = `${name}${attempt ? ` (attempt ${attempt})` : ""} ${deploy.status}`;
      if (state !== reported) log(`[await-deploy] ${seconds(waitedMs)}: ${state}`);
      reported = state;
      if (deploy.status === "finished") return true;
      if (NO_PREVIEW.includes(deploy.status))
        throw new Error(`${name} ${deploy.status}, so there is no preview of this commit to test.`);
      if (waitedMs >= AWAIT_DEPLOY.boundMs)
        throw new Error(
          `${name} is still ${deploy.status} after ${AWAIT_DEPLOY.boundMs / 60_000} minutes, its own timeout, so no preview of this commit is coming.`,
        );
      return undefined;
    },
  });
}

/** Depot's GetWorkflow for the run `workflowId`, once every AWAIT_DEPLOY.pollMs, each answer handed
 *  to `settled`, until it returns what the wait was for or throws. A call Depot fails on its own side
 *  is a warn, tagged `[tag]`, and asked again; only failures for AWAIT_DEPLOY.outageMs, or past
 *  `boundMs`, end the wait. An answer about the request, or one it cannot read, throws at once. */
export async function pollWorkflow<Result>(input: {
  depot: DepotApi;
  workflowId: string;
  tag: string;
  /** What the wait is for, as its failure names it: `deploy`. */
  waitingFor: string;
  boundMs: number;
  warn?: (line: string) => void;
  settled: (workflow: WorkflowJobs, waitedMs: number) => Result | undefined;
}): Promise<Result> {
  const { depot, workflowId, warn = console.warn } = input;
  const started = Date.now();
  /** When the first of the calls Depot has failed since its last answer was made. */
  let failingSince: number | undefined;
  for (;;) {
    const askedAt = Date.now();
    let answer: unknown;
    try {
      answer = await depot("GetWorkflow", { workflowId });
    } catch (error) {
      if (!isPlatformFailureKind(httpFailureKind(error))) throw error;
      failingSince ??= askedAt;
      const { message } = httpFailureFields(error);
      const failingMs = Date.now() - failingSince;
      if (failingMs >= AWAIT_DEPLOY.outageMs || Date.now() - started >= input.boundMs)
        throw new Error(
          `Depot has failed every GetWorkflow for the last ${seconds(failingMs)} (${message}), so the wait for ${input.waitingFor} gives up.`,
          { cause: error },
        );
      warn(
        `[${input.tag}] ${seconds(Date.now() - started)}: ${message}; asking again in ${seconds(AWAIT_DEPLOY.pollMs)}, until ${AWAIT_DEPLOY.outageMs / 60_000} minutes of failures`,
      );
      await new Promise((resolve) => setTimeout(resolve, AWAIT_DEPLOY.pollMs));
      continue;
    }
    failingSince = undefined;
    const result = input.settled(WorkflowJobs.parse(answer), Date.now() - started);
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, AWAIT_DEPLOY.pollMs));
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The wait as a suite job runs it: its own workflow run (thisWorkflowRun), read with the Depot
 *  organization token (depot.ts `depotApi`). */
export async function awaitDeployOfThisRun(job: string) {
  await awaitDeploy({
    depot: depotApi(),
    workflowId: thisWorkflowRun(),
    job,
  });
}

/** The workflow run of the job this runs in, from DEPOT_JOB_URL
 *  (`…/workflows/<workflowId>?job=…&attempt=…`). */
export function thisWorkflowRun() {
  return z
    .string()
    .regex(/^[a-z0-9]+$/)
    .parse(new URL(z.url().parse(process.env.DEPOT_JOB_URL)).pathname.split("/").at(-1));
}
