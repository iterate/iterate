// THE FLAKE DASHBOARD'S WRITER: fold the `flake-records-<suite>` artifacts that CI jobs finished
// since the last run into the dashboard state, and rewrite issue #2580 from it. It replaces the
// legacy platform's flake-dashboard starter app, which pulled the same artifacts on GitHub check_run
// webhooks and went with #2837. `.depot/workflows/flake-dashboard.yml` runs it on a schedule.
//
//   pnpm tsx scripts/ci/flake-dashboard/update.ts --dry-run
//
// The fold's state travels between runs as the writer job's own Depot artifact
// (`flake-dashboard-state`): each run reads the newest one, folds what is new, and writes the next
// one to --state-out for the workflow to upload. Without a previous state it starts over from the
// workflows Depot still lists. --dry-run writes neither the issue nor state (it prints the body to
// --body-out); locally it uses `gh`'s token and the Depot CLI's login.
//
// The issue is written as the iterate GitHub App, as it was before #2837: with GITHUB_APP_ID and
// GITHUB_APP_PRIVATE_KEY set, the writer mints an installation token that can only write issues in
// this repository. The Depot app's job token has no Issues permission.
import { execFile as execFileCallback } from "node:child_process";
import { createSign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Octokit } from "@octokit/rest";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { z } from "zod";
import { DEPOT_ORG, mapConcurrent } from "../depot.ts";
import { createOctokit } from "../github.ts";
import { FlakeDashboardState } from "./contract.ts";
import {
  ARTIFACT_PREFIX,
  DASHBOARD_MARKER,
  foldFlakeRuns,
  renderBody,
  runRecordedFromArtifact,
  startFlakeDashboard,
  unzip,
} from "./fold.ts";

const execFile = promisify(execFileCallback);
/**
 * The workflows whose jobs upload `flake-records-<suite>`, by their `name:` (Depot lists by it).
 * scripts/ci/depot-workflows.test.ts fails when a workflow uploads flake records without being
 * listed here. Main is whatever a suite summary names as its branch, so a workflow that runs the
 * suites on main pushes needs only to be listed.
 */
export const SUITE_WORKFLOWS = ["Test", "Preview OS", "Main OS e2e"];
const STATE_ARTIFACT = "flake-dashboard-state";
/** Depot lists at most 200 workflows per query; the schedule runs far more often than that fills. */
const WORKFLOW_LIMIT = "200";
/** How long the writer remembers a workflow after Depot last listed it. */
const REMEMBER_MS = 3 * 24 * 60 * 60 * 1000;

/** What one writer run hands the next. */
export const WriterState = z.object({
  schemaVersion: z.literal(1),
  state: FlakeDashboardState,
  /** The fold's next event offset: the legacy `/flakes` stream offsets, continued. */
  nextOffset: z.number().int().nonnegative(),
  /**
   * Workflow id → the status and job counts its artifacts were listed at, the artifacts already
   * folded, and when Depot last listed it. A workflow's artifacts are listed again only when its
   * signature changes (a retried job uploads under a new attempt), and an artifact folds once.
   * An entry is forgotten only after Depot has stopped listing the workflow for REMEMBER_MS, so a
   * workflow still in the listing can never fold twice.
   */
  workflows: z.record(
    z.string(),
    z.object({ signature: z.string(), folded: z.array(z.string()), seenAt: z.iso.datetime() }),
  ),
});
export type WriterState = z.infer<typeof WriterState>;

/** The listed workflows whose artifacts are new: never seen, or changed since. */
export function workflowsToList(
  writer: Pick<WriterState, "workflows">,
  workflows: DepotWorkflow[],
) {
  return workflows.filter(
    (workflow) => writer.workflows[workflow.workflow_id]?.signature !== signature(workflow),
  );
}

/** The flake-records artifacts of those workflows that have not been folded. */
export function artifactsToFold(
  writer: Pick<WriterState, "workflows">,
  workflows: DepotWorkflow[],
  artifacts: DepotArtifact[],
) {
  const listing = new Set(workflows.map((workflow) => workflow.workflow_id));
  return (
    artifacts
      .filter(
        (artifact) =>
          listing.has(artifact.workflow_id) &&
          artifact.name.startsWith(ARTIFACT_PREFIX) &&
          !writer.workflows[artifact.workflow_id]?.folded.includes(artifact.artifact_id),
      )
      // Fold in the order the jobs finished, as the legacy app appended them.
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
  );
}

/**
 * The writer's memory after a pass: every workflow in this listing seen now, with the artifacts it
 * folded; a workflow Depot stopped listing more than REMEMBER_MS ago forgotten.
 */
