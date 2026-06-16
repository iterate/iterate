import { os } from "@orpc/server";
import { z } from "zod";
import { runCommand } from "../../packages/shared/src/node/run-command.ts";

const defaultDepotOrgId = "0p91s0lz49";
const defaultRepositoryFullName = "iterate/iterate";
const buildPreviewImageWorkflow = ".depot/workflows/build-preview-ci-image.yml";
const measurePreviewCacheDiskWorkflow = ".depot/workflows/measure-preview-cache-disk.yml";
const measurePreviewImageWorkflow = ".depot/workflows/measure-preview-ci-image.yml";
const previewTrialWorkflow = "cloudflare-previews.yml";

const CommonDepotInput = z.object({
  orgId: z
    .string()
    .trim()
    .min(1)
    .default(process.env.DEPOT_ORG_ID ?? defaultDepotOrgId),
});

type DepotRun = {
  created_at?: string;
  finished_at?: string;
  id?: string;
  started_at?: string;
  status: string;
};

type DepotRunStatus = {
  status: string;
  workflows?: Array<{
    jobs?: Array<{ attempts?: Array<{ status?: string }>; status?: string }>;
    status?: string;
  }>;
};

async function runDepotCli(input: { args: string[]; echoOutput?: boolean; signal?: AbortSignal }) {
  const result = await runCommand({
    args: input.args,
    command: "depot",
    echoOutput: input.echoOutput ?? false,
    environment: process.env,
    signal: input.signal,
    workingDirectory: process.cwd(),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      [`depot ${input.args.join(" ")} failed with exit code ${result.exitCode}.`, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result;
}

export function parseDepotRunId(output: string) {
  return /^Run:\s*(\S+)/m.exec(output)?.[1] ?? null;
}

async function readDepotRun(input: { orgId: string; runId: string; signal?: AbortSignal }) {
  const result = await runDepotCli({
    args: ["ci", "run", "show", input.runId, "--org", input.orgId, "--output", "json"],
    signal: input.signal,
  });
  return JSON.parse(result.stdout) as DepotRun;
}

async function readDepotRunStatus(input: { orgId: string; runId: string; signal?: AbortSignal }) {
  const result = await runDepotCli({
    args: ["ci", "status", input.runId, "--org", input.orgId, "--output", "json"],
    signal: input.signal,
  });
  return JSON.parse(result.stdout) as DepotRunStatus;
}

export function depotRunHasFailed(status: DepotRunStatus) {
  return status.workflows?.some(
    (workflow) =>
      isFailedDepotStatus(workflow.status) ||
      workflow.jobs?.some(
        (job) =>
          isFailedDepotStatus(job.status) ||
          job.attempts?.some((attempt) => isFailedDepotStatus(attempt.status)),
      ),
  );
}

function isFailedDepotStatus(status: string | undefined) {
  return status === "failed" || status === "failure" || status === "errored" || status === "error";
}

function isCancelledDepotStatus(status: string | undefined) {
  return status === "cancelled" || status === "canceled";
}

async function waitForDepotRun(input: { orgId: string; runId: string; signal?: AbortSignal }) {
  while (true) {
    const [run, status] = await Promise.all([readDepotRun(input), readDepotRunStatus(input)]);
    if (isCancelledDepotStatus(run.status) || isCancelledDepotStatus(status.status)) {
      throw new Error(`Depot CI run ${input.runId} was cancelled.`);
    }

    if (isFailedDepotStatus(run.status) || isFailedDepotStatus(status.status)) {
      throw new Error(
        `Depot CI run ${input.runId} failed. Inspect with ` +
          `\`depot ci status ${input.runId} --org ${input.orgId}\`.`,
      );
    }

    if (run.status === "finished" || status.status === "finished") {
      if (depotRunHasFailed(status)) {
        throw new Error(
          `Depot CI run ${input.runId} finished with failed jobs. Inspect with ` +
            `\`depot ci status ${input.runId} --org ${input.orgId}\`.`,
        );
      }

      return { run, status };
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function runLocalWorkflow(input: {
  job: string;
  orgId: string;
  signal?: AbortSignal;
  workflowPath: string;
}) {
  const result = await runDepotCli({
    args: ["ci", "run", "--org", input.orgId, "--workflow", input.workflowPath, "--job", input.job],
    signal: input.signal,
  });
  const runId = parseDepotRunId(`${result.stdout}\n${result.stderr}`);
  if (!runId) {
    throw new Error(`Could not parse Depot CI run id from output:\n${result.stdout}`);
  }

  const completed = await waitForDepotRun({ orgId: input.orgId, runId, signal: input.signal });
  return {
    run: completed.run,
    runId,
    status: completed.status,
    workflowPath: input.workflowPath,
  };
}

export const router = os.router({
  "depot-ci": os.router({
    doctor: os
      .input(CommonDepotInput)
      .meta({ description: "Verify local Depot CI CLI access for this repository" })
      .handler(async ({ input, signal }) => {
        const [version, org, ci] = await Promise.all([
          runDepotCli({ args: ["--version"], signal }),
          runDepotCli({ args: ["org", "show"], signal }),
          runDepotCli({ args: ["ci", "--help"], signal }),
        ]);

        return {
          hasDepotCi: ci.stdout.includes("depot ci") || ci.stdout.includes("Manage Depot CI"),
          orgId: input.orgId,
          selectedOrgId: org.stdout.trim(),
          version: version.stdout.trim(),
        };
      }),
    image: os.router({
      build: os
        .input(
          CommonDepotInput.extend({
            workflowPath: z.string().trim().min(1).default(buildPreviewImageWorkflow),
          }),
        )
        .meta({
          description:
            "Build and upload the Depot CI preview image with the installed worktree preserved",
        })
        .handler(async ({ input, signal }) => {
          return await runLocalWorkflow({
            job: "build-image",
            orgId: input.orgId,
            signal,
            workflowPath: input.workflowPath,
          });
        }),
      measureSetup: os
        .input(
          CommonDepotInput.extend({
            workflowPath: z.string().trim().min(1).default(measurePreviewImageWorkflow),
          }),
        )
        .meta({
          description:
            "Measure checkout and dependency validation time on the uploaded preview CI image",
        })
        .handler(async ({ input, signal }) => {
          return await runLocalWorkflow({
            job: "setup",
            orgId: input.orgId,
            signal,
            workflowPath: input.workflowPath,
          });
        }),
      measureCacheDisk: os
        .input(
          CommonDepotInput.extend({
            workflowPath: z.string().trim().min(1).default(measurePreviewCacheDiskWorkflow),
          }),
        )
        .meta({
          description:
            "Measure dependency install time on a stock Depot runner with the durable pnpm cache disk",
        })
        .handler(async ({ input, signal }) => {
          return await runLocalWorkflow({
            job: "setup",
            orgId: input.orgId,
            signal,
            workflowPath: input.workflowPath,
          });
        }),
    }),
    preview: os.router({
      dispatch: os
        .input(
          CommonDepotInput.extend({
            baseSha: z.string().trim().min(1),
            headRefName: z.string().trim().min(1),
            headSha: z.string().trim().min(1),
            pullRequestNumber: z.coerce.number().int().positive(),
            ref: z.string().trim().min(1),
            repositoryFullName: z.string().trim().min(1).default(defaultRepositoryFullName),
          }),
        )
        .meta({
          description:
            "Dispatch the manual Depot CI preview trial workflow for a PR without enabling duplicate automatic deploys",
        })
        .handler(async ({ input, signal }) => {
          const result = await runDepotCli({
            args: [
              "ci",
              "dispatch",
              "--org",
              input.orgId,
              "--repo",
              input.repositoryFullName,
              "--workflow",
              previewTrialWorkflow,
              "--ref",
              input.ref,
              "--input",
              `pull_request_number=${input.pullRequestNumber}`,
              "--input",
              `pull_request_head_sha=${input.headSha}`,
              "--input",
              `pull_request_head_ref_name=${input.headRefName}`,
              "--input",
              `pull_request_base_sha=${input.baseSha}`,
              "--input",
              `repository_full_name=${input.repositoryFullName}`,
              "--output",
              "json",
            ],
            signal,
          });

          return JSON.parse(result.stdout) as unknown;
        }),
    }),
  }),
});
