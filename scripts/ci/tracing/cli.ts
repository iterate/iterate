import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { z } from "zod";
import { ciReportsEnvs } from "../../../envs.ts";
import { depotCiApi } from "../depot.ts";
import { getOctokit } from "../github.ts";
import {
  assembleTrace,
  jobKeyInWorkflow,
  Workflow,
  renderTrace,
  stepCommands,
  tracedJobs,
} from "./tracing.ts";

/** The workflows whose runs are traced: a PR's preview, and main's e2e run on its own. */
const TRACED_WORKFLOWS = ["preview-os.yml", "main-os-e2e.yml"];

/** Completed-run CI traces. Invoke with `pnpm exec trpc-cli scripts/ci/tracing/cli.ts`. */
export default class CiTrace {
  /** Collect the jobs this `trace` job needs, in the workflow run it belongs to. */
  async current(directory: string) {
    const source = new URL(z.string().url().parse(process.env.DEPOT_JOB_URL));
    const workflowId = z
      .string()
      .regex(/^[a-z0-9]+$/)
      .parse(source.pathname.split("/").at(-1));
    return this.write(workflowId, directory);
  }

  /** Build local HTML/OTLP files without publishing or changing a commit status. */
  async render(workflowId: string, directory: string) {
    return this.write(workflowId, directory);
  }

  private async write(workflowId: string, directory: string) {
    const workflow = Workflow.parse(await this.depot("GetWorkflow", { workflowId }));
    if (workflow.repo !== repository || !TRACED_WORKFLOWS.includes(workflow.workflowPath))
      throw new Error(`Only ${TRACED_WORKFLOWS.join(" and ")} runs of ${repository} are traced`);
    const report = await this.collect(workflow);
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/trace.json`, JSON.stringify(report, null, 2));
    await writeFile(`${directory}/trace.html`, await renderTrace(report));
    const executionId = z
      .string()
      .min(1)
      .parse(
        report.resourceSpans[0].scopeSpans[0].spans[0].attributes.find(
          (attribute) => attribute.key === "ci.execution.id",
        )?.value.stringValue,
      );
    const name = traceArtifactName(workflow.workflowId, executionId);
    if (process.env.GITHUB_OUTPUT)
      await appendFile(process.env.GITHUB_OUTPUT, `artifact-name=${name}\n`);
    return { directory, name };
  }

  private async collect(workflow: z.infer<typeof Workflow>) {
    const source = await fetch(
      `https://raw.githubusercontent.com/${repository}/${workflow.sha}/.depot/workflows/${workflow.workflowPath}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!source.ok) throw new Error(`Could not read the source workflow: HTTP ${source.status}`);
    const yaml = await source.text();
    const commands = stepCommands(yaml);
    const traced = tracedJobs(yaml);
    // Main's delete and alert run beside the trace job, so the trace covers only what it waited for.
    const jobs = workflow.jobs.filter((job) => traced.includes(jobKeyInWorkflow(job.jobKey)));
    const attempts = jobs.flatMap((job) => job.attempts).filter((attempt) => attempt.startedAt);
    const entries = await Promise.all(
      attempts.map(async (attempt) => {
        const lines: z.infer<typeof LogPage>["lines"] = [];
        let pageToken = "";
        do {
          const page = LogPage.parse(
            await this.depot("GetJobAttemptLogs", {
              attemptId: attempt.attemptId,
              pageSize: 1000,
              pageToken,
            }),
          );
          // Raw logs may contain secrets. Keep only our deliberately small records.
          lines.push(...page.lines.filter((line) => line.body.startsWith("@@ci-trace ")));
          pageToken = page.nextPageToken;
        } while (pageToken);
        const job = jobs.find((job) =>
          job.attempts.some((item) => item.attemptId === attempt.attemptId),
        );
        if (!job) throw new Error("Collected attempt has no job");
        const jobKey = jobKeyInWorkflow(job.jobKey).split(":")[0];
        return [
          attempt.attemptId,
          lines.map((line) => ({
            ...line,
            command: commands.get(`${jobKey}/${line.stepId}`) || "",
          })),
        ] as const;
      }),
    );
    return assembleTrace({ ...workflow, jobs }, new Map(entries));
  }