export function rememberPass(
  writer: Pick<WriterState, "workflows">,
  pass: { workflows: DepotWorkflow[]; folded: DepotArtifact[]; now: Date },
): WriterState["workflows"] {
  const cutoff = pass.now.getTime() - REMEMBER_MS;
  const next = Object.fromEntries(
    Object.entries(writer.workflows).filter(([, entry]) => Date.parse(entry.seenAt) >= cutoff),
  );
  for (const workflow of pass.workflows) {
    next[workflow.workflow_id] = {
      signature: signature(workflow),
      folded: [
        ...(writer.workflows[workflow.workflow_id]?.folded || []),
        ...pass.folded
          .filter((artifact) => artifact.workflow_id === workflow.workflow_id)
          .map((artifact) => artifact.artifact_id),
      ],
      seenAt: pass.now.toISOString(),
    };
  }
  return next;
}

export type DepotWorkflow = {
  workflow_id: string;
  name: string;
  status: string;
  run_id: string;
  head_sha: string;
  created_at: string;
  job_counts?: Record<string, number>;
};

export type DepotArtifact = {
  artifact_id: string;
  run_id: string;
  workflow_id: string;
  name: string;
  attempt?: number;
  size_bytes?: number;
  created_at: string;
};

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const stateOut = flagValue("--state-out");
  const bodyOut = flagValue("--body-out");
  const repository = process.env.GITHUB_REPOSITORY || "iterate/iterate";
  const [owner, repo] = repository.split("/") as [string, string];
  const app =
    process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY
      ? await iterateAppIssuesToken({
          appId: process.env.GITHUB_APP_ID,
          privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
          owner,
          repo,
        })
      : undefined;
  if (app)
    console.log(
      `[flake-dashboard] iterate app token for ${app.repositories.join(", ")}: ${JSON.stringify(app.permissions)}`,
    );
  else if (!dryRun)
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required to write the dashboard");
  const github = createOctokit(app?.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN);

  const previous = await readPreviousState();
  const now = new Date();
  const writer = previous || {
    schemaVersion: 1 as const,
    ...startFlakeDashboard({ owner, repo }),
    workflows: {},
  };
  console.log(
    previous
      ? `[flake-dashboard] continuing from offset ${previous.nextOffset}`
      : "[flake-dashboard] no previous state: folding every listed workflow's records",
  );

  const workflows = (
    await Promise.all(
      SUITE_WORKFLOWS.map((name) =>
        depotJson<DepotWorkflow[]>([
          "ci",
          "workflow",
          "list",
          "--repo",
          repository,
          "--name",
          name,
          "--status",
          "finished",
          "--status",
          "failed",
          "-n",
          WORKFLOW_LIMIT,
        ]),
      ),
    )
  ).flat();
  const unlisted = workflowsToList(writer, workflows);
  const runIds = [...new Set(unlisted.map((workflow) => workflow.run_id))];
  const artifacts = artifactsToFold(
    writer,
    unlisted,
    (
      await mapConcurrent(
        runIds,
        8,
        async (runId) =>
          (await depotJson<{ artifacts: DepotArtifact[] }>(["ci", "artifacts", "list", runId]))
            .artifacts,
      )
    ).flat(),
  );
  const headSha = new Map(workflows.map((workflow) => [workflow.workflow_id, workflow.head_sha]));

  const downloads = await mkdtemp(join(tmpdir(), "flake-dashboard-"));
  try {
    const runs = await mapConcurrent(artifacts, 8, async (artifact) => {
      if (Number(artifact.size_bytes || 0) > MAX_ARTIFACT_BYTES) {
        console.warn(`[flake-dashboard] skipping oversized artifact ${artifact.name}`);
        return undefined;
      }
      const file = join(downloads, `${artifact.artifact_id}.zip`);
      await depot(["ci", "artifacts", "download", artifact.artifact_id, "--output-file", file]);
      return runRecordedFromArtifact({
        zip: new Uint8Array(await readFile(file)),
        runId: `${artifact.run_id}-${artifact.attempt || 1}`,
        suite: artifact.name.slice(ARTIFACT_PREFIX.length),
        branch: "unknown",
        commit: headSha.get(artifact.workflow_id) || "unknown",
      });
    });
    const folded = foldFlakeRuns(
      { state: writer.state, nextOffset: writer.nextOffset },
      runs.flatMap((run) => (run ? [run] : [])),
    );
    const next: WriterState = {
      schemaVersion: 1,
      ...folded,
      workflows: rememberPass(writer, { workflows, folded: artifacts, now }),
    };
    console.log(
      `[flake-dashboard] listed ${unlisted.length} new workflow(s), folded ${artifacts.length} artifact(s) into offsets ${writer.nextOffset}–${next.nextOffset - 1}`,
    );

    // The fold is kept before the issue is written: a failed write must not lose it, or the next
    // run would start over.
    if (stateOut && !dryRun) await writeOut(stateOut, JSON.stringify(next));
    const body = renderBody(next.state);
    if (bodyOut) await writeOut(bodyOut, `${body}\n`);
    const issue = await findDashboardIssue(github, { owner, repo });
    if (issue && issue.body === body) console.log(`[flake-dashboard] #${issue.number} is current`);
    else if (dryRun)
      console.log(
        `[flake-dashboard] dry run: would ${issue ? `rewrite #${issue.number}` : "open the dashboard issue"}`,
      );
    else if (issue) {
      await github.rest.issues.update({ owner, repo, issue_number: issue.number, body });
      console.log(`[flake-dashboard] rewrote ${issue.html_url}`);
    } else {
      const created = await github.rest.issues.create({
        owner,
        repo,
        title: "Flake dashboard",
        body,
      });
      console.log(`[flake-dashboard] opened ${created.data.html_url}`);
    }
  } finally {
    await rm(downloads, { recursive: true, force: true });
  }
}

