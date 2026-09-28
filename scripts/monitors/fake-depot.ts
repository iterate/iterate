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
      return { url: `data:application/zip;base64,${storedZip(files).toString("base64")}` };
    }
    throw new Error(`the fake does not answer ${method}`);
  };
  return depot;
}

/** `files` as a zip whose entries are stored uncompressed: what scripts/ci/depot.ts `unzip` reads
 *  (https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT, 4.3). It leaves every CRC zero,
 *  which unzip never checks. */
function storedZip(files: Record<string, string>) {
  const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
  const u32 = (value: number) => [...u16(value & 0xffff), ...u16(value >>> 16)];
  const local: number[] = [];
  const central: number[] = [];
  for (const [path, text] of Object.entries(files)) {
    const name = [...Buffer.from(path)];
    const data = [...Buffer.from(text)];
    const offset = local.length;
    // signature, version, flags, method, time and date, CRC, sizes, name and extra lengths
    const fields = [...u32(0), ...u32(0), ...u32(data.length), ...u32(data.length)];
    local.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...fields);
    local.push(...u16(name.length), ...u16(0), ...name, ...data);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...fields);
    // name, extra and comment lengths, disk, attributes, then the local header's offset
    central.push(...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0));
    central.push(...u32(offset), ...name);
  }
  const count = Object.keys(files).length;
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(count), ...u16(count)];
  end.push(...u32(central.length), ...u32(local.length), ...u16(0));
  return Buffer.from([...local, ...central, ...end]);
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
 *  suite job's attempts uploaded in their test results. A `running` one is the run whose page
 *  job judges it: its deploy and suites have ended, its trace and page jobs have not. */
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
    specsTests?: SummaryTest[];
    running?: boolean;
  },
) {
  const last = input.running ? "running" : "finished";
  const job = (key: string, displayName: string, status = "finished") => ({
    jobKey: `main-os-e2e.yml:${key}`,
    jobDisplayName: displayName,
    status,
    // a job its deploy's failure skipped, or one Depot never started, has no attempt
    attempts:
      status === "skipped" || status === "queued"
        ? []
        : [
            { attemptId: `${id}-${key}-1`, attempt: 1 },
            { attemptId: `${id}-${key}-2`, attempt: 2 },
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
            ...records("specs", "specs", input.specsTests || [{ name: "sends a message" }]),
          },
  };
}
