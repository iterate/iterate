// iterate-lint-disable terminology/no-metaphorical-lane-door-seam -- `suite` values arrive in artifact names derived from TEST_TELEMETRY_LANE; see tasks/rename-lane-vocabulary.md
import { strFromU8, unzipSync } from "fflate";
import { isIdempotencyConflict } from "../../processors/index.ts";
import type { Project, StreamEvent } from "../../sdk.ts";
import { flakeDashboardCreationEvents, flakesStreamPath } from "./app-ref.ts";
import { FlakeRecord } from "./contract.ts";

const ARTIFACT_PREFIX = "flake-records-";
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

/**
 * The cheap gate, callable on every delivered event without opening itx:
 * returns the webhook's useful coordinates only for a completed workflow_run
 * delivered on a GitHub connection stream, else null.
 */
export function parseWorkflowRunWebhook(event: StreamEvent) {
  if (event.type !== "events.iterate.com/github/webhook-received") return null;
  const connection = /^\/integrations\/github\/([^/]+)$/.exec(event.path || "")?.[1];
  if (connection === undefined) return null;
  // The webhook payload is GitHub's own delivery, platform-verified but not
  // schema-validated here — every field access below stays defensive.
  const webhook = event.payload as any;
  if (webhook?.delivery?.name !== "workflow_run") return null;
  const body = webhook.body;
  if (body?.action !== "completed") return null;
  const run = body.workflow_run;
  const repository = body.repository;
  if (!run?.id || !repository?.name || !repository?.owner?.login) return null;
  return { connection, run, repository };
}

/**
 * The pull lane for flake telemetry: when a workflow run completes, fetch its
 * `flake-records-<suite>` artifacts with the App's own installation token,
 * parse the recorder lines, and append one run-recorded event per artifact to
 * /flakes. CI holds no iterate credential — its only signal is the artifact
 * upload, and the webhook + App token are both platform-held.
 *
 * Redeliveries are harmless: the append is idempotency-keyed on
 * run+attempt+suite, and a same-key conflict means the run is already
 * ingested.
 */
export async function ingestWorkflowRunFlakeArtifacts(
  itx: Project,
  webhook: NonNullable<ReturnType<typeof parseWorkflowRunWebhook>>,
): Promise<void> {
  const { connection, run, repository } = webhook;
  const params = { owner: repository.owner.login as string, repo: repository.name as string };
  const octokit = itx.integrations.github.get(connection).octokit;
  const artifacts = await octokit.paginate(
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
    { ...params, run_id: run.id, per_page: 100 },
  );
  const flakeArtifacts = artifacts.filter((artifact) => artifact.name.startsWith(ARTIFACT_PREFIX));
  if (flakeArtifacts.length === 0) return;

  const stream = itx.streams.get(flakesStreamPath);
  // Idempotency-keyed birth: whoever ingests first births the dashboard,
  // pinned to the repository the records came from.
  await stream.append(
    ...flakeDashboardCreationEvents({
      repository: params,
      issueTitle: "Flake dashboard",
      defaultBranch: repository.default_branch || "main",
    }),
  );

  for (const artifact of flakeArtifacts) {
    if (artifact.size_in_bytes > MAX_ARTIFACT_BYTES) {
      console.warn(
        `[flake-ingest] skipping oversized artifact ${artifact.name} (${artifact.size_in_bytes} bytes)`,
      );
      continue;
    }
    const suite = artifact.name.slice(ARTIFACT_PREFIX.length);
    const download = await octokit.rest.actions.downloadArtifact({
      ...params,
      artifact_id: artifact.id,
      archive_format: "zip",
    });
    const files = unzipSync(new Uint8Array(download.data as ArrayBuffer));
    const records = Object.entries(files)
      .filter(([name]) => name.endsWith(".jsonl"))
      .flatMap(([name, bytes]) =>
        strFromU8(bytes)
          .split("\n")
          .filter((line) => line.trim() !== "")
          .flatMap((line) => {
            // A torn line from a crashed test worker skips, never aborts.
            let json: unknown;
            try {
              json = JSON.parse(line);
            } catch {
              console.warn(`[flake-ingest] skipping malformed line in ${artifact.name}/${name}`);
              return [];
            }
            const parsed = FlakeRecord.safeParse(json);
            if (!parsed.success) {
              console.warn(`[flake-ingest] skipping malformed line in ${artifact.name}/${name}`);
              return [];
            }
            return [parsed.data];
          }),
      );
    if (records.length === 0) continue;

    const runId = `${run.id}-${run.run_attempt || 1}`;
    try {
      await stream.append({
        type: "events.iterate.com/flakes/run-recorded",
        idempotencyKey: `flakes/run:${runId}:${suite}`,
        payload: {
          runId,
          suite,
          branch: run.head_branch || "unknown",
          commit: run.head_sha || "unknown",
          records,
        },
      });
    } catch (error) {
      // Same key, different body: the run+attempt+suite is already ingested
      // (a webhook redelivery racing a slow first attempt) — the first
      // committed fact wins.
      if (!isIdempotencyConflict(error)) throw error;
    }
    console.log(
      `[flake-ingest] ingested ${records.length} records from ${artifact.name} (run ${runId})`,
    );
  }
}
