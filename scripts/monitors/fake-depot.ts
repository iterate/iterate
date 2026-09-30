import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import type { DepotApi } from "../ci/depot.ts";

/** The fields of Depot's CI API requests the fake answers from, by method. */
const Listing = z.object({ name: z.string(), status: z.array(z.string()) });
const OfWorkflow = z.object({ workflowId: z.string() });
const OfArtifact = z.object({ artifactId: z.string() });

/** A workflow as the fake lists it, with its jobs and each artifact's files by path. */
type FakeWorkflow = {
  workflowId: string;
  runId: string;
  status: string;
  trigger: string;
  sha: string;
  createdAt: string;
  jobs?: {
    jobKey: string;
    jobDisplayName: string;
    status: string;
    attempts: { attemptId: string; attempt: number }[];
  }[];
  artifacts?: Record<string, Record<string, string>>;
};

/** Depot's CI API answering from `workflows`, by name, as the health checks call it: ListWorkflows,
 *  GetWorkflow, ListArtifacts, and GetArtifactDownloadURL with a `data:` URL of the artifact's files
 *  as a zip, which `fetch` reads like Depot's storage. */
export function fakeDepot(workflows: Record<string, FakeWorkflow[]>) {
  const all = Object.values(workflows).flat();
  const byId = (workflowId: string) => {
    const workflow = all.find((candidate) => candidate.workflowId === workflowId);
    if (!workflow) throw new Error(`the fake has no workflow ${workflowId}`);
    return workflow;
  };
  const depot: DepotApi = async (method, request) => {
    if (method === "ListWorkflows") {
      const { name, status } = Listing.parse(request);
      return {
        workflows: (workflows[name] || [])
          .filter((workflow) => status.includes(workflow.status))
          .map(({ jobs: _jobs, artifacts: _artifacts, ...listed }) => listed),
      };
    }
    if (method === "GetWorkflow") {
      const workflow = byId(OfWorkflow.parse(request).workflowId);
      return {
        workflowId: workflow.workflowId,
        runId: workflow.runId,
        workflowStatus: workflow.status,
        trigger: workflow.trigger,
        sha: workflow.sha,
        workflowCreatedAt: workflow.createdAt,
        jobs: workflow.jobs || [],
      };
    }
    if (method === "ListArtifacts") {
      const workflow = byId(OfWorkflow.parse(request).workflowId);
      return {
        artifacts: Object.keys(workflow.artifacts || {}).map((name) => ({
          artifactId: `${workflow.workflowId}/${name}`,
          name,
          createdAt: workflow.createdAt,
        })),
      };
    }
    if (method === "GetArtifactDownloadURL") {
      const { artifactId } = OfArtifact.parse(request);
      const [workflowId = "", name = ""] = artifactId.split("/");
      const files = byId(workflowId).artifacts?.[name];
      if (!files) throw new Error(`the fake has no artifact ${artifactId}`);
      const zip = zipSync(
        Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])),
      );
      return { url: `data:application/zip;base64,${Buffer.from(zip).toString("base64")}` };
    }
    throw new Error(`the fake does not answer ${method}`);
  };
  return depot;
}

/** A row of a suite summary, passed unless it says otherwise. */
export type SummaryTest = {
  name: string;
  tags?: string[];
  outcome?: "pass" | "fail" | "skip";
  retries?: number;
  failed?: boolean;
  error?: string;
};

/** A suite summary as the finalizer writes it (scripts/ci/flake-suite-summary.ts): an incomplete
 *  one says why in `diagnostics`, a cancelled job's unless given. */
export function summary(
  tests: SummaryTest[],
  status: "complete" | "incomplete" = "complete",
  diagnostics = status === "incomplete" ? ["CI run cancelled"] : [],
) {
  return {
    headSha: "abc",
    branch: "main",
    status,
    startedAt: "2026-09-26T20:00:00.000Z",
    finishedAt: "2026-09-26T20:05:00.000Z",
    testCount: tests.length,
    tests: tests.map(({ name, tags, outcome, retries, failed = false, error }) => ({
      name,
      outcome: outcome || (failed || retries ? "fail" : "pass"),
      durationMs: 1000,
      tags,
      retries,
      failed,
      error,
    })),
    unknownFlakeCount: tests.filter((test) => test.retries || test.failed).length,
    failedCount: tests.filter((test) => test.failed).length,
    diagnostics,
    runUrl: "https://depot.dev/run",
  };
}

/** A push run of Main OS e2e: its jobs' statuses (finished unless named) and the suite summary each
 *  suite job's attempts uploaded in their test results. Its specs run in one shard, the one leg of
 *  `specs-shard`, Browser specs 1/1, whose verdict is Browser specs'. A `running` one is the run
 *  whose page job judges it: its deploy and suites have ended, its trace and page jobs have not. */
export function mainRun(
  id: string,
  createdAt: string,
  input: {
    deploy?: string;
    e2e?: string;
    specs?: string;
    e2eTests?: SummaryTest[];
    /** The E2E tests summary's status and diagnostics, complete unless given. */
    e2eSummary?: { status: "incomplete"; diagnostics: string[] };
    /** The specs shard's rows, and its status. */
    specsTests?: SummaryTest[];
    shard?: string;
    running?: boolean;
  },
) {
  const last = input.running ? "running" : "finished";
  // a matrix leg's key ends `:matrix-<n>`, which its attempts' ids leave out
  const job = (key: string, displayName: string, status = "finished") => ({
    jobKey: `main-os-e2e.yml:${key}`,
    jobDisplayName: displayName,
    status,
    // a job its deploy's failure skipped, or one Depot never started, has no attempt
    attempts:
      status === "skipped" || status === "queued"
        ? []
        : [
            { attemptId: `${id}-${key.split(":")[0]}-1`, attempt: 1 },
            { attemptId: `${id}-${key.split(":")[0]}-2`, attempt: 2 },
          ],
  });
  const records = (
    suite: string,
    key: string,
    tests: SummaryTest[],
    status?: { status: "incomplete"; diagnostics: string[] },
  ) => ({
    // the older attempt's results, which a retried job keeps beside the newest's
    [`main-os-test-artifacts-attempt-${id}-${key}-1`]: {
      [`flake-records/${suite}/suite-summary.json`]: JSON.stringify(
        summary([{ name: "an older attempt", failed: true }]),
      ),
    },
    [`main-os-test-artifacts-attempt-${id}-${key}-2`]: {
      [`flake-records/${suite}/suite-summary.json`]: JSON.stringify(
        summary(tests, status?.status, status?.diagnostics),
      ),
    },
  });
  return {
    workflowId: `wf-${id}`,
    runId: `run-${id}`,
    status: last,
    trigger: "push",
    sha: id.padEnd(40, "a"),
    createdAt,
    jobs: [
      job("deploy", "Deploy preview", input.deploy),
      job("e2e", "E2E tests", input.e2e),
      job("specs", "Browser specs", input.specs),
      job("specs-shard:matrix-0", "Browser specs 1/1", input.shard),
      job("trace", "CI trace", last),
      job("alert", "Page a change of state", last),
    ],
    artifacts:
      input.deploy === "failed"
        ? {}
        : {
            ...records(
              "preview-e2e",
              "e2e",
              input.e2eTests || [{ name: "a slow row", tags: ["slow"] }],
              input.e2eSummary,
            ),
            ...records("specs", "specs-shard", input.specsTests || [{ name: "sends a message" }]),
          },
  };
}
