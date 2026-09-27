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
// line per change of the deploy's state. Depot's answers that fail on the platform's side are asked
// again on CI_HTTP's schedule with a warn each (scripts/ci/depot.ts `depotCiApi`).
import { z } from "zod";
import { depotCiApi, type DepotApi } from "./depot.ts";

/** How often the wait asks Depot, and how long it waits at most: the deploy jobs' own
 *  `timeout-minutes` (preview-os-workflow.test.ts keeps the suite jobs' timeouts above it). */
export const AWAIT_DEPLOY = { pollMs: 1_000, boundMs: 40 * 60_000 };

/** A job's statuses that end the wait with no preview (Depot's terminal statuses but `finished`:
 *  https://github.com/depot/cli/blob/main/pkg/cmd/ci/logs.go). */
const NO_PREVIEW = ["failed", "cancelled", "skipped"];

// Connect's JSON omits empty lists and strings (https://protobuf.dev/programming-guides/json/).
const WorkflowJobs = z.object({
  jobs: z
    .array(
      z.object({
        jobKey: z.string(),
        jobDisplayName: z.string().default(""),
        status: z.string(),
        attempts: z.array(z.object({ attempt: z.number() })).default([]),
      }),
    )
    .default([]),
});

/** Wait until the job `job` (its id in the workflow file, `deploy`) of the workflow run
 *  `workflowId` has finished; throw once it failed, was cancelled or skipped, or after the bound. */
export async function awaitDeploy(input: {
  depot: DepotApi;
  workflowId: string;
  job: string;
  log?: (line: string) => void;
}) {
  const { depot, workflowId, job, log = console.log } = input;
  const started = Date.now();
  let reported = "";
  for (;;) {
    const { jobs } = WorkflowJobs.parse(await depot("GetWorkflow", { workflowId }));
    // `<file>:<job id>`, a matrix leg's with `:matrix-<n>` after it
    const deploy = jobs.find((candidate) => candidate.jobKey.split(":")[1] === job);
    if (!deploy) throw new Error(`Depot lists no job ${job} in workflow ${workflowId} to wait for`);
    const name = deploy.jobDisplayName || deploy.jobKey;
    const attempt = Math.max(0, ...deploy.attempts.map((candidate) => candidate.attempt));
    const state = attempt ? `${deploy.status} (attempt ${attempt})` : deploy.status;
    const waitedMs = Date.now() - started;
    if (state !== reported)
      log(`[await-deploy] ${(waitedMs / 1000).toFixed(1)} s: ${name} is ${state}`);
    reported = state;
    if (deploy.status === "finished") return;
    if (NO_PREVIEW.includes(deploy.status))
      throw new Error(`${name} ${deploy.status}, so there is no preview of this commit to test.`);
    if (waitedMs >= AWAIT_DEPLOY.boundMs)
      throw new Error(
        `${name} is still ${deploy.status} after ${AWAIT_DEPLOY.boundMs / 60_000} minutes, its own timeout, so no preview of this commit is coming.`,
      );
    await new Promise((resolve) => setTimeout(resolve, AWAIT_DEPLOY.pollMs));
  }
}

/** The wait as a suite job runs it: its own workflow run from DEPOT_JOB_URL
 *  (`…/workflows/<workflowId>?job=…&attempt=…`), and the Depot organization token CI telemetry and
 *  the trace job use, DEPOT_CI_TELEMETRY_TOKEN, which `doppler run` gives the suite's step from
 *  Doppler os/preview (it inherits _shared/preview). */
export async function awaitDeployOfThisRun(job: string) {
  const token = z
    .string({ error: "DEPOT_CI_TELEMETRY_TOKEN is required to wait for the deploy (Doppler)" })
    .min(1)
    .parse(process.env.DEPOT_CI_TELEMETRY_TOKEN);
  const workflowId = z
    .string()
    .regex(/^[a-z0-9]+$/)
    .parse(new URL(z.url().parse(process.env.DEPOT_JOB_URL)).pathname.split("/").at(-1));
  await awaitDeploy({
    depot: (method, body) => depotCiApi(method, body, token),
    workflowId,
    job,
  });
}
