import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { z } from "zod";
import { depotCiApi } from "../depot.ts";
import { getOctokit } from "../github.ts";
import { assembleTrace, jobKeyInWorkflow, Workflow, renderTrace, stepCommands } from "./tracing.ts";

/** The workflows whose runs are traced: the per-PR preview's deploy and e2e jobs. */
const TRACED_WORKFLOWS = ["preview-os.yml"];

/** Completed-run CI traces. Invoke with `pnpm exec trpc-cli scripts/ci/tracing/cli.ts`. */
export default class CiTrace {
  /** Collect the deploy and e2e jobs of the workflow run this job belongs to. */
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
      throw new Error("Only Iterate preview workflows can publish CI traces");
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
    const name = `public-ci-trace-${workflow.workflowId}-${executionId}`;
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
    const commands = stepCommands(await source.text());
    const attempts = workflow.jobs
      .filter((job) => !job.jobKey.endsWith(":trace"))
      .flatMap((job) => job.attempts)
      .filter((attempt) => attempt.startedAt);
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
        const job = workflow.jobs.find((job) =>
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
    return assembleTrace(workflow, new Map(entries));
  }

  /**
   * Post the "CI trace" commit status for a collected report: time to green or red in its
   * description, linking to the collecting Depot job, whose artifacts hold trace.html and
   * trace.json. The status says the report exists; the preview's own checks carry the verdict.
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
    const green = attribute("ci.time_to_green_ms");
    const red = attribute("ci.time_to_red_ms");
    const status = {
      state: green ? ("success" as const) : red ? ("failure" as const) : ("error" as const),
      context: "CI trace",
      description: green
        ? `Time to green ${duration(Number(green))} · report in the job's artifacts`
        : red
          ? `Time to red ${duration(Number(red))} · report in the job's artifacts`
          : `No verdict (${attribute("ci.status")}) · report in the job's artifacts`,
      target_url: z.string().url().parse(process.env.DEPOT_JOB_URL),
    };
    await getOctokit().rest.repos.createCommitStatus({
      owner: "iterate",
      repo: "iterate",
      sha,
      ...status,
    });
    return status;
  }

  private async depot(method: string, body: object) {
    return depotCiApi(method, body, z.string().min(1).parse(process.env.DEPOT_CI_TELEMETRY_TOKEN));
  }
}

const repository = "iterate/iterate";
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