/**
 * The newest writer run's state artifact, if Depot still has one. A run whose issue write failed
 * still kept its fold, so failed runs count too.
 */
async function readPreviousState(): Promise<WriterState | undefined> {
  const repository = process.env.GITHUB_REPOSITORY || "iterate/iterate";
  const runs = await depotJson<DepotWorkflow[]>([
    "ci",
    "workflow",
    "list",
    "--repo",
    repository,
    "--name",
    "Flake dashboard",
    "--status",
    "finished",
    "--status",
    "failed",
    "-n",
    "20",
  ]);
  for (const run of runs.sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const { artifacts } = await depotJson<{ artifacts: DepotArtifact[] }>([
      "ci",
      "artifacts",
      "list",
      run.run_id,
    ]);
    const artifact = artifacts.find(
      (candidate) => candidate.workflow_id === run.workflow_id && candidate.name === STATE_ARTIFACT,
    );
    if (!artifact) continue;
    const directory = await mkdtemp(join(tmpdir(), "flake-dashboard-state-"));
    try {
      const file = join(directory, "state.zip");
      await depot(["ci", "artifacts", "download", artifact.artifact_id, "--output-file", file]);
      const { "state.json": state } = await unzip(new Uint8Array(await readFile(file)));
      if (!state) throw new Error(`${STATE_ARTIFACT} ${artifact.artifact_id} holds no state.json`);
      return WriterState.parse(JSON.parse(new TextDecoder().decode(state)));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return undefined;
}

/**
 * An installation token of the iterate GitHub App, the app that wrote #2580 before #2837, narrowed to
 * writing issues in this one repository.
 */
export async function iterateAppIssuesToken(input: {
  appId: string;
  privateKey: string;
  owner: string;
  repo: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  // GitHub App JWT: RS256, issued a minute back for clock drift, valid for less than ten minutes.
  const unsigned = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({
    iat: now - 60,
    exp: now + 540,
    iss: input.appId,
  })}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(input.privateKey.replaceAll("\\n", "\n"), "base64url");
  const github = async (path: string, body?: object) => {
    const response = await fetch(`https://api.github.com${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${unsigned}.${signature}`,
        "x-github-api-version": "2022-11-28",
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitHub ${path} returned HTTP ${response.status}`);
    return response.json();
  };
  const installation = z
    .object({ id: z.number() })
    .parse(await github(`/repos/${input.owner}/${input.repo}/installation`));
  const access = z
    .object({
      token: z.string().min(1),
      permissions: z.record(z.string(), z.string()),
      repositories: z.array(z.object({ name: z.string() })),
    })
    .parse(
      await github(`/app/installations/${installation.id}/access_tokens`, {
        repositories: [input.repo],
        permissions: { issues: "write" },
      }),
    );
  return {
    token: access.token,
    permissions: access.permissions,
    repositories: access.repositories.map(({ name }) => name),
  };
}

/** The open issue that carries the dashboard marker (the legacy app's authority, not the title). */
async function findDashboardIssue(github: Octokit, repository: { owner: string; repo: string }) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repository,
    state: "open",
    per_page: 100,
  });
  return issues.find((issue) => !issue.pull_request && issue.body?.startsWith(DASHBOARD_MARKER));
}

function signature(workflow: DepotWorkflow) {
  return `${workflow.status}:${JSON.stringify(workflow.job_counts || {})}`;
}

async function depot(args: string[]) {
  // CI passes the organization token as DEPOT_TOKEN; a laptop uses the CLI's own login.
  return execFile("depot", [...args, "--org", DEPOT_ORG], { maxBuffer: 50 * 1024 * 1024 });
}

async function depotJson<T>(args: string[]): Promise<T> {
  const { stdout } = await depot([...args, "--output", "json"]);
  return JSON.parse(stdout) as T;
}

async function writeOut(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function flagValue(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path`);
  return value;
}

if (isMainModule(import.meta.url)) await main();