  /**
   * Post the run's report links as commit statuses: **CI trace**, with the time to green or red, and
   * **Playwright report** when the e2e job uploaded one. Each opens its Depot artifact in the
   * ci-reports viewer (apps/ci-reports). A status says the report exists; the run's own checks carry
   * the verdict. Runs after the upload step: Depot lists an artifact once its upload finished.
   */
  async publish(directory: string) {
    const trace = TraceFile.parse(JSON.parse(await readFile(`${directory}/trace.json`, "utf8")));
    const root = trace.resourceSpans[0].scopeSpans[0].spans[0];
    const attribute = (key: string) =>
      root.attributes.find((item) => item.key === key)?.value.stringValue || "";
    const sha = z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .parse(process.env.CI_TRACE_STATUS_SHA);
    const workflowId = z
      .string()
      .regex(/^[a-z0-9]+$/)
      .parse(new URL(z.url().parse(process.env.DEPOT_JOB_URL)).pathname.split("/").at(-1));
    const { runId } = z
      .object({ runId: z.string() })
      .parse(await this.depot("GetWorkflow", { workflowId }));
    const artifacts: z.infer<typeof ArtifactPage>["artifacts"] = [];
    let pageToken = "";
    do {
      const page = ArtifactPage.parse(
        await this.depot("ListArtifacts", { runId, workflowId, pageSize: 100, pageToken }),
      );
      artifacts.push(...page.artifacts);
      pageToken = page.nextPageToken;
    } while (pageToken);
    // A job re-run uploads again under the same name; its newest upload is the run's report.
    const latest = (name: string) =>
      artifacts
        .filter((artifact) => artifact.name === name)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .at(-1);
    const traceName = traceArtifactName(
      workflowId,
      z.string().min(1).parse(attribute("ci.execution.id")),
    );
    const traceArtifact = latest(traceName);
    if (!traceArtifact) throw new Error(`Depot lists no ${traceName} artifact in this run`);
    const green = attribute("ci.time_to_green_ms");
    const red = attribute("ci.time_to_red_ms");
    const statuses = [
      {
        state: green ? ("success" as const) : red ? ("failure" as const) : ("error" as const),
        context: "CI trace",
        description: green
          ? `Time to green ${duration(Number(green))}`
          : red
            ? `Time to red ${duration(Number(red))}`
            : `No verdict (${attribute("ci.status")})`,
        target_url: reportUrl(traceArtifact.artifactId),
      },
    ];
    // None when the suite never ran: a failed deploy, or a run cancelled first.
    const playwright = latest("public-playwright-report");
    if (playwright)
      statuses.push({
        state: "success",
        context: "Playwright report",
        description: "Every spec, and each failure's trace, screenshot and error context",
        target_url: reportUrl(playwright.artifactId),
      });
    for (const status of statuses)
      await getOctokit().rest.repos.createCommitStatus({
        owner: "iterate",
        repo: "iterate",
        sha,
        ...status,
      });
    return statuses;
  }

  private async depot(method: string, body: object) {
    return depotCiApi(method, body, z.string().min(1).parse(process.env.DEPOT_CI_TELEMETRY_TOKEN));
  }
}

const repository = "iterate/iterate";

/** The trace job uploads its report under this name; `public-` lets the ci-reports viewer serve it. */
function traceArtifactName(workflowId: string, executionId: string) {
  return `public-ci-trace-${workflowId}-${executionId}`;
}

/** Where apps/ci-reports opens a public Depot artifact: its report, at the artifact's root. */
function reportUrl(artifactId: string) {
  return `${ciReportsEnvs.ci.baseUrl}/${artifactId}/`;
}

/** Depot's ListArtifacts page; a run without artifacts answers without the field. */
const ArtifactPage = z.object({
  artifacts: z
    .array(z.object({ artifactId: z.uuid(), name: z.string(), createdAt: z.iso.datetime() }))
    .default([]),
  nextPageToken: z.string().default(""),
});
/** The part of a collected trace.json the status reads: the workflow span's attributes. */
const TraceFile = z.object({
  resourceSpans: z.tuple([
    z.object({
      scopeSpans: z.tuple([
        z.object({
          spans: z
            .array(
              z.object({
                attributes: z.array(
                  z.object({ key: z.string(), value: z.object({ stringValue: z.string() }) }),
                ),
              }),
            )
            .min(1),
        }),
      ]),
    }),
  ]),
});

/** "11m 04s": minutes and seconds, the precision a CI wall time is read at. */
export function duration(milliseconds: number) {
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
const LogPage = z.object({
  lines: z
    .array(
      z.object({
        body: z.string().default(""),
        stepKey: z.string(),
        stepId: z.string().default(""),
        stepName: z.string().default(""),
      }),
    )
    .default([]),
  nextPageToken: z.string().default(""),
});
